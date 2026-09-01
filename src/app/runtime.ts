import { randomUUID } from "node:crypto";

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";

import { McpBackendClient } from "../backend/mcp-client.js";
import { runLifecycleCommand } from "../backend/lifecycle.js";
import { CatalogPublisher } from "../catalog/catalog.js";
import type { ResolvedGatewayConfig } from "../config/loader.js";
import type {
  BackendClient,
  BackendCatalogInput,
  DownstreamToolDefinition,
  GatewayCallResult,
  JsonValue,
} from "../domain/types.js";
import { ToolRouter } from "../router/router.js";
import type { ArgumentValidator, ManagementToolHandler } from "../router/router.js";
import { startGatewayHttp } from "../server/http.js";
import type { RunningGatewayHttpServer } from "../server/http.js";
import { createGatewayMcpServer } from "../server/mcp-adapter.js";

interface BackendRuntimeState {
  readonly id: string;
  readonly type: string;
  readonly state: "disabled" | "offline" | "ready";
  readonly toolCount: number;
  readonly diagnosticCode?: "CONNECT_FAILED";
}

function success(value: JsonValue): GatewayCallResult {
  return {
    ok: true,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    },
  };
}

class PublishedSchemaValidator implements ArgumentValidator {
  readonly #provider = new AjvJsonSchemaValidator();

  public validate(
    schema: JsonValue,
    argumentsValue: Readonly<Record<string, JsonValue>>,
  ): { readonly valid: true } | { readonly valid: false; readonly message: string } {
    try {
      const validator = this.#provider.getValidator(schema as Record<string, unknown>);
      const result = validator(argumentsValue);
      return result.valid
        ? { valid: true }
        : { valid: false, message: result.errorMessage ?? "arguments do not match schema" };
    } catch {
      return { valid: false, message: "published input schema could not be evaluated" };
    }
  }
}

export class GatewayRuntime {
  readonly #config: ResolvedGatewayConfig;
  readonly #publisher = new CatalogPublisher();
  readonly #clients = new Map<string, BackendClient>();
  readonly #backendStates = new Map<string, BackendRuntimeState>();
  readonly #startedAt = Date.now();
  #refreshPromise: Promise<void> | undefined;
  readonly #activeLifecycle = new Set<string>();
  readonly #restartOperations = new Map<
    string,
    { readonly fingerprint: string; result?: GatewayCallResult }
  >();
  #http: RunningGatewayHttpServer | undefined;

