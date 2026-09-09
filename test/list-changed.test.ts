import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { Server } from "@modelcontextprotocol/server";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogPublisher, createGatewayMcpServer, McpBackendClient, startGatewayHttp, ToolRouter,
} from "../src/index.js";
import type { BackendCatalogInput, GatewayHttpOptions, GatewayMcpServer, ToolRouterOptions } from "../src/index.js";

const TOKEN = "list-changed-test-token-abcdefghijklmnopqrstuvwxyz";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pause = (ms = 100) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backend = (type = "x64dbg", description = "status"): BackendCatalogInput => ({
  backendId: type, backendType: type, readOnlyTools: new Set(["status"]), mutationTools: new Set(),
  tools: [{ name: "status", description, inputSchema: { type: "object", properties: { detail: { type: "boolean" } } } }],
});

async function fixture(overrides: Partial<GatewayHttpOptions> = {}, routerOptions: Partial<ToolRouterOptions> = {}) {
  const publisher = new CatalogPublisher();
  const protocols: GatewayMcpServer[] = [];
  const router = new ToolRouter({
    clients: new Map(), validator: { validate: () => ({ valid: true }) },
    management: { call: async () => ({ ok: true, result: { content: [] } }) },
    traceIds: { next: () => "list-changed-test" },
    ...routerOptions,
  });
  const http = await startGatewayHttp({
    host: "127.0.0.1", port: 0, path: "/mcp", bearerToken: TOKEN,
    createMcpServer: () => {
      const protocol = createGatewayMcpServer(publisher, router);
      protocols.push(protocol);
      return protocol;
    }, ...overrides,
  });
  cleanup.push(() => http.close());
  async function connect(sse = true) {
    const client = new Client({ name: "notification-test", version: "1" });
    let notifications = 0;
    let streams = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => { notifications++; });
    const transport = new StreamableHTTPClientTransport(http.url, {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      fetch: async (url, init) => {
        if (init?.method === "GET") {
          if (!sse) return new Response(null, { status: 405 });
          const response = await fetch(url, init);
          if (response.status === 200) streams++;
          return response;
        }
        return fetch(url, init);
      },
    });
    cleanup.push(() => client.close());
    await client.connect(transport);
    if (sse) await vi.waitFor(() => expect(streams).toBe(1));
    return { client, transport, get notifications() { return notifications; } };
  }
  return { http, publisher, protocols, router, connect };
}

function blockedWork() {
  const releases: Array<() => void> = [];
  let started = 0;
  let settled = 0;
  let blocking = true;
  return {
    get started() { return started; },
    get settled() { return settled; },
    finish: () => { blocking = false; for (const release of releases.splice(0)) release(); },
    call: async () => {
      started++;
      if (blocking) await new Promise<void>((resolve) => { releases.push(resolve); });
      settled++;
      return { content: [] };
    },
  };
}

async function postCall(url: URL, sessionId: string, id: number, name: string, signal: AbortSignal) {
  const response = await fetch(url, {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": sessionId,
      accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }),
  });
  return response.text();
}

