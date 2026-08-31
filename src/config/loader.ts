import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";

import { GatewayConfigFileSchema } from "./schema.js";
import type { GatewayConfigFile } from "./schema.js";

const MAX_CONFIG_BYTES = 1_048_576;
const TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface ResolvedBackendConfig {
  readonly id: "ce" | "x32dbg" | "x64dbg";
  readonly type: "ce" | "x32dbg" | "x64dbg";
  readonly enabled: boolean;
  readonly url: URL;
  readonly bearerToken: string;
  readonly readOnlyTools: ReadonlySet<string>;
  readonly mutationTools: ReadonlySet<string>;
}

export interface ResolvedGatewayConfig {
  readonly sourceFile: string;
  readonly server: Omit<GatewayConfigFile["server"], "tokenEnv"> & {
    readonly bearerToken: string;
  };
  readonly backends: readonly ResolvedBackendConfig[];
  readonly discovery: GatewayConfigFile["discovery"];
  readonly limits: GatewayConfigFile["limits"];
  readonly naming: GatewayConfigFile["naming"];
}

async function readBoundedRegularFile(
  filename: string,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  let metadata;
  try {
    metadata = await lstat(filename);
  } catch {
    throw new ConfigurationError(`${label} is unavailable`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumBytes) {
    throw new ConfigurationError(`${label} must be a bounded regular file`);
  }
  try {
    const value = await readFile(filename);
    if (value.byteLength > maximumBytes) {
      throw new ConfigurationError(`${label} exceeds its size limit`);
    }
    return value;
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(`${label} cannot be read`);
  }
}

function resolveToken(environmentName: string, label: string): string {
  const token = process.env[environmentName];
  if (token === undefined) {
    throw new ConfigurationError(`${label} token environment variable is unavailable`);
  }
  if (!TOKEN_PATTERN.test(token) || Buffer.byteLength(token, "utf8") !== token.length) {
    throw new ConfigurationError(
      `${label} token environment variable must contain 32..512 visible ASCII characters`,
    );
  }
  return token;
}

function formatSchemaFailure(issues: readonly { readonly path: PropertyKey[] }[]): string {
  const paths = [...new Set(issues.map(({ path: issuePath }) => issuePath.join(".")))];
  return `configuration validation failed at: ${paths.join(", ")}`;
}

export async function loadGatewayConfig(configFile: string): Promise<ResolvedGatewayConfig> {
  const absoluteConfigFile = path.resolve(configFile);
  const configBytes = await readBoundedRegularFile(
    absoluteConfigFile,
    MAX_CONFIG_BYTES,
    "configuration file",
  );
  let document: unknown;
  try {
    document = parse(configBytes.toString("utf8"));
  } catch {
    throw new ConfigurationError("configuration TOML is invalid");
  }
  const parsed = GatewayConfigFileSchema.safeParse(document);
  if (!parsed.success) {
    throw new ConfigurationError(formatSchemaFailure(parsed.error.issues));
  }

  const serverToken = resolveToken(parsed.data.server.tokenEnv, "server");
  const backendTypes = ["x64dbg", "x32dbg", "ce"] as const;
  const backends = await Promise.all(
    backendTypes.map(async (backendType): Promise<ResolvedBackendConfig> => {
      const backend = parsed.data[backendType];
      const bearerToken = resolveToken(backend.tokenEnv, backendType);
      return Object.freeze({
        id: backendType,
        type: backendType,
        enabled: backend.enabled,
        url: new URL(backend.url),
        bearerToken,
        readOnlyTools: new Set(backend.safety.readOnlyTools),
        mutationTools: new Set(backend.safety.mutationTools),
      });
    }),
  );
  const { tokenEnv: _tokenEnv, ...serverWithoutTokenEnv } = parsed.data.server;
  return Object.freeze({
    sourceFile: absoluteConfigFile,
    server: Object.freeze({ ...serverWithoutTokenEnv, bearerToken: serverToken }),
    backends: Object.freeze(backends),
    discovery: Object.freeze(parsed.data.discovery),
    limits: Object.freeze(parsed.data.limits),
    naming: Object.freeze(parsed.data.naming),
  });
}
