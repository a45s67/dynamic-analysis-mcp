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

export class McpBackendClient implements BackendClient {
  readonly #client: Client;

  private constructor(client: Client) {
    this.#client = client;
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
    return new McpBackendClient(client);
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
