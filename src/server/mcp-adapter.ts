import { Server } from "@modelcontextprotocol/server";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import type { CatalogSnapshot, GatewayCallResult, JsonValue } from "../domain/types.js";
import type { ToolRouter } from "../router/router.js";
import { ToolExecutionScope } from "../router/router.js";
import { GATEWAY_VERSION } from "../version.js";

export interface CatalogSnapshotSource {
  current(): CatalogSnapshot;
  subscribe?(listener: () => void): () => void;
}

/** One protocol instance and one coalesced invalidation per HTTP session. */
export class GatewayMcpServer extends Server {
  public readonly executionScope = new ToolExecutionScope();
  #knownHash: string;
  #initialized = false;
  #stream: (() => boolean) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  public constructor(private readonly snapshots: CatalogSnapshotSource) {
    super({ name: "dynamic-analysis-mcp-gateway", version: GATEWAY_VERSION }, {
      capabilities: { tools: { listChanged: true } },
      instructions: "Backend tools are namespaced by backend type. Never retry OUTCOME_UNKNOWN mutations.",
    });
    this.#knownHash = snapshots.current().hash;
    const unsubscribe = snapshots.subscribe?.(() => this.#schedule());
    this.oninitialized = () => { this.#initialized = true; this.#schedule(); };
    this.onclose = () => {
      this.#closed = true;
      this.executionScope.close();
      clearTimeout(this.#timer);
      unsubscribe?.();
      this.#stream = undefined;
    };
  }

  public listed(): CatalogSnapshot {
    const snapshot = this.snapshots.current();
    this.#knownHash = snapshot.hash;
    return snapshot;
  }

  public notificationStream(stream: (() => boolean) | undefined): void {
    this.#stream = stream;
    // A fresh GET must reconcile changes lost between list/subscribe or while
    // disconnected. No event history or tool-call replay is required.
    this.#schedule();
  }

  #schedule(): void {
    if (this.#closed || !this.#initialized || !this.#stream || this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const hash = this.snapshots.current().hash;
      if (!this.#stream || hash === this.#knownHash) return;
      if (!this.#stream()) { void this.close().catch(() => {}); return; }
      // Do not acknowledge delivery: only tools/list acknowledges the baseline.
      // Publication triggers, rather than a heartbeat, schedule invalidations.
      void this.sendToolListChanged().catch(() => this.close()).catch(() => {});
    }, 25);
    this.#timer.unref();
  }
}

function asToolDefinitions(snapshot: CatalogSnapshot): Tool[] {
  return structuredClone(snapshot.tools) as unknown as Tool[];
}

function asCallToolResult(result: GatewayCallResult): CallToolResult {
  if (result.ok) {
    return structuredClone(result.result) as unknown as CallToolResult;
  }
  const structuredContent = { ok: false, error: result.error };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

function argumentsObject(value: unknown): Readonly<Record<string, JsonValue>> {
  if (value === undefined) {
    return {};
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Readonly<Record<string, JsonValue>>;
}

export function createGatewayMcpServer(
  snapshots: CatalogSnapshotSource,
  router: ToolRouter,
): GatewayMcpServer {
  const server = new GatewayMcpServer(snapshots);

  server.setRequestHandler("tools/list", async () => ({
    tools: asToolDefinitions(server.listed()),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const snapshot = snapshots.current();
    const result = await router.call(
      snapshot,
      request.params.name,
      argumentsObject(request.params.arguments),
      server.executionScope,
    );
    return server.projectCallToolResult(asCallToolResult(result), undefined);
  });

  return server;
}
