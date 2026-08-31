import type {
  BackendCatalogInput,
  CatalogSnapshot,
  DownstreamToolDefinition,
  JsonValue,
  PublicToolDefinition,
  SafetyClass,
  ToolRoute,
} from "../domain/types.js";
import { sha256CanonicalJson } from "./canonical-json.js";

const BACKEND_SEGMENT = /^[a-z][a-z0-9_-]{0,31}$/;
const DOWNSTREAM_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_PUBLIC_NAME_LENGTH = 192;
const RESERVED_BACKEND_TYPE = "gateway";

const MANAGEMENT_TOOLS: readonly PublicToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "gateway.backends",
    description: "List configured backends and their sanitized discovery state.",
    inputSchema: Object.freeze({ type: "object", additionalProperties: false }),
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "gateway.refresh",
    description: "Schedule coalesced backend discovery.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        backendId: Object.freeze({ type: "string" }),
      }),
      additionalProperties: false,
    }),
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }),
  }),
  Object.freeze({
    name: "gateway.status",
    description: "Return sanitized Gateway health, catalog, and limit utilization.",
    inputSchema: Object.freeze({ type: "object", additionalProperties: false }),
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }),
  }),
]);

export class CatalogValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CatalogValidationError";
  }
}

function validateBackendSegment(kind: "id" | "type", value: string): void {
  if (!BACKEND_SEGMENT.test(value)) {
    throw new CatalogValidationError(`backend ${kind} is invalid`);
  }
  if (kind === "type" && value === RESERVED_BACKEND_TYPE) {
    throw new CatalogValidationError("backend type 'gateway' is reserved");
  }
}

function validateTool(tool: DownstreamToolDefinition): void {
  if (!DOWNSTREAM_TOOL_NAME.test(tool.name)) {
    throw new CatalogValidationError(`invalid downstream tool name '${tool.name}'`);
  }
  if (!isJsonObject(tool.inputSchema)) {
    throw new CatalogValidationError(`tool '${tool.name}' inputSchema must be an object`);
  }
  if (tool.outputSchema !== undefined && !isJsonObject(tool.outputSchema)) {
    throw new CatalogValidationError(`tool '${tool.name}' outputSchema must be an object`);
  }
}

function isJsonObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function classifySafety(input: BackendCatalogInput, tool: DownstreamToolDefinition): SafetyClass {
  if (input.mutationTools.has(tool.name)) {
    return "mutation";
  }
  if (input.readOnlyTools.has(tool.name)) {
    return tool.annotations?.readOnlyHint === false ? "mutation" : "read";
  }
  return "mutation";
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}

function cloneAndFreezeTool(tool: DownstreamToolDefinition, publicName: string): PublicToolDefinition {
  const clone = structuredClone({ ...tool, name: publicName }) as PublicToolDefinition;
  freezeJson(clone as unknown as JsonValue);
  return clone;
}

function catalogHashInput(tools: readonly PublicToolDefinition[]): JsonValue {
  return tools as unknown as JsonValue;
}

export function buildCatalog(
  backends: readonly BackendCatalogInput[],
  generation: number,
): CatalogSnapshot {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new CatalogValidationError("catalog generation must be a non-negative safe integer");
  }

  const backendIds = new Set<string>();
  const backendTypes = new Set<string>();
  const publicTools: PublicToolDefinition[] = [...MANAGEMENT_TOOLS];
  const routes = new Map<string, ToolRoute>();

  for (const tool of MANAGEMENT_TOOLS) {
    const managementName = tool.name as "gateway.backends" | "gateway.refresh" | "gateway.status";
    routes.set(
      managementName,
      Object.freeze({
        routeKind: "management",
        managementName,
        safetyClass: managementName === "gateway.refresh" ? "mutation" : "read",
      }),
    );
  }

  for (const backend of backends) {
    validateBackendSegment("id", backend.backendId);
    validateBackendSegment("type", backend.backendType);
    if (backendIds.has(backend.backendId)) {
      throw new CatalogValidationError(`duplicate backend id '${backend.backendId}'`);
    }
    if (backendTypes.has(backend.backendType)) {
      throw new CatalogValidationError(`duplicate backend type '${backend.backendType}'`);
    }
    backendIds.add(backend.backendId);
    backendTypes.add(backend.backendType);

    const downstreamNames = new Set<string>();
    for (const tool of backend.tools) {
      validateTool(tool);
      if (downstreamNames.has(tool.name)) {
        throw new CatalogValidationError(
          `backend '${backend.backendId}' published duplicate tool '${tool.name}'`,
        );
      }
      downstreamNames.add(tool.name);

      const publicName = `${backend.backendType}.${tool.name}`;
      if (publicName.length > MAX_PUBLIC_NAME_LENGTH) {
        throw new CatalogValidationError(`public tool name '${publicName}' is too long`);
      }
      if (routes.has(publicName)) {
        throw new CatalogValidationError(`public tool collision '${publicName}'`);
      }

      const safetyClass = classifySafety(backend, tool);
      publicTools.push(cloneAndFreezeTool(tool, publicName));
      routes.set(
        publicName,
        Object.freeze({
          routeKind: "backend",
          backendId: backend.backendId,
          backendType: backend.backendType,
          downstreamName: tool.name,
          safetyClass,
        }),
      );
    }
  }

  publicTools.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  Object.freeze(publicTools);
  const hash = sha256CanonicalJson(catalogHashInput(publicTools));
  return Object.freeze({
    generation,
    hash,
    tools: publicTools,
    routes: routes as ReadonlyMap<string, ToolRoute>,
  });
}

export class CatalogPublisher {
  #snapshot: CatalogSnapshot = buildCatalog([], 0);

  public current(): CatalogSnapshot {
    return this.#snapshot;
  }

  public publish(backends: readonly BackendCatalogInput[]): CatalogSnapshot {
    const candidate = buildCatalog(backends, this.#snapshot.generation + 1);
    if (candidate.hash === this.#snapshot.hash) {
      return this.#snapshot;
    }
    this.#snapshot = candidate;
    return candidate;
  }
}
