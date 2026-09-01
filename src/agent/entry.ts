import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { startUserAgent } from "./protocol.js";
import type { RunningUserAgent } from "./protocol.js";

const TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;

interface AgentOptions {
  readonly pipeName: string;
  readonly tokenFile: string;
  readonly x64dbgRoot: string;
}

function parseAgentArgs(args: readonly string[]): AgentOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !["--pipe-name", "--agent-token-file", "--x64dbg-root"].includes(name) ||
      values.has(name)
    ) throw new Error("invalid user-agent arguments");
    values.set(name, value);
  }
  const pipeName = values.get("--pipe-name");
  const tokenFile = values.get("--agent-token-file");
  const x64dbgRoot = values.get("--x64dbg-root");
  if (pipeName === undefined || tokenFile === undefined || x64dbgRoot === undefined) {
    throw new Error("--pipe-name, --agent-token-file, and --x64dbg-root are required");
  }
  return { pipeName, tokenFile, x64dbgRoot };
}

async function boundedTokenFile(filename: string): Promise<string> {
  const absolute = path.resolve(filename);
  const metadata = await lstat(absolute).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) {
    throw new Error("agent token file must be a bounded non-symlink regular file");
  }
  let token = await readFile(absolute, "utf8");
  if (token.endsWith("\r\n")) token = token.slice(0, -2);
  else if (token.endsWith("\n")) token = token.slice(0, -1);
  if (!TOKEN_PATTERN.test(token) || Buffer.byteLength(token) !== token.length) {
    throw new Error("agent token file is invalid");
  }
  return token;
}

async function installedController(configuredRoot: string): Promise<{ root: string; command: string }> {
  const root = await realpath(path.resolve(configuredRoot));
  const candidates = [
    path.join(root, "release", "mcp", "x96dbg-mcp-control.exe"),
    path.join(root, "mcp", "x96dbg-mcp-control.exe"),
  ];
  for (const command of candidates) {
    const metadata = await lstat(command).catch(() => undefined);
    if (metadata?.isFile() === true && !metadata.isSymbolicLink()) return { root, command };
  }
  throw new Error("x64dbg MCP host controller is unavailable");
}

export async function startConfiguredUserAgent(args: readonly string[]): Promise<RunningUserAgent> {
  const options = parseAgentArgs(args);
  const [token, controller] = await Promise.all([
    boundedTokenFile(options.tokenFile),
    installedController(options.x64dbgRoot),
  ]);
  return startUserAgent({
    pipeName: options.pipeName,
    token,
    controllers: {
      x32dbg: { command: controller.command, args: ["--backend", "x32", "--root", controller.root] },
      x64dbg: { command: controller.command, args: ["--backend", "x64", "--root", controller.root] },
    },
    timeoutMs: 60_000,
  });
}
