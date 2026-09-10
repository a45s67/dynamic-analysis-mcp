import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import type {
  BackendClient,
  DownstreamToolCall,
  DownstreamToolDefinition,
  DownstreamToolResult,
} from "../domain/types.js";
import { GATEWAY_VERSION } from "../version.js";

export interface McpBackendClientOptions {
  readonly backendId: string;
  readonly url: URL;
  readonly bearerToken: string;
}

export interface DownstreamServerInfo {
  readonly name: string;
  readonly version: string;
}

export class McpBackendClient implements BackendClient {
  readonly #client: Client;
  public readonly serverInfo: DownstreamServerInfo | undefined;

  private constructor(client: Client, serverInfo: DownstreamServerInfo | undefined) {
    this.#client = client;
    this.serverInfo = serverInfo;
  }

  public static async connect(options: McpBackendClientOptions): Promise<McpBackendClient> {
    const client = new Client({
      name: `dynamic-analysis-mcp-gateway/${options.backendId}`,
      version: GATEWAY_VERSION,
    });
    const transport = new StreamableHTTPClientTransport(options.url, {
      requestInit: {
        headers: { Authorization: `Bearer ${options.bearerToken}` },
        redirect: "error",
      },
    });
    await client.connect(transport);
    const serverInfo = client.getServerVersion();
    return new McpBackendClient(
      client,
      serverInfo === undefined
        ? undefined
        : { name: serverInfo.name, version: serverInfo.version },
    );
  }

  public async listTools(): Promise<readonly DownstreamToolDefinition[]> {
    const result = await this.#client.listTools();
    return structuredClone(result.tools) as unknown as readonly DownstreamToolDefinition[];
  }

  public async callTool(call: DownstreamToolCall): Promise<DownstreamToolResult> {
    const result = await this.#client.callTool({
      name: call.name,
      arguments: structuredClone(call.arguments),
    });
    return structuredClone(result) as unknown as DownstreamToolResult;
  }

  public async close(): Promise<void> {
    await this.#client.close();
  }
}
