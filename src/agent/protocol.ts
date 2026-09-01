import { randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";

import { runLifecycleCommand } from "../backend/lifecycle.js";
import type { LifecycleAction, LifecycleExecution } from "../backend/lifecycle.js";
import type { JsonValue } from "../domain/types.js";

const MAX_MESSAGE_BYTES = 8_192;
const TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;

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
      keys.length !== 6 ||
      !keys.every((key) =>
        ["version", "requestId", "token", "backend", "action", "force"].includes(key),
      ) ||
      request.version !== 1 ||
      typeof request.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(request.requestId) ||
      typeof request.token !== "string" ||
      (request.backend !== "x32dbg" && request.backend !== "x64dbg") ||
      !["status", "start", "stop", "restart"].includes(String(request.action)) ||
      typeof request.force !== "boolean" ||
      (request.force && request.action !== "stop" && request.action !== "restart")
    ) return undefined;
    return request as unknown as AgentRequest;
  } catch {
    return undefined;
  }
}

function writeResponse(socket: net.Socket, response: AgentResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

export interface RunningUserAgent {
  readonly path: string;
  close(): Promise<void>;
}

export async function startUserAgent(options: {
  readonly pipeName: string;
  readonly token: string;
  readonly controllers: Readonly<Record<AgentBackend, AgentController>>;
  readonly timeoutMs: number;
  readonly execute?: (
    controller: AgentController,
    action: LifecycleAction,
    force: boolean,
    timeoutMs: number,
  ) => Promise<LifecycleExecution>;
}): Promise<RunningUserAgent> {
  if (!validToken(options.token)) throw new Error("agent token is invalid");
  const path = pipePath(options.pipeName);
  const active = new Set<AgentBackend>();
  const server = net.createServer((socket) => {
    let bytes = 0;
    let text = "";
    socket.setTimeout(options.timeoutMs, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_MESSAGE_BYTES) return socket.destroy();
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      socket.pause();
      const request = parseRequest(text.slice(0, newline));
      if (request === undefined || !tokenMatches(request.token, options.token)) {
        writeResponse(socket, {
          version: 1, requestId: request?.requestId ?? randomUUID(), ok: false,
          code: "AGENT_REQUEST_REJECTED", message: "agent request was rejected", outcomeUnknown: false,
        });
        return;
      }
      if (active.has(request.backend)) {
        writeResponse(socket, { version: 1, requestId: request.requestId, ok: false,
          code: "AGENT_BUSY", message: "backend lifecycle operation is active", outcomeUnknown: false });
        return;
      }
      active.add(request.backend);
      const controller = options.controllers[request.backend];
      const execute = options.execute ?? ((selected, action, force, timeoutMs) =>
        runLifecycleCommand(selected.command, selected.args, action, force, timeoutMs));
      void execute(controller, request.action, request.force, options.timeoutMs).then((result) => {
          if (result.ok) writeResponse(socket, { version: 1, requestId: request.requestId,
            ok: true, value: result.value });
          else writeResponse(socket, { version: 1, requestId: request.requestId, ok: false,
            code: result.code, message: result.message, outcomeUnknown: result.outcomeUnknown });
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
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const socket = net.createConnection(pipePath(options.pipeName));
    let settled = false;
    let text = "";
    const unavailable = (): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok: false, code: "USER_SESSION_UNAVAILABLE", message:
        "no interactive user agent is available", dispatchStarted: false, outcomeUnknown: false });
    };
    socket.setTimeout(options.timeoutMs, unavailable);
    socket.once("error", unavailable);
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, requestId,
      token: options.token, backend: options.backend, action: options.action,
      force: options.force })}\n`));
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return unavailable();
      const newline = text.indexOf("\n");
      if (newline < 0 || settled) return;
      settled = true;
      socket.destroy();
      try {
        const response = JSON.parse(text.slice(0, newline)) as AgentResponse;
        if (response.requestId !== requestId) throw new Error("mismatch");
        if (response.ok) resolve({ ok: true, value: response.value });
        else resolve({ ok: false,
          code: response.code === "USER_SESSION_UNAVAILABLE" ? "USER_SESSION_UNAVAILABLE" : "PROCESS_FAILED",
          message: response.message, dispatchStarted: true, outcomeUnknown: response.outcomeUnknown });
      } catch {
        resolve({ ok: false, code: "PROCESS_FAILED", message: "user agent returned an invalid response",
          dispatchStarted: true, outcomeUnknown: true });
      }
    });
  });
}
