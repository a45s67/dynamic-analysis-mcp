import { Server } from "@modelcontextprotocol/server";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";

import type { CatalogSnapshot, GatewayCallResult, JsonValue } from "../domain/types.js";
import type { ToolRouter } from "../router/router.js";
import { GATEWAY_VERSION } from "../version.js";

export interface CatalogSnapshotSource {
  current(): CatalogSnapshot;
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
): Server {
  const server = new Server(
    { name: "dynamic-analysis-mcp-gateway", version: GATEWAY_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Backend tools are namespaced by backend type. Never retry OUTCOME_UNKNOWN mutations.",
    },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: asToolDefinitions(snapshots.current()),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const snapshot = snapshots.current();
    const result = await router.call(
      snapshot,
      request.params.name,
      argumentsObject(request.params.arguments),
    );
    return server.projectCallToolResult(asCallToolResult(result), undefined);
  });

  return server;
}
