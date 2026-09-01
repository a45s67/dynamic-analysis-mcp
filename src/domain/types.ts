export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface DownstreamToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonValue;
  readonly outputSchema?: JsonValue;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}

export interface PublicToolDefinition extends DownstreamToolDefinition {
  readonly name: string;
}

export type SafetyClass = "read" | "mutation";

export interface BackendToolRoute {
  readonly routeKind: "backend";
  readonly backendId: string;
  readonly backendType: string;
  readonly downstreamName: string;
  readonly safetyClass: SafetyClass;
}

export interface ManagementToolRoute {
  readonly routeKind: "management";
  readonly managementName:
    | "gateway.backend_control"
    | "gateway.debugger_restart"
    | "gateway.backends"
    | "gateway.refresh"
    | "gateway.status";
  readonly safetyClass: SafetyClass;
}

export type ToolRoute = BackendToolRoute | ManagementToolRoute;

export interface CatalogSnapshot {
  readonly generation: number;
  readonly hash: string;
  readonly tools: readonly PublicToolDefinition[];
  readonly routes: ReadonlyMap<string, ToolRoute>;
}

export interface BackendCatalogInput {
  readonly backendId: string;
  readonly backendType: string;
  readonly tools: readonly DownstreamToolDefinition[];
  readonly readOnlyTools: ReadonlySet<string>;
  readonly mutationTools: ReadonlySet<string>;
}

export interface DownstreamToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

export interface DownstreamToolResult {
  readonly content: readonly JsonValue[];
  readonly structuredContent?: JsonValue;
  readonly isError?: boolean;
  readonly _meta?: Readonly<Record<string, JsonValue>>;
}

export interface BackendClient {
  callTool(call: DownstreamToolCall): Promise<DownstreamToolResult>;
}

export interface GatewayToolError {
  readonly code:
    | "BACKEND_UNAVAILABLE"
    | "BACKEND_CONTROL_BUSY"
    | "BACKEND_CONTROL_FAILED"
    | "BACKEND_INSTANCE_CHANGED"
    | "OPERATION_ID_CONFLICT"
    | "INTERNAL_ERROR"
    | "INVALID_TOOL_ARGUMENTS"
    | "OUTCOME_UNKNOWN"
    | "TOOL_NOT_FOUND"
    | "USER_SESSION_UNAVAILABLE";
  readonly message: string;
  readonly backend?: string;
  readonly catalogGeneration: number;
  readonly retryable: boolean;
  readonly safeToRetry: boolean;
  readonly dispatchStarted: boolean;
  readonly traceId: string;
}

export type GatewayCallResult =
  | { readonly ok: true; readonly result: DownstreamToolResult }
  | { readonly ok: false; readonly error: GatewayToolError };
