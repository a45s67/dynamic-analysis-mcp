import { describe, expect, it } from "vitest";

import {
  buildCatalog,
  canonicalJson,
  CatalogPublisher,
  CatalogValidationError,
} from "../src/index.js";
import type { BackendCatalogInput, DownstreamToolDefinition } from "../src/index.js";

const EMPTY_SCHEMA = Object.freeze({ type: "object", additionalProperties: false });

function tool(
  name: string,
  readOnlyHint: boolean,
  inputSchema: DownstreamToolDefinition["inputSchema"] = EMPTY_SCHEMA,
): DownstreamToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    inputSchema,
    annotations: {
      readOnlyHint,
      destructiveHint: false,
      idempotentHint: readOnlyHint,
      openWorldHint: false,
    },
  };
}

function backend(
  backendId: string,
  backendType: string,
  tools: readonly DownstreamToolDefinition[],
  readOnlyTools: readonly string[] = [],
): BackendCatalogInput {
  return {
    backendId,
    backendType,
    tools,
    readOnlyTools: new Set(readOnlyTools),
    mutationTools: new Set(),
  };
}

describe("backend-compatible public names", () => {
  it("preserves dotted x64dbg names and CE's existing prefix", () => {
    const snapshot = buildCatalog(
      [
        backend("x64", "x64dbg", [tool("debugger.state", true)], ["debugger.state"]),
        backend("ce", "ce", [tool("ce.status", true)], ["ce.status"]),
      ],
      1,
    );

    expect(snapshot.tools.map(({ name }) => name)).toEqual([
      "ce.ce.status",
      "gateway.backend_control",
      "gateway.backends",
      "gateway.refresh",
      "gateway.status",
      "x64dbg.debugger.state",
    ]);
    expect(snapshot.routes.get("x64dbg.debugger.state")).toEqual({
      routeKind: "backend",
      backendId: "x64",
      backendType: "x64dbg",
      downstreamName: "debugger.state",
      safetyClass: "read",
    });
  });

  it("preserves backend-owned field casing and enum values", () => {
    const ceTool = tool("ce.debug_control", false, {
      type: "object",
      properties: {
        expectedGeneration: { type: "integer" },
        expectedStopGeneration: { type: "integer" },
        mode: { enum: ["run", "step_into", "step_over"] },
      },
    });
    const x64Tool = tool("debugger.resume", false, {
      type: "object",
      properties: {
        instance_id: { type: "string" },
        operation_id: { type: "string" },
      },
    });

    const snapshot = buildCatalog(
      [backend("ce", "ce", [ceTool]), backend("x64", "x64dbg", [x64Tool])],
      1,
    );
    expect(snapshot.tools.find(({ name }) => name === "ce.ce.debug_control")?.inputSchema).toEqual(
      ceTool.inputSchema,
    );
    expect(snapshot.tools.find(({ name }) => name === "x64dbg.debugger.resume")?.inputSchema).toEqual(
      x64Tool.inputSchema,
    );
  });
});

describe("catalog publication", () => {
  it("always exposes the reserved management catalog", () => {
    const snapshot = buildCatalog([], 0);
    expect(snapshot.tools.map(({ name }) => name)).toEqual([
      "gateway.backend_control",
      "gateway.backends",
      "gateway.refresh",
      "gateway.status",
    ]);
    expect(snapshot.routes.get("gateway.refresh")).toEqual({
      routeKind: "management",
      managementName: "gateway.refresh",
      safetyClass: "mutation",
    });
    expect(snapshot.routes.get("gateway.backend_control")?.safetyClass).toBe("mutation");
  });

  it("is deterministic across backend and tool ordering", () => {
    const ce = backend("ce", "ce", [tool("ce.status", true)], ["ce.status"]);
    const x64 = backend(
      "x64",
      "x64dbg",
      [tool("memory.read", true), tool("debugger.state", true)],
      ["memory.read", "debugger.state"],
    );
    expect(buildCatalog([ce, x64], 1).hash).toBe(
      buildCatalog([{ ...x64, tools: [...x64.tools].reverse() }, ce], 99).hash,
    );
  });

  it("publishes a new generation only when the hash changes", () => {
    const publisher = new CatalogPublisher();
    const inputs = [backend("ce", "ce", [tool("ce.status", true)], ["ce.status"])];

    const first = publisher.publish(inputs);
    const equivalent = publisher.publish(inputs);
    const changed = publisher.publish([
      backend("ce", "ce", [tool("ce.status", true), tool("ce.threads", true)], [
        "ce.status",
        "ce.threads",
      ]),
    ]);

    expect(first.generation).toBe(1);
    expect(equivalent).toBe(first);
    expect(changed.generation).toBe(2);
  });

  it("defaults unknown tools to mutation and lets annotations make policy stricter", () => {
    const snapshot = buildCatalog(
      [
        backend(
          "ce",
          "ce",
          [tool("ce.status", true), tool("ce.process", false)],
          ["ce.status", "ce.process"],
        ),
      ],
      1,
    );
    expect(snapshot.routes.get("ce.ce.status")?.safetyClass).toBe("read");
    expect(snapshot.routes.get("ce.ce.process")?.safetyClass).toBe("mutation");
  });

  it("rejects duplicate names and the reserved gateway type", () => {
    expect(() =>
      buildCatalog([backend("ce", "ce", [tool("ce.status", true), tool("ce.status", true)])], 1),
    ).toThrow(CatalogValidationError);
    expect(() => buildCatalog([backend("bad", "gateway", [tool("status", true)])], 1)).toThrow(
      /reserved/,
    );
  });
});

describe("canonical JSON", () => {
  it("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: [{ y: 2, x: 1 }, 3] })).toBe(
      '{"a":[{"x":1,"y":2},3],"z":1}',
    );
  });
});
