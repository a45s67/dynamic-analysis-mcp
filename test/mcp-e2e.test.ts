import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCatalog,
  createGatewayMcpServer,
  McpBackendClient,
  startGatewayHttp,
  ToolRouter,
} from "../src/index.js";
import type {
  ArgumentValidator,
  BackendClient,
  GatewayCallResult,
  ManagementToolHandler,
  RunningGatewayHttpServer,
  TraceIdSource,
} from "../src/index.js";

const TOKEN = "gateway-test-token-32-characters-long";
const running: RunningGatewayHttpServer[] = [];
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (server) => server.close()));
  await Promise.all(cleanup.splice(0).map(async (close) => close()));
});

async function startFakeMcpBackend(
  token: string,
  calls: unknown[],
): Promise<{ readonly url: URL; close(): Promise<void> }> {
  const protocol = new Server(
    { name: "fake-ce-mcp-backend", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  protocol.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "ce.status",
        description: "Fake CE status",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: {
          type: "object",
          required: ["sessionId", "generation"],
          properties: {
            sessionId: { type: "string" },
            generation: { type: "integer" },
          },
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  }));
  protocol.setRequestHandler("tools/call", async (request) => {
    calls.push({ name: request.params.name, arguments: request.params.arguments });
    const structuredContent = { sessionId: "live-ce-session", generation: 11 };
    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
      isError: false,
    };
  });

  const http = createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "www-authenticate": "Bearer" }).end();
      return;
    }
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await protocol.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => resolve());
  });
  const address = http.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    close: async () => {
      await protocol.close();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

describe("authenticated MCP vertical slice", () => {
  it("federates an actual downstream MCP endpoint over HTTP", async () => {
    const backendCalls: unknown[] = [];
    const backendToken = "backend-test-token-32-characters-long";
    const fakeBackend = await startFakeMcpBackend(backendToken, backendCalls);
    const backendClient = await McpBackendClient.connect({
      backendId: "ce",
      url: fakeBackend.url,
      bearerToken: backendToken,
    });
    cleanup.push(async () => {
      await backendClient.close();
      await fakeBackend.close();
    });
    const tools = await backendClient.listTools();
    const snapshot = buildCatalog(
      [
        {
          backendId: "ce",
          backendType: "ce",
          tools,
          readOnlyTools: new Set(["ce.status"]),
          mutationTools: new Set(),
        },
      ],
      1,
    );
    const gatewayProtocol = createGatewayMcpServer(
      { current: () => snapshot },
      new ToolRouter({
        clients: new Map([["ce", backendClient]]),
        validator: { validate: () => ({ valid: true }) },
        management: {
          call: async (): Promise<GatewayCallResult> => ({
            ok: true,
            result: { content: [] },
          }),
        },
        traceIds: { next: () => "trace-double-http" },
      }),
    );
    const gateway = await startGatewayHttp({
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      bearerToken: TOKEN,
      mcpServer: gatewayProtocol,
    });
    running.push(gateway);

    const upstreamClient = new Client({ name: "upstream-e2e", version: "1.0.0" });
    await upstreamClient.connect(
      new StreamableHTTPClientTransport(gateway.url, {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    const listed = await upstreamClient.listTools();
    expect(listed.tools.find(({ name }) => name === "ce.ce.status")?.inputSchema).toEqual({
      type: "object",
      additionalProperties: false,
    });
    const result = await upstreamClient.callTool({ name: "ce.ce.status", arguments: {} });
    expect(result.structuredContent).toEqual({ sessionId: "live-ce-session", generation: 11 });
    expect(backendCalls).toEqual([{ name: "ce.status", arguments: {} }]);
    await upstreamClient.close();
  });

  it("lists and calls a namespaced CE tool through the official client", async () => {
    const downstreamCalls: unknown[] = [];
    const ceClient: BackendClient = {
      callTool: async (call) => {
        downstreamCalls.push(call);
        return {
          content: [{ type: "text", text: "attached" }],
          structuredContent: {
            sessionId: "ce-session-1",
            generation: 4,
            nextCursor: "cursor-2",
          },
        };
      },
    };
    const snapshot = buildCatalog(
      [
        {
          backendId: "ce",
          backendType: "ce",
          tools: [
            {
              name: "ce.process",
              description: "CE process lifecycle fixture",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false },
            },
          ],
          readOnlyTools: new Set(),
          mutationTools: new Set(["ce.process"]),
        },
      ],
      8,
    );
    const validator: ArgumentValidator = { validate: () => ({ valid: true }) };
    const management: ManagementToolHandler = {
      call: async (_route, _args, captured): Promise<GatewayCallResult> => ({
        ok: true,
        result: { content: [], structuredContent: { catalogGeneration: captured.generation } },
      }),
    };
    const traceIds: TraceIdSource = { next: () => "trace-e2e" };
    const router = new ToolRouter({
      clients: new Map([["ce", ceClient]]),
      validator,
      management,
      traceIds,
    });
    const protocol = createGatewayMcpServer({ current: () => snapshot }, router);
    const http = await startGatewayHttp({
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      bearerToken: TOKEN,
      mcpServer: protocol,
    });
    running.push(http);

    const client = new Client({ name: "gateway-e2e-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(http.url, {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "ce.ce.process",
      "gateway.backends",
      "gateway.refresh",
      "gateway.status",
    ]);

    const result = await client.callTool({
      name: "ce.ce.process",
      arguments: { action: "attach", pid: 1234, expectedGeneration: 3 },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      sessionId: "ce-session-1",
      generation: 4,
      nextCursor: "cursor-2",
    });
    expect(downstreamCalls).toEqual([
      {
        name: "ce.process",
        arguments: { action: "attach", pid: 1234, expectedGeneration: 3 },
      },
    ]);
    await client.close();
  });

  it("rejects an unauthenticated MCP request", async () => {
    const snapshot = buildCatalog([], 0);
    const protocol = createGatewayMcpServer(
      { current: () => snapshot },
      new ToolRouter({
        clients: new Map(),
        validator: { validate: () => ({ valid: true }) },
        management: {
          call: async (): Promise<GatewayCallResult> => ({
            ok: true,
            result: { content: [] },
          }),
        },
        traceIds: { next: () => "trace-auth" },
      }),
    );
    const http = await startGatewayHttp({
      host: "127.0.0.1",
      port: 0,
      path: "/mcp",
      bearerToken: TOKEN,
      mcpServer: protocol,
    });
    running.push(http);

    const response = await fetch(http.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ code: "UNAUTHENTICATED" });
  });
});
