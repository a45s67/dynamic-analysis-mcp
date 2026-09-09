import type {
  BackendClient,
  CatalogSnapshot,
  GatewayCallResult,
  GatewayToolError,
  JsonValue,
  ManagementToolRoute,
} from "../domain/types.js";

export interface ArgumentValidator {
  validate(
    schema: JsonValue,
    argumentsValue: Readonly<Record<string, JsonValue>>,
  ): { readonly valid: true } | { readonly valid: false; readonly message: string };
}

export interface ManagementToolHandler {
  call(
    route: ManagementToolRoute,
    argumentsValue: Readonly<Record<string, JsonValue>>,
    snapshot: CatalogSnapshot,
    traceId: string,
  ): Promise<GatewayCallResult>;
}

export interface TraceIdSource {
  next(): string;
}

export class DownstreamTransportError extends Error {
  public readonly dispatchStarted: boolean;

  public constructor(message: string, dispatchStarted: boolean) {
    super(message);
    this.name = "DownstreamTransportError";
    this.dispatchStarted = dispatchStarted;
  }
}

export interface ToolRouterOptions {
  readonly clients: ReadonlyMap<string, BackendClient>;
  readonly validator: ArgumentValidator;
  readonly management: ManagementToolHandler;
  readonly traceIds: TraceIdSource;
  readonly maxConcurrentCalls?: number;
}

/** Session execution lifetime is independent of its HTTP responses/transport. */
export class ToolExecutionScope {
  #active = 0;
  #closed = false;

  public reserve(): (() => void) | undefined {
    if (this.#closed || this.#active >= 8) return undefined;
    this.#active++;
    let released = false;
    return () => {
      if (!released) { released = true; this.#active--; }
    };
  }

  public close(): void {
    // Closing prevents new work; it does not cancel or release dispatched work.
    this.#closed = true;
  }
}

function failure(error: GatewayToolError): GatewayCallResult {
  return { ok: false, error: Object.freeze(error) };
}

function unavailable(
  snapshot: CatalogSnapshot,
  traceId: string,
  backend: string,
  safeToRetry: boolean,
  dispatchStarted: boolean,
): GatewayCallResult {
  return failure({
    code: dispatchStarted && !safeToRetry ? "OUTCOME_UNKNOWN" : "BACKEND_UNAVAILABLE",
    message:
      dispatchStarted && !safeToRetry
        ? "backend response was lost after mutation dispatch; outcome is unknown"
        : "backend is unavailable",
    backend,
    catalogGeneration: snapshot.generation,
    retryable: safeToRetry,
    safeToRetry,
    dispatchStarted,
    traceId,
  });
}

export class ToolRouter {
  readonly #clients: ReadonlyMap<string, BackendClient>;
  readonly #validator: ArgumentValidator;
  readonly #management: ManagementToolHandler;
  readonly #traceIds: TraceIdSource;
  readonly #maxConcurrentCalls: number;
  #activeCalls = 0;

  public constructor(options: ToolRouterOptions) {
    this.#clients = options.clients;
    this.#validator = options.validator;
    this.#management = options.management;
    this.#traceIds = options.traceIds;
    this.#maxConcurrentCalls = options.maxConcurrentCalls ?? 32;
    if (!Number.isSafeInteger(this.#maxConcurrentCalls) || this.#maxConcurrentCalls < 1 || this.#maxConcurrentCalls > 1024) {
      throw new Error("Invalid tool execution limit");
    }
  }

  public async call(
    snapshot: CatalogSnapshot,
    publicName: string,
    argumentsValue: Readonly<Record<string, JsonValue>>,
    scope?: ToolExecutionScope,
  ): Promise<GatewayCallResult> {
    const traceId = this.#traceIds.next();
    const capacity = (): GatewayCallResult => failure({
      code: "EXECUTION_CAPACITY",
      message: "tool execution capacity unavailable; this request was not dispatched",
      catalogGeneration: snapshot.generation,
      retryable: false,
      safeToRetry: false,
      dispatchStarted: false,
      traceId,
    });
    if (this.#activeCalls >= this.#maxConcurrentCalls) return capacity();
    const release = scope?.reserve();
    if (scope !== undefined && release === undefined) return capacity();
    // No await between admission and reservation. This router is shared by all
    // sessions, including those reinitialized while detached calls still run.
    this.#activeCalls++;
    try {
      return await this.#dispatch(snapshot, publicName, argumentsValue, traceId);
    } finally {
      this.#activeCalls--;
      release?.();
    }
  }

  async #dispatch(
    snapshot: CatalogSnapshot,
    publicName: string,
    argumentsValue: Readonly<Record<string, JsonValue>>,
    traceId: string,
  ): Promise<GatewayCallResult> {
    const route = snapshot.routes.get(publicName);
    if (route === undefined) {
      return failure({
        code: "TOOL_NOT_FOUND",
        message: `tool '${publicName}' is not present in the captured catalog`,
        catalogGeneration: snapshot.generation,
        retryable: false,
        safeToRetry: false,
        dispatchStarted: false,
        traceId,
      });
    }
    if (route.routeKind === "management") {
      return this.#management.call(route, argumentsValue, snapshot, traceId);
    }

    const definition = snapshot.tools.find(({ name }) => name === publicName);
    if (definition === undefined) {
      return failure({
        code: "INTERNAL_ERROR",
        message: "captured catalog route has no matching definition",
        backend: route.backendType,
        catalogGeneration: snapshot.generation,
        retryable: false,
        safeToRetry: false,
        dispatchStarted: false,
        traceId,
      });
    }
    const validation = this.#validator.validate(definition.inputSchema, argumentsValue);
    if (!validation.valid) {
      return failure({
        code: "INVALID_TOOL_ARGUMENTS",
        message: validation.message,
        backend: route.backendType,
        catalogGeneration: snapshot.generation,
        retryable: false,
        safeToRetry: false,
        dispatchStarted: false,
        traceId,
      });
    }

    const client = this.#clients.get(route.backendId);
    if (client === undefined) {
      return unavailable(
        snapshot,
        traceId,
        route.backendType,
        route.safetyClass === "read",
        false,
      );
    }

    try {
      const result = await client.callTool({
        name: route.downstreamName,
        arguments: argumentsValue,
      });
      return { ok: true, result };
    } catch (error: unknown) {
      if (error instanceof DownstreamTransportError) {
        return unavailable(
          snapshot,
          traceId,
          route.backendType,
          route.safetyClass === "read",
          error.dispatchStarted,
        );
      }
      return failure({
        code: "INTERNAL_ERROR",
        message: "unexpected downstream client failure",
        backend: route.backendType,
        catalogGeneration: snapshot.generation,
        retryable: false,
        safeToRetry: false,
        dispatchStarted: false,
        traceId,
      });
    }
  }
}
