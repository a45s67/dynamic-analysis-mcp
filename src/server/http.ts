import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { GatewayMcpServer } from "./mcp-adapter.js";

export interface GatewayHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly path: "/mcp";
  readonly bearerToken: string;
  readonly createMcpServer: () => GatewayMcpServer;
  /** Embedding/test overrides; production uses the bounded defaults below. */
  readonly maxSessions?: number;
  readonly sessionIdleMs?: number;
}

export interface RunningGatewayHttpServer {
  readonly url: URL;
  readonly sessionCount: number;
  close(): Promise<void>;
}

interface Session {
  readonly protocol: GatewayMcpServer;
  readonly transport: NodeStreamableHTTPServerTransport;
  readonly responses: Set<ServerResponse>;
  touched: number;
  /** Open POST responses only; ToolRouter separately reserves handler execution. */
  posts: number;
  sse?: ServerResponse | undefined;
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  const supplied = Buffer.from(header?.startsWith("Bearer ") === true ? header.slice(7) : "", "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (supplied.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(supplied, expected);
}

function reject(response: ServerResponse, status: number, code: string): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ code }));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 1024 * 1024) throw new Error("BODY_LIMIT");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // Single messages bound protocol-handler concurrency, even for hostile clients.
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_BODY");
  return value;
}

export async function startGatewayHttp(options: GatewayHttpOptions): Promise<RunningGatewayHttpServer> {
  if (options.bearerToken.length < 32) throw new Error("Gateway bearer token must contain at least 32 characters");
  const maxSessions = options.maxSessions ?? 32;
  const idleMs = options.sessionIdleMs ?? 15 * 60_000;
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 32 ||
      !Number.isSafeInteger(idleMs) || idleMs < 50 || idleMs > 15 * 60_000) {
    throw new Error("Invalid HTTP session limits");
  }
  const sessions = new Map<string, Session>();
  const allocated = new Set<Session>();
  let requests = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const dispose = async (session: Session): Promise<void> => {
    if (!allocated.delete(session)) return;
    if (session.transport.sessionId) sessions.delete(session.transport.sessionId);
    await session.protocol.close().catch(() => {});
    for (const response of session.responses) response.destroy();
  };
  const sweep = setInterval(() => {
    for (const session of allocated) {
      if (Date.now() - session.touched >= idleMs) void dispose(session);
    }
  }, Math.min(30_000, idleMs));
  sweep.unref();

  const server = createServer(async (request, response) => {
    let session: Session | undefined;
    let post = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (new URL(request.url ?? "/", "http://gateway.invalid").pathname !== options.path) {
        reject(response, 404, "NOT_FOUND"); return;
      }
      // Authentication precedes session lookup on every POST, GET and DELETE.
      if (!authorized(request.headers.authorization, options.bearerToken)) {
        response.setHeader("www-authenticate", "Bearer");
        reject(response, 401, "UNAUTHENTICATED"); return;
      }
      if (closing || requests >= 128) { reject(response, 503, "HTTP_CAPACITY"); return; }
      if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) {
        response.setHeader("allow", "GET, POST, DELETE");
        reject(response, 405, "METHOD_NOT_ALLOWED"); return;
      }
      const id = request.headers["mcp-session-id"];
      if (id !== undefined) {
        session = typeof id === "string" ? sessions.get(id) : undefined;
        if (!session) { reject(response, 404, "SESSION_NOT_FOUND"); return; }
      } else if (request.method !== "POST") {
        reject(response, 400, "SESSION_REQUIRED"); return;
      }
      requests++; // Reserve global capacity before connect/body parsing can yield.
      response.once("close", () => { requests--; });
      if (!session) {
        if (allocated.size >= maxSessions) { reject(response, 503, "SESSION_CAPACITY"); return; }
        const protocol = options.createMcpServer();
        const transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          keepAliveMs: 0,
          onsessioninitialized: (sessionId) => {
            if (closing || !allocated.has(created)) throw new Error("Session closed");
            sessions.set(sessionId, created);
          },
        });
        const created: Session = { protocol, transport, touched: Date.now(), posts: 0, responses: new Set() };
        session = created;
        allocated.add(created); // Reserve before any await, including body parsing.
        const onclose = protocol.onclose;
        protocol.onclose = () => { onclose?.(); void dispose(created); };
        await protocol.connect(transport);
      }
      const current = session;
      if (response.destroyed) return;
      if (request.method === "GET" && current.sse) { reject(response, 409, "SSE_ALREADY_OPEN"); return; }
      if (request.method === "POST" && current.posts >= 8) { reject(response, 429, "SESSION_BUSY"); return; }
      if (request.method !== "DELETE") current.responses.add(response);
      post = request.method === "POST";
      if (post) current.posts++;
      current.touched = Date.now();
      if (request.method !== "GET") deadline = setTimeout(() => {
        response.destroy();
        if (!current.transport.sessionId) void dispose(current);
      }, 300_000);
      deadline?.unref();
      response.once("close", () => {
        // Transport accounting only. Detached tool execution retains its own
        // router/session reservations until the actual handler settles.
        if (post) current.posts--;
        clearTimeout(deadline);
        current.responses.delete(response);
        if (current.sse === response) {
          current.sse = undefined;
          current.protocol.notificationStream(undefined);
        }
      });
      let parsed: unknown;
      if (post) {
        if (Number(request.headers["content-length"]) > 1024 * 1024) {
          response.setHeader("connection", "close");
          reject(response, 413, "BODY_LIMIT"); return;
        }
        const receiveDeadline = setTimeout(() => request.destroy(), 30_000);
        receiveDeadline.unref();
        try { parsed = await body(request); }
        finally { clearTimeout(receiveDeadline); }
      }
      if (!allocated.has(current)) { reject(response, 404, "SESSION_NOT_FOUND"); return; }
      if (request.method === "GET") {
        current.sse = response;
        // The SDK installs its standalone stream before writing HTTP headers.
        // Reconcile only once a successful SSE response really exists.
        const writeHead = response.writeHead;
        response.writeHead = function (this: ServerResponse, ...args: Parameters<typeof writeHead>) {
          const result = writeHead.apply(this, args);
          if (this.statusCode === 200) queueMicrotask(() => {
            if (current.sse === response && !response.destroyed) {
              current.protocol.notificationStream(() => !response.destroyed && !response.writableNeedDrain);
            }
          });
          return result;
        } as typeof writeHead;
      }
      await current.transport.handleRequest(request, response, parsed);
    } catch {
      if (!response.headersSent && !response.destroyed) reject(response, 400, "INVALID_REQUEST");
      else response.destroy();
    } finally {
      if (session) {
        if (!session.transport.sessionId) await dispose(session);
      }
    }
  });
  server.maxConnections = 256;
  server.headersTimeout = 30_000;
  server.requestTimeout = 30_000;
  try {
    await new Promise<void>((resolve, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(options.port, options.host, () => { server.off("error", rejectListen); resolve(); });
    });
  } catch (error) { clearInterval(sweep); throw error; }
  const address = server.address() as AddressInfo;
  return {
    url: new URL(`http://${options.host}:${address.port}${options.path}`),
    get sessionCount() { return allocated.size; },
    close: () => closePromise ??= (async () => {
      closing = true;
      clearInterval(sweep);
      await Promise.all([...allocated].map(dispose));
      await new Promise<void>((resolve, rejectClose) => {
        server.close((error) => error === undefined ? resolve() : rejectClose(error));
        server.closeAllConnections();
      });
    })(),
  };
}
