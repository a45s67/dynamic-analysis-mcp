import path from "node:path";

import { startConfiguredUserAgent } from "./agent/entry.js";
import { GatewayRuntime } from "./app/runtime.js";
import { loadGatewayConfig } from "./config/loader.js";
import { GATEWAY_VERSION } from "./version.js";

interface CliOptions {
  readonly configFile: string;
  readonly checkConfig: boolean;
  readonly showVersion: boolean;
}

function defaultConfigFile(): string {
  const programData = process.env.ProgramData;
  if (process.platform === "win32" && programData !== undefined && programData !== "") {
    return path.join(programData, "DynamicAnalysisMcpGateway", "gateway.toml");
  }
  return path.resolve("gateway.toml");
}

function parseArgs(argumentsValue: readonly string[]): CliOptions {
  let configFile = defaultConfigFile();
  let checkConfig = false;
  let showVersion = false;
  for (let index = 0; index < argumentsValue.length; index += 1) {
    const argument = argumentsValue[index];
    if (argument === "--check-config") {
      checkConfig = true;
      continue;
    }
    if (argument === "--version") {
      showVersion = true;
      continue;
    }
    if (argument === "--config") {
      const value = argumentsValue[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--config requires a path");
      }
      configFile = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument '${argument}'`);
  }
  return { configFile, checkConfig, showVersion };
}

async function main(): Promise<void> {
  if (process.argv[2] === "--user-agent") {
    const agent = await startConfiguredUserAgent(process.argv.slice(3));
    process.stdout.write("interactive user agent ready\n");
    let closing = false;
    const closeAgent = (): void => {
      if (closing) return;
      closing = true;
      void agent.close().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.once("SIGINT", closeAgent);
    process.once("SIGTERM", closeAgent);
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  if (options.showVersion) {
    process.stdout.write(`dynamic-analysis-mcp-gateway ${GATEWAY_VERSION}\n`);
    return;
  }
  const config = await loadGatewayConfig(options.configFile);
  if (options.checkConfig) {
    process.stdout.write("configuration valid\n");
    return;
  }

  const runtime = new GatewayRuntime(config);
  const server = await runtime.start();
  process.stdout.write(`gateway listening on ${server.url.origin}/mcp\n`);
  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void runtime
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "startup failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
