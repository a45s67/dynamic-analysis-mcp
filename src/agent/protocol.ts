import { randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";

import { runLifecycleCommand } from "../backend/lifecycle.js";
import type { LifecycleAction, LifecycleExecution } from "../backend/lifecycle.js";
import type { JsonValue } from "../domain/types.js";

const MAX_MESSAGE_BYTES = 8_192;
const TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;
const MAX_TIMEOUT_MS = 60_000;

export type AgentBackend = "x32dbg" | "x64dbg";

export interface AgentController {
  readonly command: string;
  readonly args: readonly string[];
}

interface AgentRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly token: string;
  readonly backend: AgentBackend;
  readonly action: LifecycleAction;
  readonly force: boolean;
  readonly timeoutMs: number;
  readonly deadlineUnixMs: number;
}

type AgentResponse =
  | { readonly version: 1; readonly requestId: string; readonly ok: true; readonly value: Readonly<Record<string, JsonValue>> }
  | {
      readonly version: 1;
      readonly requestId: string;
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly outcomeUnknown: boolean;
    };

function pipePath(name: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error("invalid agent pipe name");
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : `/tmp/${name}.sock`;
}

function validToken(token: string): boolean {
  return TOKEN_PATTERN.test(token) && Buffer.byteLength(token) === token.length;
}

