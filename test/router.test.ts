import { describe, expect, it } from "vitest";

import {
  buildCatalog,
  CatalogPublisher,
  DownstreamTransportError,
  ToolRouter,
} from "../src/index.js";
import type {
  ArgumentValidator,
  BackendCatalogInput,
  BackendClient,
  GatewayCallResult,
  ManagementToolHandler,
  TraceIdSource,
} from "../src/index.js";

const acceptAll: ArgumentValidator = {
  validate: () => ({ valid: true }),
};

const management: ManagementToolHandler = {
  call: async (_route, _argumentsValue, snapshot, traceId): Promise<GatewayCallResult> => ({
    ok: true,
    result: {
      content: [],
      structuredContent: { catalogGeneration: snapshot.generation, traceId },
    },
  }),
};

class SequentialTraceIds implements TraceIdSource {
  #next = 1;

  public next(): string {
    const value = `trace-${this.#next}`;
    this.#next += 1;
    return value;
  }
}

function backend(
  backendId: string,
  backendType: string,
  downstreamName: string,
  readOnly: boolean,
): BackendCatalogInput {
  return {
    backendId,
    backendType,
    tools: [
      {
        name: downstreamName,
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: readOnly },
      },
    ],
    readOnlyTools: new Set(readOnly ? [downstreamName] : []),
    mutationTools: new Set(readOnly ? [] : [downstreamName]),
  };
}

function router(clients: ReadonlyMap<string, BackendClient>, validator = acceptAll): ToolRouter {
  return new ToolRouter({ clients, validator, management, traceIds: new SequentialTraceIds() });
}

describe("snapshot-bound end-to-end routing", () => {
  it("preserves CE camelCase arguments and calls the exact downstream name once", async () => {
    const calls: unknown[] = [];
    const client: BackendClient = {
      callTool: async (call) => {
        calls.push(call);
        return {
          content: [{ type: "text", text: "ok" }],
          structuredContent: { sessionId: "session-1", nextCursor: "cursor-2" },
        };
      },
    };
    const snapshot = buildCatalog([backend("ce", "ce", "ce.process", false)], 7);
    const result = await router(new Map([["ce", client]])).call(snapshot, "ce.ce.process", {
      action: "attach",
      expectedGeneration: 3,
      pid: 1234,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      {
        name: "ce.process",
        arguments: { action: "attach", expectedGeneration: 3, pid: 1234 },
      },
    ]);
    if (result.ok) {
      expect(result.result.structuredContent).toEqual({
        sessionId: "session-1",
        nextCursor: "cursor-2",
      });
    }
  });

  it("preserves x64dbg snake_case identity fields", async () => {
    const calls: unknown[] = [];
    const client: BackendClient = {
      callTool: async (call) => {
        calls.push(call);
        return { content: [], structuredContent: { state_generation: 9 } };
      },
    };
    const snapshot = buildCatalog([backend("x64", "x64dbg", "debugger.resume", false)], 4);
    const argumentsValue = {
      instance_id: "11111111-2222-4333-8444-555555555555",
      operation_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    };

    await router(new Map([["x64", client]])).call(
      snapshot,
      "x64dbg.debugger.resume",
      argumentsValue,
    );
    expect(calls).toEqual([{ name: "debugger.resume", arguments: argumentsValue }]);
  });

  it("uses the captured snapshot even after a new generation publishes", async () => {
    const calls: string[] = [];
    const oldClient: BackendClient = {
      callTool: async ({ name }) => {
        calls.push(`old:${name}`);
        return { content: [] };
      },
    };
    const publisher = new CatalogPublisher();
    const captured = publisher.publish([backend("x64", "x64dbg", "memory.read", true)]);
    publisher.publish([backend("x64", "x64dbg", "memory.search", true)]);

    const result = await router(new Map([["x64", oldClient]])).call(
      captured,
      "x64dbg.memory.read",
      { address: "0x1000" },
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["old:memory.read"]);
  });

  it("never retries and reports unknown mutation outcome after dispatch", async () => {
    let attempts = 0;
    const client: BackendClient = {
      callTool: async () => {
        attempts += 1;
        throw new DownstreamTransportError("response lost", true);
      },
    };
    const snapshot = buildCatalog([backend("x64", "x64dbg", "memory.write", false)], 12);
    const result = await router(new Map([["x64", client]])).call(
      snapshot,
      "x64dbg.memory.write",
      { address: "0x1000", bytes: "90" },
    );

    expect(attempts).toBe(1);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "OUTCOME_UNKNOWN",
        message: "backend response was lost after mutation dispatch; outcome is unknown",
        backend: "x64dbg",
        catalogGeneration: 12,
        retryable: false,
        safeToRetry: false,
        dispatchStarted: true,
        traceId: "trace-1",
      },
    });
  });

  it("marks configured reads safe to retry without retrying them", async () => {
    let attempts = 0;
    const client: BackendClient = {
      callTool: async () => {
        attempts += 1;
        throw new DownstreamTransportError("response lost", true);
      },
    };
    const snapshot = buildCatalog([backend("ce", "ce", "ce.memory_read", true)], 5);
    const result = await router(new Map([["ce", client]])).call(
      snapshot,
      "ce.ce.memory_read",
      { expectedGeneration: 2, address: "0x1000" },
    );

    expect(attempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BACKEND_UNAVAILABLE");
      expect(result.error.safeToRetry).toBe(true);
      expect(result.error.dispatchStarted).toBe(true);
    }
  });

  it("rejects invalid arguments before dispatch", async () => {
    let attempts = 0;
    const client: BackendClient = {
      callTool: async () => {
        attempts += 1;
        return { content: [] };
      },
    };
    const validator: ArgumentValidator = {
      validate: () => ({ valid: false, message: "expectedGeneration is required" }),
    };
    const snapshot = buildCatalog([backend("ce", "ce", "ce.memory_read", true)], 3);
    const result = await router(new Map([["ce", client]]), validator).call(
      snapshot,
      "ce.ce.memory_read",
      {},
    );

    expect(attempts).toBe(0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOOL_ARGUMENTS");
      expect(result.error.dispatchStarted).toBe(false);
    }
  });
});
