import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { callUserAgent, GatewayRuntime, startConfiguredUserAgent, startUserAgent } from "../src/index.js";
import type { ResolvedGatewayConfig } from "../src/index.js";
import { runLifecycleProcess } from "../src/backend/lifecycle.js";

const TOKEN = "agent-token-abcdefghijklmnopqrstuvwxyz-0123456789";

describe("service-to-user-agent protocol", () => {
  it.each([1, 2, 3])("requires strict nested budgets with %s ms remaining", async (remainingMs) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const execute = vi.fn<NonNullable<Parameters<typeof startUserAgent>[0]["execute"]>>(async () => ({ ok: true, value: { status: "ok" } }));
    const agent = await startUserAgent({ pipeName: `gateway-test-${randomUUID()}`, token: TOKEN, timeoutMs: 1000,
      controllers: { x32dbg: { command: "fixture", args: [] }, x64dbg: { command: "fixture", args: [] } }, execute });
    const socket = net.createConnection(agent.path);
    try {
      const response = new Promise<Record<string, unknown>>((resolve, reject) => {
        let text = "";
        socket.on("error", reject);
        socket.on("data", (chunk) => { text += chunk.toString(); });
        socket.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
        socket.on("connect", () => socket.write(JSON.stringify({ version: 1, requestId: randomUUID(), token: TOKEN,
          backend: "x64dbg", action: "restart", force: false, timeoutMs: 1000, deadlineUnixMs: Date.now() + remainingMs }) + "\n"));
      });
      if (remainingMs < 3) {
        expect(await response).toMatchObject({ ok: false, code: "TIMEOUT", outcomeUnknown: false });
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(await response).toMatchObject({ ok: true });
        expect(execute).toHaveBeenCalledExactlyOnceWith(expect.anything(), "restart", false, 2);
      }
    } finally { socket.destroy(); await agent.close(); vi.useRealTimers(); }
  });

  it("closes an invalid raw peer without waiting for the peer's writable side", async () => {
    const execute = vi.fn();
    const agent = await startUserAgent({ pipeName: `gateway-test-${randomUUID()}`, token: TOKEN, timeoutMs: 100,
      controllers: { x32dbg: { command: "fixture", args: [] }, x64dbg: { command: "fixture", args: [] } }, execute });
    const socket = net.createConnection({ path: agent.path, allowHalfOpen: true });
    try {
      await new Promise<void>((resolve, reject) => {
        let text = "";
        socket.on("error", reject);
        socket.on("connect", () => socket.write('{}\n'));
        socket.on("data", (chunk) => { text += chunk.toString(); });
        socket.on("end", () => {
          try { expect(JSON.parse(text)).toMatchObject({ code: "AGENT_REQUEST_REJECTED" }); resolve(); }
          catch (error) { reject(error); }
        });
      });
      expect(socket.writableEnded).toBe(false);
      await agent.close();
      expect(execute).not.toHaveBeenCalled();
    } finally { socket.destroy(); }
  });

  it.each(["rejection", "response", "execution"])("enforces absolute channel cleanup during stalled %s", async (phase) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const server = net.createServer();
    const create = vi.spyOn(net, "createServer").mockImplementation((...args) => {
      const listener = args.find((arg) => typeof arg === "function") as (socket: net.Socket) => void;
      server.on("connection", listener);
      return server;
    });
    let accepted!: net.Socket;
    let accept!: () => void;
    const connected = new Promise<void>((resolve) => { accept = resolve; });
    server.on("connection", (socket) => {
      if (accepted !== undefined) return;
      accepted = socket;
      // Simulate a write that never completes, including an uncooperative peer.
      vi.spyOn(socket, "end").mockReturnValue(socket);
      accept();
    });
    let finish!: (value: { ok: true; value: { status: string } }) => void;
    const execute = vi.fn(() => phase === "response"
      ? Promise.resolve({ ok: true as const, value: { status: "ok" } })
      : new Promise<{ ok: true; value: { status: string } }>((resolve) => { finish = resolve; }));
    const pipeName = `gateway-test-${randomUUID()}`;
    const agent = await startUserAgent({ pipeName, token: TOKEN, timeoutMs: 100,
      controllers: { x32dbg: { command: "fixture", args: [] }, x64dbg: { command: "fixture", args: [] } }, execute });
    create.mockRestore();
    const socket = net.createConnection({ path: agent.path, allowHalfOpen: true });
    try {
      await connected;
      accepted.emit("data", Buffer.from(phase === "rejection" ? '{}\n' : JSON.stringify({ version: 1,
        requestId: randomUUID(), token: TOKEN, backend: "x64dbg", action: "restart", force: false,
        timeoutMs: 200, deadlineUnixMs: Date.now() + 200 }) + "\n"));
      await Promise.resolve();
      const deadline = phase === "rejection" ? 100 : 200;
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(accepted.destroyed).toBe(false);
      accepted.emit("data", Buffer.from("ignored traffic"));
      await vi.advanceTimersByTimeAsync(1);
      expect(accepted.destroyed).toBe(true);
      if (phase === "execution") {
        const busy = await callUserAgent({ pipeName, token: TOKEN,
          backend: "x64dbg", action: "restart", force: false, timeoutMs: 100 });
        expect(busy).toMatchObject({ ok: false, outcomeUnknown: false, message: "backend lifecycle operation is active" });
        expect(execute).toHaveBeenCalledTimes(1);
      } else if (phase === "rejection") {
        expect(execute).not.toHaveBeenCalled();
      } else {
        expect(execute).toHaveBeenCalledTimes(1);
      }
    } finally {
      finish?.({ ok: true, value: { status: "ok" } });
      accepted?.destroy();
      socket.destroy();
      await agent.close();
      vi.restoreAllMocks(); vi.useRealTimers();
    }
  });

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
        action: "start", force: false, timeoutMs: expect.any(Number) }]);
      expect((observed[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThan(0);
      expect((observed[0] as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(900);
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

  it.each(["timeout", "error", "close"])("never dispatches after a preconnect %s", async (event) => {
    vi.useFakeTimers();
    const socket = new net.Socket();
    const write = vi.spyOn(socket, "write").mockReturnValue(true);
    vi.spyOn(net, "createConnection").mockReturnValue(socket);
    try {
      const result = callUserAgent({ pipeName: "fixture", token: TOKEN, backend: "x64dbg",
        action: "restart", force: false, timeoutMs: 100 });
      if (event === "timeout") await vi.advanceTimersByTimeAsync(100);
      else socket.emit(event, ...(event === "error" ? [new Error("fixture")] : []));
      socket.emit("connect");
      expect(await result).toMatchObject({ code: "USER_SESSION_UNAVAILABLE", dispatchStarted: false, outcomeUnknown: false });
      expect(write).not.toHaveBeenCalled();
    } finally { socket.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it.each(["timeout", "error", "close", "throw", "malformed", "oversized"])("reports uncertainty after dispatch on %s", async (event) => {
    vi.useFakeTimers();
    const socket = new net.Socket();
    const write = vi.spyOn(socket, "write").mockImplementation(() => {
      if (event === "throw") throw new Error("fixture");
      return true;
    });
    vi.spyOn(net, "createConnection").mockReturnValue(socket);
    try {
      const result = callUserAgent({ pipeName: "fixture", token: TOKEN, backend: "x64dbg",
        action: "restart", force: false, timeoutMs: 100 });
      socket.emit("connect");
      if (event === "timeout") {
        // Traffic must not extend the total deadline.
        await vi.advanceTimersByTimeAsync(50);
        socket.emit("data", Buffer.from("{"));
        await vi.advanceTimersByTimeAsync(50);
      } else if (event === "malformed") socket.emit("data", Buffer.from('{}\n'));
      else if (event === "oversized") socket.emit("data", Buffer.from("x".repeat(8193)));
      else if (event !== "throw") socket.emit(event, ...(event === "error" ? [new Error("fixture")] : []));
      expect(await result).toMatchObject({ ok: false, dispatchStarted: true, outcomeUnknown: true,
        code: event === "timeout" ? "TIMEOUT" : "PROCESS_FAILED" });
      expect(write).toHaveBeenCalledTimes(1);
      socket.emit("close");
      socket.emit("connect");
      expect(write).toHaveBeenCalledTimes(1);
    } finally { socket.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it.each([0, -1, 1.5, NaN, Infinity, 60_001])("rejects invalid caller timeout %s before connecting", async (timeoutMs) => {
    const connect = vi.spyOn(net, "createConnection");
    try {
      expect(await callUserAgent({ pipeName: "fixture", token: TOKEN, backend: "x64dbg",
        action: "restart", force: false, timeoutMs })).toMatchObject({ dispatchStarted: false, outcomeUnknown: false });
      expect(connect).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });

  it("validates untrusted deadlines and subtracts transit time before execution", async () => {
    const pipeName = `gateway-test-${randomUUID()}`;
    const execute = vi.fn(async () => ({ ok: true as const, value: { status: "ok" } }));
    const agent = await startUserAgent({ pipeName, token: TOKEN, timeoutMs: 1000,
      controllers: { x32dbg: { command: "fixture", args: [] }, x64dbg: { command: "fixture", args: [] } }, execute });
    const send = (fields: Record<string, unknown>): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
      const socket = net.createConnection(agent.path);
      let text = "";
      socket.on("error", reject);
      socket.on("data", (chunk) => { text += chunk.toString(); });
      socket.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      socket.on("connect", () => socket.write(JSON.stringify({ version: 1, requestId: randomUUID(), token: TOKEN,
        backend: "x64dbg", action: "restart", force: false, timeoutMs: 1000, deadlineUnixMs: Date.now() + 1000, ...fields }) + "\n"));
    });
    try {
      for (const fields of [{ timeoutMs: 0 }, { timeoutMs: 1.5 }, { timeoutMs: 60_001 },
        { timeoutMs: "1000" }, { action: ["restart"] }, { deadlineUnixMs: null }, { deadlineUnixMs: Date.now() + 120_000 }]) {
        expect(await send(fields)).toMatchObject({ ok: false, code: "AGENT_REQUEST_REJECTED" });
      }
      expect(await send({ deadlineUnixMs: Date.now() - 1 })).toMatchObject({ ok: false, code: "TIMEOUT", outcomeUnknown: false });
      expect(execute).not.toHaveBeenCalled();
      expect(await send({ deadlineUnixMs: Date.now() + 500 })).toMatchObject({ ok: true });
      expect(execute).toHaveBeenCalledTimes(1);
      const budget = (execute.mock.calls[0] as unknown as [unknown, unknown, unknown, number])[3];
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(450);
    } finally { await agent.close(); }
  });

  it("bounds a real child by the caller budget, not the agent's 60-second read timeout", async () => {
    const pipeName = `gateway-test-${randomUUID()}`;
    let execution: ReturnType<typeof runLifecycleProcess> | undefined;
    let budget = 0;
    const agent = await startUserAgent({ pipeName, token: TOKEN, timeoutMs: 60_000,
      controllers: { x32dbg: { command: process.execPath, args: [] }, x64dbg: { command: process.execPath, args: [] } },
      execute: (controller, _action, _force, timeoutMs) => {
        budget = timeoutMs;
        execution = runLifecycleProcess(controller.command, ["--eval", "setTimeout(() => {}, 10000)"], timeoutMs);
        return execution;
      } });
    try {
      expect(await callUserAgent({ pipeName, token: TOKEN, backend: "x64dbg", action: "restart",
        force: false, timeoutMs: 500 })).toMatchObject({ ok: false, code: "TIMEOUT", dispatchStarted: true, outcomeUnknown: true });
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(450);
      expect(await execution).toMatchObject({ ok: false, code: "TIMEOUT", dispatchStarted: true, outcomeUnknown: true });
    } finally { await agent.close(); }
  });

  it("keeps the backend busy after disconnect until execution settles and survives execution rejection", async () => {
    const pipeName = `gateway-test-${randomUUID()}`;
    let rejectExecution!: (error: Error) => void;
    let started!: () => void;
    const executing = new Promise<void>((resolve) => { started = resolve; });
    const execute = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectExecution = reject; started(); }));
    const agent = await startUserAgent({ pipeName, token: TOKEN, timeoutMs: 1000,
      controllers: { x32dbg: { command: "fixture", args: [] }, x64dbg: { command: "fixture", args: [] } }, execute });
    const socket = net.createConnection(agent.path);
    try {
      socket.on("connect", () => {
        const request = JSON.stringify({ version: 1, requestId: randomUUID(), token: TOKEN,
          backend: "x64dbg", action: "restart", force: false, timeoutMs: 1000, deadlineUnixMs: Date.now() + 1000 }) + "\n";
        socket.write(request + request);
      });
      await executing;
      socket.destroy();
      expect(await callUserAgent({ pipeName, token: TOKEN, backend: "x64dbg", action: "restart", force: false,
        timeoutMs: 1000 })).toMatchObject({ ok: false, outcomeUnknown: false, message: "backend lifecycle operation is active" });
      expect(execute).toHaveBeenCalledTimes(1);
      rejectExecution(new Error("fixture"));
      await new Promise((resolve) => setImmediate(resolve));
    } finally { socket.destroy(); rejectExecution?.(new Error("cleanup")); await agent.close(); }
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
      const execute = vi.fn(async () => ({ ok: false as const, code: "TIMEOUT" as const,
        message: "fixture deadline", dispatchStarted: true, outcomeUnknown: true }));
      const agent = await startUserAgent({ pipeName, token: TOKEN, timeoutMs: 60_000,
        controllers: { x32dbg: { command: "fixture", args: [] }, x64dbg: { command: "fixture", args: [] } }, execute });
      try {
        const ambiguous = await client.callTool({ name: "gateway.backend_control", arguments: {
          backendId: "x64dbg", action: "restart",
        } });
        expect(ambiguous.structuredContent).toMatchObject({ error: {
          code: "OUTCOME_UNKNOWN", dispatchStarted: true, safeToRetry: false, retryable: false,
        } });
        expect(execute).toHaveBeenCalledTimes(1);
        const status = await client.callTool({ name: "gateway.backend_control", arguments: {
          backendId: "x64dbg", action: "status",
        } });
        expect(status.structuredContent).toMatchObject({ error: {
          code: "BACKEND_CONTROL_FAILED", dispatchStarted: true, safeToRetry: true,
        } });
      } finally { await agent.close(); }
    } finally {
      await client.close().catch(() => undefined);
      await runtime.close();
    }
  });
});