describe("stateful authenticated tools/list_changed over real HTTP SSE", () => {
  it.each(["backend", "management"] as const)("retains %s execution reservations after eight POST disconnects with fresh request IDs", async (kind) => {
    const work = blockedWork();
    const f = await fixture({}, {
      clients: new Map([["x64dbg", { callTool: work.call }]]),
      management: { call: async () => ({ ok: true, result: await work.call() }) },
    });
    f.publisher.publish([backend()]);
    const c = await f.connect();
    cleanup.push(async () => work.finish());
    const name = kind === "backend" ? "x64dbg.status" : "gateway.status";
    const abort = new AbortController();
    cleanup.push(async () => abort.abort());
    const pending = Array.from({ length: 8 }, (_, n) =>
      postCall(f.http.url, c.transport.sessionId!, 100 + n, name, abort.signal).catch(() => "disconnected"));
    await vi.waitFor(() => expect(work.started).toBe(8));
    abort.abort();
    await Promise.all(pending);
    await pause(); // Let the server observe all response closes.
    expect(work.settled).toBe(0);
    expect((await c.client.listTools()).tools).toHaveLength(6); // Transport remains usable.
    const rejected = await Promise.all(Array.from({ length: 8 }, (_, n) =>
      postCall(f.http.url, c.transport.sessionId!, 200 + n, name, AbortSignal.timeout(1500))));
    for (const text of rejected) {
      expect(text).toContain('"code":"EXECUTION_CAPACITY"');
      expect(text).toContain('"dispatchStarted":false');
      expect(text).toContain('"safeToRetry":false');
    }
    expect(work.started).toBe(8);
    expect(work.settled).toBe(0);
    work.finish();
    await vi.waitFor(() => expect(work.settled).toBe(8));
    expect((await c.client.callTool({ name, arguments: {} })).isError).toBeFalsy();
    expect(work.started).toBe(9);
  });

  it("keeps the shared 32-execution bound across DELETE/reinitialize while detached backend calls remain outstanding", async () => {
    const work = blockedWork();
    const f = await fixture({ maxSessions: 1 }, { clients: new Map([["x64dbg", { callTool: work.call }]]) });
    f.publisher.publish([backend()]);
    cleanup.push(async () => work.finish());
    for (let generation = 0; generation < 4; generation++) {
      const c = await f.connect();
      const abort = new AbortController();
      cleanup.push(async () => abort.abort());
      const pending = Array.from({ length: 8 }, (_, n) =>
        postCall(f.http.url, c.transport.sessionId!, 100 + n, "x64dbg.status", abort.signal).catch(() => "disconnected"));
      await vi.waitFor(() => expect(work.started).toBe((generation + 1) * 8));
      // DELETE must free the session/streams but not the shared execution slots.
      await c.transport.terminateSession();
      abort.abort();
      await Promise.all(pending);
      await c.client.close();
      await vi.waitFor(() => expect(f.http.sessionCount).toBe(0));
      expect(work.settled).toBe(0);
    }
    const fresh = await f.connect();
    expect((await fresh.client.listTools()).tools).toHaveLength(6);
    const rejected = await postCall(f.http.url, fresh.transport.sessionId!, 900, "x64dbg.status", AbortSignal.timeout(1500));
    expect(rejected).toContain('"code":"EXECUTION_CAPACITY"');
    expect(rejected).toContain('"dispatchStarted":false');
    expect(work.started).toBe(32);
    expect(work.settled).toBe(0);
    work.finish();
    await vi.waitFor(() => expect(work.settled).toBe(32));
    expect((await fresh.client.callTool({ name: "x64dbg.status", arguments: {} })).isError).toBeFalsy();
    expect(work.started).toBe(33);
  });

  it("releases shared and session execution slots on handler rejection without poisoning the next call", async () => {
    let fail = true;
    let calls = 0;
    const f = await fixture({}, {
      maxConcurrentCalls: 1,
      management: { call: async () => {
        calls++;
        if (fail) throw new Error("fixture handler failure");
        return { ok: true, result: { content: [] } };
      } },
    });
    const c = await f.connect();
    const first = await postCall(f.http.url, c.transport.sessionId!, 100, "gateway.status", AbortSignal.timeout(1500));
    expect(first).toContain('"error"');
    fail = false;
    expect((await c.client.callTool({ name: "gateway.status", arguments: {} })).isError).toBeFalsy();
    expect(calls).toBe(2);
  });

  it("discovers a real fake backend start/schema change/stop in the same SDK session", async () => {
    const f = await fixture();
    const c = await f.connect();
    const sessionId = c.transport.sessionId;
    expect(c.client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect((await c.client.listTools()).tools).toHaveLength(5);

    let tools = backend().tools;
    const downstream = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.writeHead(401).end(); return; }
      const protocol = new Server({ name: "read-only-fake-debugger", version: "1" }, { capabilities: { tools: {} } });
      protocol.setRequestHandler("tools/list", async () => ({ tools: structuredClone(tools) as never }));
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.once("close", () => { void protocol.close(); });
      await protocol.connect(transport);
      await transport.handleRequest(request, response);
    });
    await new Promise<void>((resolve) => downstream.listen(0, "127.0.0.1", resolve));
    cleanup.push(async () => {
      await new Promise<void>((resolve) => { downstream.close(() => resolve()); downstream.closeAllConnections(); });
    });
    const downstreamClient = await McpBackendClient.connect({
      backendId: "x64dbg", bearerToken: TOKEN,
      url: new URL(`http://127.0.0.1:${(downstream.address() as AddressInfo).port}/mcp`),
    });
    cleanup.push(() => downstreamClient.close());
    const discover = async () => f.publisher.publish([{ ...backend(), tools: await downstreamClient.listTools() }]);
    await discover();
    await vi.waitFor(() => expect(c.notifications).toBe(1));
    expect((await c.client.listTools()).tools.find((t) => t.name === "x64dbg.status")?.inputSchema).toEqual(tools[0]?.inputSchema);
    tools = [{ name: "status", inputSchema: { type: "object", required: ["generation"], properties: { generation: { type: "integer" } } } }];
    await discover();
    await vi.waitFor(() => expect(c.notifications).toBe(2));
    expect((await c.client.listTools()).tools.find((t) => t.name === "x64dbg.status")?.inputSchema).toEqual(tools[0]?.inputSchema);
    await downstreamClient.close();
    await new Promise<void>((resolve) => { downstream.close(() => resolve()); downstream.closeAllConnections(); });
    f.publisher.publish([]);
    await vi.waitFor(() => expect(c.notifications).toBe(3));
    expect((await c.client.listTools()).tools).toHaveLength(5);
    expect(c.transport.sessionId).toBe(sessionId);
  });

  it("isolates simultaneous client protocols and authenticates every method before session lookup", async () => {
    const f = await fixture();
    const a = await f.connect();
    const b = await f.connect();
    expect(a.transport.sessionId).not.toBe(b.transport.sessionId);
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const auth of [undefined, "Bearer incorrect-token"]) {
        const response = await fetch(f.http.url, {
          method, headers: { "mcp-session-id": a.transport.sessionId!, accept: "text/event-stream, application/json",
            ...(auth ? { Authorization: auth } : {}) },
        });
        expect(response.status).toBe(401);
      }
    }
    expect(f.http.sessionCount).toBe(2);
    f.publisher.publish([backend("x32dbg"), backend()]);
    await vi.waitFor(() => { expect(a.notifications).toBe(1); expect(b.notifications).toBe(1); });
    const lists = await Promise.all([a.client.listTools(), b.client.listTools()]);
    expect(lists[0]).toEqual(lists[1]);
    await a.transport.terminateSession();
    await a.client.close();
    await vi.waitFor(() => expect(f.http.sessionCount).toBe(1));
    f.publisher.publish([]);
    await vi.waitFor(() => expect(b.notifications).toBe(2));
    expect(a.notifications).toBe(1);
    expect((await b.client.listTools()).tools).toHaveLength(5);
  });

  it("coalesces bursts and does not notify on unchanged discovery polls", async () => {
    const f = await fixture();
    const c = await f.connect();
    await c.client.listTools();
    f.publisher.publish([backend()]);
    f.publisher.publish([backend(), backend("x32dbg")]);
    f.publisher.publish([backend("x32dbg")]);
    await vi.waitFor(() => expect(c.notifications).toBe(1));
    await c.client.listTools();
    for (let n = 0; n < 10; n++) f.publisher.publish([backend("x32dbg")]);
    await pause();
    expect(c.notifications).toBe(1);
  });

  it("reconciles a change between tools/list and the first SSE subscription", async () => {
    const f = await fixture();
    const c = await f.connect(false);
    await c.client.listTools();
    f.publisher.publish([backend()]);
    await pause();
    expect(c.notifications).toBe(0);
    const abort = new AbortController();
    cleanup.push(async () => abort.abort());
    const response = await fetch(f.http.url, {
      signal: abort.signal,
      headers: { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": c.transport.sessionId!, accept: "text/event-stream" },
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("notifications/tools/list_changed");
    await reader.cancel();
    expect((await c.client.listTools()).tools).toHaveLength(6);
  });

  it("bounds sessions, reclaims DELETE and abandoned/idle sessions, and rejects unknown IDs", async () => {
    const f = await fixture({ maxSessions: 1, sessionIdleMs: 300 });
    const a = await f.connect();
    const overflow = await fetch(f.http.url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(overflow.status).toBe(503);
    await a.transport.terminateSession();
    await a.client.close();
    await vi.waitFor(() => expect(f.http.sessionCount).toBe(0));
    const b = await f.connect();
    await b.client.close(); // close is local; abandoned session expires without DELETE.
    await vi.waitFor(() => expect(f.http.sessionCount).toBe(0), { timeout: 1500 });
    const stale = await fetch(f.http.url, { headers: { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": b.transport.sessionId! } });
    expect(stale.status).toBe(404);
    const invalid = await fetch(f.http.url, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(invalid.status).toBe(400);
    await vi.waitFor(() => expect(f.http.sessionCount).toBe(0));
  });

  it("reconciles changes during an SSE gap, rejects a duplicate stream, and cleans up shutdown", async () => {
    const f = await fixture();
    const c = await f.connect(false);
    await c.client.listTools();
    const headers = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": c.transport.sessionId!, accept: "text/event-stream" };
    const first = await fetch(f.http.url, { headers });
    const duplicate = await fetch(f.http.url, { headers });
    expect(duplicate.status).toBe(409);
    await first.body!.cancel();
    await pause();
    f.publisher.publish([backend("x32dbg")]);
    const second = await fetch(f.http.url, { headers });
    const reader = second.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("notifications/tools/list_changed");
    await c.client.listTools();
    await f.http.close();
    expect(f.http.sessionCount).toBe(0);
    const send = vi.spyOn(f.protocols[0]!, "sendToolListChanged");
    f.publisher.publish([]);
    await pause();
    expect(send).not.toHaveBeenCalled();
    await reader.cancel().catch(() => {});
  });

  it("bounds POST concurrency and body size without dispatching rejected requests", async () => {
    const f = await fixture();
    const c = await f.connect();
    const headers = { Authorization: `Bearer ${TOKEN}`, "mcp-session-id": c.transport.sessionId!,
      accept: "application/json, text/event-stream", "content-type": "application/json" };
    const oversized = await fetch(f.http.url, { method: "POST", headers, body: " ".repeat(1024 * 1024 + 1) });
    expect(oversized.status).toBe(413);
    const batch = await fetch(f.http.url, { method: "POST", headers, body: "[]" });
    expect(batch.status).toBe(400);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const call = vi.spyOn(f.router, "call").mockImplementation(async () => {
      await wait;
      return { ok: true, result: { content: [] } };
    });
    cleanup.push(async () => release());
    const post = (id: number) => fetch(f.http.url, { method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "gateway.status" } }),
    }).then(async (response) => ({ status: response.status, text: await response.text() }));
    const active = Array.from({ length: 8 }, (_, n) => post(100 + n));
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(8));
    expect((await post(200)).status).toBe(429);
    expect(call).toHaveBeenCalledTimes(8);
    release();
    expect((await Promise.all(active)).every((r) => r.status === 200)).toBe(true);
    expect((await c.client.listTools()).tools).toHaveLength(5);
  });

  it("contains subscriber/send failures and releases their sessions", async () => {
    const f = await fixture();
    const a = await f.connect();
    const b = await f.connect();
    const unsubscribe = f.publisher.subscribe(() => { throw new Error("broken subscriber"); });
    vi.spyOn(f.protocols[0]!, "sendToolListChanged").mockRejectedValueOnce(new Error("disconnected"));
    expect(() => f.publisher.publish([backend()])).not.toThrow();
    await vi.waitFor(() => { expect(f.http.sessionCount).toBe(1); expect(b.notifications).toBe(1); });
    unsubscribe();
    await a.client.close();
    expect((await b.client.listTools()).tools).toHaveLength(6);
  });
});
