import { randomUUID } from "node:crypto";

import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";

import { McpBackendClient } from "../backend/mcp-client.js";
import { runLifecycleCommand } from "../backend/lifecycle.js";
import type { LifecycleAction } from "../backend/lifecycle.js";
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
          case "gateway.backend_control": {
            const keys = Object.keys(argumentsValue);
            const backendId = argumentsValue.backendId;
            const action = argumentsValue.action;
            const force = argumentsValue.force ?? false;
            const validBackend = backendId === "x32dbg" || backendId === "x64dbg";
            const validAction =
              action === "status" ||
              action === "start" ||
              action === "stop" ||
              action === "restart";
            const validKeys = keys.every(
              (key) => key === "backendId" || key === "action" || key === "force",
            );
            if (
              !validBackend ||
              !validAction ||
              typeof force !== "boolean" ||
              !validKeys ||
              (force && action !== "stop" && action !== "restart")
            ) {
              return {
                ok: false,
                error: {
                  code: "INVALID_TOOL_ARGUMENTS",
                  message: "backendId, action, and optional force do not match the closed schema",
                  catalogGeneration: captured.generation,
                  retryable: false,
                  safeToRetry: false,
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
            this.#activeLifecycle.add(backendId);
            try {
              const execution = await runLifecycleCommand(
                backend.lifecycle.command,
                backend.lifecycle.args,
                action as LifecycleAction,
                force,
                Math.max(1_000, Math.min(60_000, this.#config.limits.defaultToolTimeoutMs)),
              );
              if (!execution.ok) {
                const readOnly = action === "status";
                return {
                  ok: false,
                  error: {
                    code:
                      execution.outcomeUnknown && !readOnly
                        ? "OUTCOME_UNKNOWN"
                        : "BACKEND_CONTROL_FAILED",
                    message: execution.message,
                    backend: backendId,
                    catalogGeneration: captured.generation,
                    retryable: readOnly,
                    safeToRetry: readOnly,
                    dispatchStarted: execution.dispatchStarted,
                    traceId,
                  },
                };
              }
              if (action !== "status") await this.refresh();
              return success({
                backendId,
                action,
                controller: execution.value,
                catalogGeneration: this.#publisher.current().generation,
                traceId,
              });
            } finally {
              this.#activeLifecycle.delete(backendId);
            }
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
