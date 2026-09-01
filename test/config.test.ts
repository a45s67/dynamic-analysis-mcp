import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigurationError, loadGatewayConfig } from "../src/index.js";

const TOKENS = {
  gateway: "gateway-token-abcdefghijklmnopqrstuvwxyz-0123456789",
  x64dbg: "x64dbg-token-abcdefghijklmnopqrstuvwxyz-0123456789",
  x32dbg: "x32dbg-token-abcdefghijklmnopqrstuvwxyz-0123456789",
  ce: "ce-token-abcdefghijklmnopqrstuvwxyz-0123456789",
} as const;

let fixtureRoot: string;
const ENVIRONMENT = {
  DYNAMIC_ANALYSIS_MCP_TOKEN: TOKENS.gateway,
  X64DBG_MCP_TOKEN: TOKENS.x64dbg,
  X32DBG_MCP_TOKEN: TOKENS.x32dbg,
  CE_MCP_TOKEN: TOKENS.ce,
  DYNAMIC_ANALYSIS_AGENT_TOKEN: "agent-token-abcdefghijklmnopqrstuvwxyz-0123456789",
} as const;
const previousEnvironment = new Map<string, string | undefined>();

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "gateway-config-test-"));
  await cp(
    path.resolve("config/gateway.example.toml"),
    path.join(fixtureRoot, "gateway.toml"),
  );
  for (const [name, token] of Object.entries(ENVIRONMENT)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = token;
  }
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousEnvironment.clear();
});

