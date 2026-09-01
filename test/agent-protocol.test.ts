import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { callUserAgent, GatewayRuntime, startConfiguredUserAgent, startUserAgent } from "../src/index.js";
import type { ResolvedGatewayConfig } from "../src/index.js";

const TOKEN = "agent-token-abcdefghijklmnopqrstuvwxyz-0123456789";

describe("service-to-user-agent protocol", () => {
  it("fails closed when no interactive user agent is connected", async () => {
    const result = await callUserAgent({
      pipeName: `gateway-test-${randomUUID()}`,
      token: TOKEN,
      backend: "x64dbg",
      action: "start",
      force: false,
      timeoutMs: 250,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "USER_SESSION_UNAVAILABLE",
      dispatchStarted: false,
      outcomeUnknown: false,
    });
  });

  it("rejects a caller with the wrong IPC credential", async () => {
    const pipeName = `gateway-test-${randomUUID()}`;
    const agent = await startUserAgent({
      pipeName,
      token: TOKEN,
      controllers: {
        x32dbg: { command: process.execPath, args: [] },
        x64dbg: { command: process.execPath, args: [] },
      },
      timeoutMs: 1_000,
    });
    try {
      const result = await callUserAgent({
        pipeName,
        token: "wrong-token-abcdefghijklmnopqrstuvwxyz-0123456789",
        backend: "x32dbg",
        action: "status",
        force: false,
        timeoutMs: 1_000,
      });
      expect(result).toMatchObject({ ok: false, code: "PROCESS_FAILED" });
    } finally {
      await agent.close();
    }
  });

  it("round-trips one closed lifecycle request through the authenticated agent", async () => {
    const pipeName = `gateway-test-${randomUUID()}`;
    const observed: unknown[] = [];
    const agent = await startUserAgent({
      pipeName, token: TOKEN,
      controllers: {
        x32dbg: { command: "x32-controller", args: ["--fixed"] },
        x64dbg: { command: "x64-controller", args: ["--fixed"] },
      },
      timeoutMs: 1_000,
      execute: async (controller, action, force, timeoutMs) => {
        observed.push({ controller, action, force, timeoutMs });
        return { ok: true, value: { status: "ok", process_id: 42 } };
      },
    });
    try {
      const result = await callUserAgent({ pipeName, token: TOKEN, backend: "x64dbg",
        action: "start", force: false, timeoutMs: 1_000 });
      expect(result).toEqual({ ok: true, value: { status: "ok", process_id: 42 } });
      expect(observed).toEqual([{ controller: { command: "x64-controller", args: ["--fixed"] },
        action: "start", force: false, timeoutMs: 1_000 }]);
    } finally { await agent.close(); }
  });

  it("rejects short agent credentials before listening", async () => {
    await expect(
      startUserAgent({
        pipeName: `gateway-test-${randomUUID()}`,
        token: "short",
        controllers: {
          x32dbg: { command: process.execPath, args: [] },
          x64dbg: { command: process.execPath, args: [] },
        },
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow("agent token is invalid");
  });

  it("derives the installed controller from the configured debugger root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "gateway-agent-entry-"));
    const mcp = path.join(root, "release", "mcp");
    await mkdir(mcp, { recursive: true });
    await writeFile(path.join(mcp, "x96dbg-mcp-control.exe"), "fixture");
    const tokenFile = path.join(root, "agent.token");
    await writeFile(tokenFile, TOKEN);
    const agent = await startConfiguredUserAgent(["--pipe-name", `gateway-test-${randomUUID()}`,
      "--agent-token-file", tokenFile, "--x64dbg-root", root]);
    await agent.close();
    await rm(root, { recursive: true, force: true });
  });

  it("routes service lifecycle through the agent and exposes unavailable without dispatch", async () => {
    const pipeName = `gateway-test-${randomUUID()}`;
    const config: ResolvedGatewayConfig = {
      sourceFile: "fixture.toml",
      server: {
        bind: "127.0.0.1", port: 0, path: "/mcp",
        publicBaseUrl: "http://127.0.0.1:8000",
        bearerToken: "gateway-token-abcdefghijklmnopqrstuvwxyz-0123456789",
        tls: { mode: "local" },
      },
      backends: [{
        id: "x64dbg", type: "x64dbg", enabled: true,
        url: new URL("http://127.0.0.1:9/mcp"),
        bearerToken: "debugger-token-abcdefghijklmnopqrstuvwxyz-0123456789",
        readOnlyTools: new Set(), mutationTools: new Set(),
      }],
      interactiveAgent: { pipeName, token: TOKEN },
      discovery: { intervalMs: 5000, connectTimeoutMs: 100, listTimeoutMs: 100,
        stableSuccesses: 1, stableFailures: 1, jitterPercent: 0 },
      limits: { requestBodyBytes: 1048576, downstreamCatalogBytes: 1048576,
        downstreamToolCount: 500, downstreamToolDefinitionBytes: 65536,
        toolResultBytes: 1048576, globalConcurrentCalls: 4, perBackendConcurrentCalls: 1,
        defaultToolTimeoutMs: 1000, refreshCooldownMs: 100 },
      naming: { mode: "dotted" },
    };
    const runtime = new GatewayRuntime(config);
    const http = await runtime.start();
    const client = new Client({ name: "agent-routing-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(http.url, { requestInit: {
        headers: { Authorization: `Bearer ${config.server.bearerToken}` },
      } }));
      const result = await client.callTool({ name: "gateway.debugger_restart", arguments: {
        backendId: "x64dbg", expectedInstanceId: randomUUID(), operationId: randomUUID(),
      } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: {
        code: "USER_SESSION_UNAVAILABLE", dispatchStarted: false,
      } });
      const startResult = await client.callTool({ name: "gateway.backend_control", arguments: {
        backendId: "x64dbg", action: "start",
      } });
      expect(startResult.isError).toBe(true);
      expect(startResult.structuredContent).toMatchObject({ error: {
        code: "USER_SESSION_UNAVAILABLE", dispatchStarted: false,
      } });
    } finally {
      await client.close().catch(() => undefined);
      await runtime.close();
    }
  });
});
