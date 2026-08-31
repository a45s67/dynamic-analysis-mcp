import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Server } from "@modelcontextprotocol/server";

export interface GatewayHttpOptions {
  readonly host: string;
  readonly port: number;
  readonly path: "/mcp";
  readonly bearerToken: string;
  readonly mcpServer: Server;
}

export interface RunningGatewayHttpServer {
  readonly url: URL;
  close(): Promise<void>;
}

function authorized(header: string | undefined, expectedToken: string): boolean {
  const prefix = "Bearer ";
  const suppliedToken = header?.startsWith(prefix) === true ? header.slice(prefix.length) : "";
  const supplied = Buffer.from(suppliedToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (supplied.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(supplied, expected);
}

export async function startGatewayHttp(
  options: GatewayHttpOptions,
): Promise<RunningGatewayHttpServer> {
  if (options.bearerToken.length < 32) {
    throw new Error("Gateway bearer token must contain at least 32 characters");
  }

  const server = createServer(async (request, response) => {
    try {
      const requestPath = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
      if (requestPath !== options.path) {
        response.writeHead(404).end();
        return;
      }
      const authorization = Array.isArray(request.headers.authorization)
        ? request.headers.authorization[0]
        : request.headers.authorization;
      if (!authorized(authorization, options.bearerToken)) {
        response.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "www-authenticate": "Bearer",
        });
        response.end('{"code":"UNAUTHENTICATED"}');
        return;
      }

      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await options.mcpServer.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      }
      response.end('{"code":"INTERNAL_ERROR"}');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: new URL(`http://${options.host}:${address.port}${options.path}`),
    close: async () => {
      await options.mcpServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