function tokenMatches(actual: string, expected: string): boolean {
  if (!validToken(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function parseRequest(text: string): AgentRequest | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const request = value as Record<string, unknown>;
    const keys = Object.keys(request);
    if (
      keys.length !== 8 ||
      !keys.every((key) =>
        ["version", "requestId", "token", "backend", "action", "force", "timeoutMs", "deadlineUnixMs"].includes(key),
      ) ||
      request.version !== 1 ||
      typeof request.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(request.requestId) ||
      typeof request.token !== "string" ||
      (request.backend !== "x32dbg" && request.backend !== "x64dbg") ||
      typeof request.action !== "string" ||
      !["status", "start", "stop", "restart"].includes(request.action) ||
      typeof request.force !== "boolean" ||
      !Number.isSafeInteger(request.timeoutMs) ||
      (request.timeoutMs as number) < 1 || (request.timeoutMs as number) > MAX_TIMEOUT_MS ||
      !Number.isSafeInteger(request.deadlineUnixMs) ||
      (request.deadlineUnixMs as number) < 1 ||
      (request.deadlineUnixMs as number) > Date.now() + (request.timeoutMs as number) ||
      (request.force && request.action !== "stop" && request.action !== "restart")
    ) return undefined;
    return request as unknown as AgentRequest;
  } catch {
    return undefined;
  }
}

function writeResponse(socket: net.Socket, response: AgentResponse): void {
  socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
}

export interface RunningUserAgent {
  readonly path: string;
  close(): Promise<void>;
}

export async function startUserAgent(options: {
  readonly pipeName: string;
  readonly token: string;
  readonly controllers: Readonly<Record<AgentBackend, AgentController>>;
  // Bounds unauthenticated channel lifetime; authenticated channels use the caller deadline.
  readonly timeoutMs: number;
  readonly execute?: (
    controller: AgentController,
    action: LifecycleAction,
    force: boolean,
    timeoutMs: number,
  ) => Promise<LifecycleExecution>;
}): Promise<RunningUserAgent> {
  if (!validToken(options.token)) throw new Error("agent token is invalid");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("agent timeout is invalid");
  }
  const path = pipePath(options.pipeName);
  const active = new Set<AgentBackend>();
  const server = net.createServer((socket) => {
    let bytes = 0;
    let text = "";
    let handled = false;
    socket.on("error", () => socket.destroy());
    let cleanupTimer = setTimeout(() => socket.destroy(), options.timeoutMs);
    socket.once("close", () => clearTimeout(cleanupTimer));
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      bytes += chunk.byteLength;
      if (bytes > MAX_MESSAGE_BYTES) return socket.destroy();
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      socket.pause();
      const request = parseRequest(text.slice(0, newline));
      if (request === undefined || !tokenMatches(request.token, options.token)) {
        writeResponse(socket, {
          version: 1, requestId: request?.requestId ?? randomUUID(), ok: false,
          code: "AGENT_REQUEST_REJECTED", message: "agent request was rejected", outcomeUnknown: false,
        });
        return;
      }
      const remainingMs = Math.min(request.timeoutMs, request.deadlineUnixMs - Date.now());
      // Cleanup must not depend on peer EOF, write completion, or execution settlement.
      clearTimeout(cleanupTimer);
      cleanupTimer = setTimeout(() => socket.destroy(), Math.max(1, remainingMs));
      if (active.has(request.backend)) {
        writeResponse(socket, { version: 1, requestId: request.requestId, ok: false,
          code: "AGENT_BUSY", message: "backend lifecycle operation is active", outcomeUnknown: false });
        return;
      }
      // At minimum: 1 ms controller < 2 ms process < 3 ms caller budget.
      if (remainingMs < 3) {
        writeResponse(socket, { version: 1, requestId: request.requestId, ok: false,
          code: "TIMEOUT", message: "agent request has insufficient time before execution", outcomeUnknown: false });
        return;
      }
      // Leave response/termination headroom inside the caller's absolute deadline.
      const executionMs = remainingMs - Math.max(1, Math.min(1_000, Math.floor(remainingMs / 10)));
      active.add(request.backend);
      const controller = options.controllers[request.backend];
      const execute = options.execute ?? ((selected, action, force, timeoutMs) =>
        runLifecycleCommand(selected.command, selected.args, action, force, timeoutMs));
      void Promise.resolve().then(() => execute(controller, request.action, request.force, executionMs)).then((result) => {
          if (result.ok) writeResponse(socket, { version: 1, requestId: request.requestId,
            ok: true, value: result.value });
          else writeResponse(socket, { version: 1, requestId: request.requestId, ok: false,
            code: result.code, message: result.message, outcomeUnknown: result.outcomeUnknown });
        }).catch(() => {
          writeResponse(socket, { version: 1, requestId: request.requestId, ok: false,
            code: "PROCESS_FAILED", message: "agent execution failed", outcomeUnknown: request.action !== "status" });
        }).finally(() => active.delete(request.backend));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  return { path, close: () => new Promise<void>((resolve, reject) =>
    server.close((error) => error === undefined ? resolve() : reject(error))) };
}

export function callUserAgent(options: {
  readonly pipeName: string;
  readonly token: string;
  readonly backend: AgentBackend;
  readonly action: LifecycleAction;
  readonly force: boolean;
  readonly timeoutMs: number;
}): Promise<LifecycleExecution> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
    return Promise.resolve({ ok: false, code: "PROCESS_FAILED", message: "agent timeout is invalid",
      dispatchStarted: false, outcomeUnknown: false });
  }
  const deadlineUnixMs = Date.now() + options.timeoutMs;
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const socket = net.createConnection(pipePath(options.pipeName));
    let settled = false;
    let dispatchStarted = false;
    let text = "";
    const failed = (timedOut = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: false, code: dispatchStarted ? (timedOut ? "TIMEOUT" : "PROCESS_FAILED") : "USER_SESSION_UNAVAILABLE",
        message: dispatchStarted ? "user agent response was not received; inspect backend state before another mutation"
          : "no interactive user agent is available",
        dispatchStarted, outcomeUnknown: dispatchStarted && options.action !== "status" });
    };
    const timer = setTimeout(() => failed(true), options.timeoutMs);
    socket.once("error", () => failed());
    socket.once("close", () => failed());
    socket.once("connect", () => {
      if (settled) return;
      if (Date.now() >= deadlineUnixMs) return failed(true);
      // A write may reach the peer even when its callback later reports an error.
      dispatchStarted = true;
      try { socket.write(`${JSON.stringify({ version: 1, requestId,
      token: options.token, backend: options.backend, action: options.action,
      force: options.force, timeoutMs: options.timeoutMs, deadlineUnixMs })}\n`); }
      catch { failed(); }
    });
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return failed();
      const newline = text.indexOf("\n");
      if (newline < 0 || settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      try {
        const response = JSON.parse(text.slice(0, newline)) as AgentResponse;
        if (response === null || response.version !== 1 || response.requestId !== requestId ||
          typeof response.ok !== "boolean" ||
          (response.ok ? response.value === null || typeof response.value !== "object" || Array.isArray(response.value)
            : typeof response.code !== "string" || typeof response.message !== "string" ||
              typeof response.outcomeUnknown !== "boolean")) throw new Error("invalid response");
        if (response.ok) resolve({ ok: true, value: response.value });
        else resolve({ ok: false,
          code: response.code === "TIMEOUT" ? "TIMEOUT" : "PROCESS_FAILED",
          message: response.message, dispatchStarted: true,
          outcomeUnknown: response.outcomeUnknown && options.action !== "status" });
      } catch {
        resolve({ ok: false, code: "PROCESS_FAILED", message: "user agent returned an invalid response",
          dispatchStarted: true, outcomeUnknown: options.action !== "status" });
      }
    });
  });
}