  public constructor(config: ResolvedGatewayConfig) {
    this.#config = config;
    for (const backend of config.backends) {
      this.#backendStates.set(backend.id, {
        id: backend.id,
        type: backend.type,
        state: backend.enabled ? "offline" : "disabled",
        toolCount: 0,
      });
    }
  }

  public async start(): Promise<RunningGatewayHttpServer> {
    if (this.#config.server.tls.mode !== "proxy") {
      throw new Error("direct TLS listener support is not implemented yet");
    }
    await this.refresh();
    const management: ManagementToolHandler = {
      call: async (route, argumentsValue, captured, traceId) => {
        switch (route.managementName) {
          case "gateway.debugger_restart": {
            const keys = Object.keys(argumentsValue);
            const backendId = argumentsValue.backendId;
            const expectedInstanceId = argumentsValue.expectedInstanceId;
            const operationId = argumentsValue.operationId;
            const force = argumentsValue.force ?? false;
            const validBackend = backendId === "x32dbg" || backendId === "x64dbg";
            const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
            const validKeys = keys.every(
              (key) =>
                key === "backendId" ||
                key === "expectedInstanceId" ||
                key === "operationId" ||
                key === "force",
            );
            if (
              !validBackend ||
              typeof expectedInstanceId !== "string" ||
              !uuid.test(expectedInstanceId) ||
              typeof operationId !== "string" ||
              !uuid.test(operationId) ||
              typeof force !== "boolean" ||
              !validKeys
            ) {
              return {
                ok: false,
                error: {
                  code: "INVALID_TOOL_ARGUMENTS",
                  message:
                    "backendId, expectedInstanceId, operationId, and optional force do not match the closed schema",
                  catalogGeneration: captured.generation,
                  retryable: false,
                  safeToRetry: false,
                  dispatchStarted: false,
                  traceId,
                },
              };
            }
            const fingerprint = JSON.stringify({ backendId, expectedInstanceId, force });
            const recorded = this.#restartOperations.get(operationId);
            if (recorded !== undefined) {
              if (recorded.fingerprint !== fingerprint) {
                return {
                  ok: false,
                  error: {
                    code: "OPERATION_ID_CONFLICT",
                    message: "operationId was already used with different restart arguments",
                    backend: backendId,
                    catalogGeneration: captured.generation,
                    retryable: false,
                    safeToRetry: false,
                    dispatchStarted: false,
                    traceId,
                  },
                };
              }
              if (recorded.result !== undefined) return recorded.result;
              return {
                ok: false,
                error: {
                  code: "BACKEND_CONTROL_BUSY",
                  message: "this restart operation is already in flight",
                  backend: backendId,
                  catalogGeneration: captured.generation,
                  retryable: true,
                  safeToRetry: true,
                  dispatchStarted: false,
                  traceId,
                },
              };
            }
            if (this.#restartOperations.size >= 128) {
              return {
                ok: false,
                error: {
                  code: "BACKEND_CONTROL_BUSY",
                  message: "restart operation ledger is full",
                  backend: backendId,
                  catalogGeneration: captured.generation,
                  retryable: true,
                  safeToRetry: true,
                  dispatchStarted: false,
                  traceId,
                },
              };
            }
            const backend = this.#config.backends.find(({ id }) => id === backendId);
            if (backend?.enabled !== true || backend.lifecycle === undefined) {
              return {
                ok: false,
                error: {
                  code: "BACKEND_CONTROL_FAILED",
                  message: "backend lifecycle control is not configured and enabled",
                  backend: backendId,
                  catalogGeneration: captured.generation,
                  retryable: false,
                  safeToRetry: false,
                  dispatchStarted: false,
                  traceId,
                },
              };
            }
            if (this.#activeLifecycle.has(backendId)) {
              return {
                ok: false,
                error: {
                  code: "BACKEND_CONTROL_BUSY",
                  message: "another lifecycle operation is active for this backend",
                  backend: backendId,
                  catalogGeneration: captured.generation,
                  retryable: false,
                  safeToRetry: false,
                  dispatchStarted: false,
                  traceId,
                },
              };
            }
            this.#restartOperations.set(operationId, { fingerprint });
            this.#activeLifecycle.add(backendId);
            let result: GatewayCallResult;
            const restartTimeoutMs = Math.max(
              30_000,
              Math.min(50_000, this.#config.limits.defaultToolTimeoutMs * 2),
            );
            try {
              const status = await runLifecycleCommand(
                backend.lifecycle.command,
                backend.lifecycle.args,
                "status",
                false,
                Math.min(5_000, restartTimeoutMs),
              );
              if (!status.ok) {
                result = {
                  ok: false,
                  error: {
                    code: "BACKEND_CONTROL_FAILED",
                    message: status.message,
                    backend: backendId,
                    catalogGeneration: captured.generation,
                    retryable: true,
                    safeToRetry: true,
                    dispatchStarted: status.dispatchStarted,
                    traceId,
                  },
                };
              } else if (status.value.instance_id !== expectedInstanceId) {
                result = {
                  ok: false,
                  error: {
                    code: "BACKEND_INSTANCE_CHANGED",
                    message: "backend instance changed; restart was not dispatched",
                    backend: backendId,
                    catalogGeneration: captured.generation,
                    retryable: false,
                    safeToRetry: false,
                    dispatchStarted: false,
                    traceId,
                  },
                };
              } else {
                if (status.value.debuggee_state !== "absent" && !force) {
                  result = {
                    ok: false,
                    error: {
                      code: "BACKEND_CONTROL_FAILED",
                      message: "debuggee is active or unobservable; explicit force is required",
                      backend: backendId,
                      catalogGeneration: captured.generation,
                      retryable: false,
                      safeToRetry: false,
                      dispatchStarted: false,
                      traceId,
                    },
                  };
                } else {
                  const execution = await runLifecycleCommand(
                    backend.lifecycle.command,
                    backend.lifecycle.args,
                    "restart",
                    true,
                    restartTimeoutMs,
                  );
                  if (!execution.ok) {
                    const reconciled = execution.outcomeUnknown
                      ? await runLifecycleCommand(
                          backend.lifecycle.command,
                          backend.lifecycle.args,
                          "status",
                          false,
                          5_000,
                        )
                      : undefined;
                    if (
                      reconciled?.ok === true &&
                      reconciled.value.mcp_state === "ready" &&
                      typeof reconciled.value.instance_id === "string" &&
                      reconciled.value.instance_id !== expectedInstanceId
                    ) {
                      await this.refresh();
                      result = success({
                        backendId,
                        operationId,
                        previousInstanceId: expectedInstanceId,
                        previousProcessId: null,
                        processId: reconciled.value.process_id ?? null,
                        instanceId: reconciled.value.instance_id,
                        outcomeReconciled: true,
                        catalogGeneration: this.#publisher.current().generation,
                        traceId,
                      });
                    } else {
                      result = {
                        ok: false,
                        error: {
                          code: execution.outcomeUnknown
                            ? "OUTCOME_UNKNOWN"
                            : "BACKEND_CONTROL_FAILED",
                          message: execution.message,
                          backend: backendId,
                          catalogGeneration: captured.generation,
                          retryable: false,
                          safeToRetry: false,
                          dispatchStarted: execution.dispatchStarted,
                          traceId,
                        },
                      };
                    }
                  } else {
                    await this.refresh();
                    result = success({
                      backendId,
                      operationId,
                      previousInstanceId: expectedInstanceId,
                      previousProcessId: execution.value.previous_process_id ?? null,
                      processId: execution.value.process_id ?? null,
                      instanceId: execution.value.instance_id ?? null,
                      catalogGeneration: this.#publisher.current().generation,
                      traceId,
                    });
                  }
                }
              }
            } catch {
              result = {
                ok: false,
                error: {
                  code: "INTERNAL_ERROR",
                  message: "restart orchestration failed",
                  backend: backendId,
                  catalogGeneration: captured.generation,
                  retryable: false,
                  safeToRetry: false,
                  dispatchStarted: true,
                  traceId,
                },
              };
            } finally {
              this.#activeLifecycle.delete(backendId);
            }
            const operation = this.#restartOperations.get(operationId);
            if (operation !== undefined) operation.result = result!;
            return result!;
          }
          case "gateway.backends":
            return success({
              backends: [...this.#backendStates.values()].map((backend) => ({
                id: backend.id,
                type: backend.type,
                state: backend.state,
                toolCount: backend.toolCount,
                ...(backend.diagnosticCode === undefined
                  ? {}
                  : { diagnosticCode: backend.diagnosticCode }),
              })),
              catalogGeneration: captured.generation,
              traceId,
            });
          case "gateway.status":
            return success({
              version: "0.0.0",
              uptimeMs: Date.now() - this.#startedAt,
              catalogGeneration: captured.generation,
              catalogHash: captured.hash,
              toolCount: captured.tools.length,
              traceId,
            });
          case "gateway.refresh": {
            const requestedBackend = argumentsValue.backendId;
            if (requestedBackend !== undefined && typeof requestedBackend !== "string") {
              return {
                ok: false,
                error: {
                  code: "INVALID_TOOL_ARGUMENTS",
                  message: "backendId must be a string",
                  catalogGeneration: captured.generation,
                  retryable: false,
                  safeToRetry: false,
                  dispatchStarted: false,
                  traceId,
                },
              };
            }
            await this.refresh();
            return success({
              refreshId: randomUUID(),
              catalogGeneration: this.#publisher.current().generation,
              requestedBackend: requestedBackend ?? null,
              traceId,
            });
          }
        }
      },
    };
    const router = new ToolRouter({
      clients: this.#clients,
      validator: new PublishedSchemaValidator(),
      management,
      traceIds: { next: () => randomUUID() },
    });
    const mcpServer = createGatewayMcpServer(this.#publisher, router);
    this.#http = await startGatewayHttp({
      host: this.#config.server.bind,
      port: this.#config.server.port,
      path: this.#config.server.path,
      bearerToken: this.#config.server.bearerToken,
      mcpServer,
    });
    return this.#http;
  }

  public refresh(): Promise<void> {
    if (this.#refreshPromise !== undefined) {
      return this.#refreshPromise;
    }
    const refresh = this.#performRefresh().finally(() => {
      this.#refreshPromise = undefined;
    });
    this.#refreshPromise = refresh;
    return refresh;
  }

  async #performRefresh(): Promise<void> {
    const nextClients = new Map<string, McpBackendClient>();
    const catalogs: BackendCatalogInput[] = [];
    await Promise.all(
      this.#config.backends.map(async (backend) => {
        if (!backend.enabled) {
          this.#backendStates.set(backend.id, {
            id: backend.id,
            type: backend.type,
            state: "disabled",
            toolCount: 0,
          });
          return;
        }
        try {
          const client = await McpBackendClient.connect({
            backendId: backend.id,
            url: backend.url,
            bearerToken: backend.bearerToken,
          });
          const tools: readonly DownstreamToolDefinition[] = await client.listTools();
          nextClients.set(backend.id, client);
          catalogs.push({
            backendId: backend.id,
            backendType: backend.type,
            tools,
            readOnlyTools: backend.readOnlyTools,
            mutationTools: backend.mutationTools,
          });
          this.#backendStates.set(backend.id, {
            id: backend.id,
            type: backend.type,
            state: "ready",
            toolCount: tools.length,
          });
        } catch {
          this.#backendStates.set(backend.id, {
            id: backend.id,
            type: backend.type,
            state: "offline",
            toolCount: 0,
            diagnosticCode: "CONNECT_FAILED",
          });
        }
      }),
    );
    catalogs.sort((left, right) =>
      left.backendType < right.backendType ? -1 : left.backendType > right.backendType ? 1 : 0,
    );
    this.#publisher.publish(catalogs);
    const previousClients = [...this.#clients.values()];
    this.#clients.clear();
    for (const [backendId, client] of nextClients) {
      this.#clients.set(backendId, client);
    }
    await Promise.all(
      previousClients.map(async (client) => {
        if (client instanceof McpBackendClient) {
          await client.close();
        }
      }),
    );
  }

  public async close(): Promise<void> {
    if (this.#http !== undefined) {
      await this.#http.close();
      this.#http = undefined;
    }
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(
      clients.map(async (client) => {
        if (client instanceof McpBackendClient) {
          await client.close();
        }
      }),
    );
  }
}