describe("strict TOML configuration", () => {
  it("loads the example and resolves every token from the configured environment", async () => {
    const config = await loadGatewayConfig(path.join(fixtureRoot, "gateway.toml"));

    expect(config.server.bearerToken).toBe(TOKENS.gateway);
    expect(config.backends.map(({ id }) => id)).toEqual(["x64dbg", "x32dbg", "ce"]);
    expect(config.backends.find(({ id }) => id === "ce")?.bearerToken).toBe(TOKENS.ce);
    expect(config.backends.find(({ id }) => id === "x64dbg")?.url.href).toBe(
      "http://127.0.0.1:43164/mcp",
    );
    expect(config.backends.find(({ id }) => id === "ce")?.readOnlyTools.has("ce.status")).toBe(
      true,
    );
  });

  it("rejects unknown keys, including literal token and tokenFile", async () => {
    const filename = path.join(fixtureRoot, "gateway.toml");
    const original = await readFile(filename, "utf8");
    await writeFile(
      filename,
      original.replace(
        'tokenEnv = "DYNAMIC_ANALYSIS_MCP_TOKEN"',
        'tokenEnv = "DYNAMIC_ANALYSIS_MCP_TOKEN"\ntoken = "must-not-be-accepted"\ntokenFile = "secret.token"',
      ),
    );

    await expect(loadGatewayConfig(filename)).rejects.toThrow(/server/);
  });

  it("rejects a missing token environment variable", async () => {
    delete process.env.CE_MCP_TOKEN;
    await expect(loadGatewayConfig(path.join(fixtureRoot, "gateway.toml"))).rejects.toThrow(
      "ce token environment variable is unavailable",
    );
  });

  it("rejects non-loopback backend endpoints", async () => {
    const filename = path.join(fixtureRoot, "gateway.toml");
    const original = await readFile(filename, "utf8");
    await writeFile(filename, original.replace("127.0.0.1:43164", "10.20.0.25:43164"));

    await expect(loadGatewayConfig(filename)).rejects.toThrow(/x64dbg.url/);
  });

  it("accepts bearer-protected loopback local mode and rejects local mode on LAN", async () => {
    const filename = path.join(fixtureRoot, "gateway.toml");
    const original = await readFile(filename, "utf8");
    const local = original
      .replace('bind = "10.20.0.15"', 'bind = "127.0.0.1"')
      .replace('publicBaseUrl = "https://analysis-vm.example:8000"', 'publicBaseUrl = "http://127.0.0.1:8000"')
      .replace(/mode = "proxy"\r?\ntrustedProxyCidrs = \["10\.20\.0\.1\/32"\]/, 'mode = "local"');
    await writeFile(filename, local);
    await expect(loadGatewayConfig(filename)).resolves.toMatchObject({ server: { bind: "127.0.0.1" } });
    await writeFile(filename, local.replace('bind = "127.0.0.1"', 'bind = "10.20.0.15"'));
    await expect(loadGatewayConfig(filename)).rejects.toThrow(/server.bind/);
  });

  it("rejects overlapping safety lists", async () => {
    const filename = path.join(fixtureRoot, "gateway.toml");
    const original = await readFile(filename, "utf8");
    await writeFile(
      filename,
      original.replace(
        'mutationTools = ["debugger.resume", "debugger.pause", "memory.write"]',
        'mutationTools = ["debugger.state", "debugger.pause", "memory.write"]',
      ),
    );

    await expect(loadGatewayConfig(filename)).rejects.toThrow(/x64dbg.safety/);
  });

  it("rejects malformed environment tokens without exposing their value", async () => {
    const secret = "secret-value-that-must-never-appear";
    process.env.CE_MCP_TOKEN = `${secret}\nsecond-line`;

    let failure: unknown;
    try {
      await loadGatewayConfig(path.join(fixtureRoot, "gateway.toml"));
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect(String(failure)).not.toContain(secret);
    expect(String(failure)).toContain("32..512 visible ASCII");
  });

  it("loads flat lifecycle fields from an existing backend table", async () => {
    const filename = path.join(fixtureRoot, "gateway.toml");
    const controller = path.join(fixtureRoot, "controller.exe");
    await writeFile(controller, "fixture");
    const original = await readFile(filename, "utf8");
    const literalPath = controller.replaceAll("'", "''");
    await writeFile(
      filename,
      original.replace(
        'url = "http://127.0.0.1:43164/mcp"',
        `url = "http://127.0.0.1:43164/mcp"\nlifecycleCommand = '${literalPath}'\nlifecycleArgs = ['--backend', 'x64']`,
      ),
    );

    const config = await loadGatewayConfig(filename);
    expect(config.backends.find(({ id }) => id === "x64dbg")?.lifecycle).toEqual({
      command: controller,
      args: ["--backend", "x64"],
    });
  });

  it("loads a generated interactive user-agent endpoint", async () => {
    const filename = path.join(fixtureRoot, "gateway.toml");
    const original = await readFile(filename, "utf8");
    await writeFile(
      filename,
      `${original}\n[interactiveAgent]\npipeName = "dynamic-analysis-agent-test"\ntokenEnv = "DYNAMIC_ANALYSIS_AGENT_TOKEN"\n`,
    );
    const config = await loadGatewayConfig(filename);
    expect(config.interactiveAgent).toEqual({
      pipeName: "dynamic-analysis-agent-test",
      token: ENVIRONMENT.DYNAMIC_ANALYSIS_AGENT_TOKEN,
    });
  });

  it("rejects incomplete or relative lifecycle configuration", async () => {
    const filename = path.join(fixtureRoot, "gateway.toml");
    const original = await readFile(filename, "utf8");
    await writeFile(
      filename,
      original.replace(
        'url = "http://127.0.0.1:43164/mcp"',
        'url = "http://127.0.0.1:43164/mcp"\nlifecycleCommand = "controller.exe"',
      ),
    );
    await expect(loadGatewayConfig(filename)).rejects.toThrow(/x64dbg/);

    await writeFile(
      filename,
      original.replace(
        'url = "http://127.0.0.1:43164/mcp"',
        'url = "http://127.0.0.1:43164/mcp"\nlifecycleCommand = "controller.exe"\nlifecycleArgs = []',
      ),
    );
    await expect(loadGatewayConfig(filename)).rejects.toThrow(/must be absolute/);
  });
});
