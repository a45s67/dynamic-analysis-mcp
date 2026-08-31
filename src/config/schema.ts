import { isIP } from "node:net";

import * as z from "zod/v4";

const boundedInteger = (minimum: number, maximum: number) =>
  z.number().int().min(minimum).max(maximum);

const SafetySchema = z
  .object({
    readOnlyTools: z.array(z.string().min(1).max(128)).max(500),
    mutationTools: z.array(z.string().min(1).max(128)).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    const readOnly = new Set(value.readOnlyTools);
    if (readOnly.size !== value.readOnlyTools.length) {
      context.addIssue({ code: "custom", message: "readOnlyTools contains duplicates" });
    }
    if (new Set(value.mutationTools).size !== value.mutationTools.length) {
      context.addIssue({ code: "custom", message: "mutationTools contains duplicates" });
    }
    for (const name of value.mutationTools) {
      if (readOnly.has(name)) {
        context.addIssue({ code: "custom", message: "safety lists overlap" });
        break;
      }
    }
  });

const TokenEnvSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z_][A-Z0-9_]*$/, "tokenEnv must be an uppercase environment variable name");

const BackendSchema = z
  .object({
    enabled: z.boolean(),
    url: z.url().max(2048),
    tokenEnv: TokenEnvSchema,
    safety: SafetySchema,
  })
  .strict();

const ProxyTlsSchema = z
  .object({
    mode: z.literal("proxy"),
    trustedProxyCidrs: z.array(z.string().min(3).max(64)).min(1).max(32),
  })
  .strict();

const DirectTlsSchema = z
  .object({
    mode: z.literal("direct"),
    certFile: z.string().min(1).max(260),
    keyFile: z.string().min(1).max(260),
  })
  .strict();

const ServerSchema = z
  .object({
    bind: z.string().min(1).max(64),
    port: boundedInteger(1, 65_535),
    path: z.literal("/mcp"),
    publicBaseUrl: z.url().max(2048),
    tokenEnv: TokenEnvSchema,
    tls: z.discriminatedUnion("mode", [ProxyTlsSchema, DirectTlsSchema]),
  })
  .strict();

export const GatewayConfigFileSchema = z
  .object({
    version: z.literal(1),
    server: ServerSchema,
    x64dbg: BackendSchema,
    x32dbg: BackendSchema,
    ce: BackendSchema,
    discovery: z
      .object({
        intervalMs: boundedInteger(500, 300_000),
        connectTimeoutMs: boundedInteger(100, 30_000),
        listTimeoutMs: boundedInteger(100, 120_000),
        stableSuccesses: boundedInteger(1, 10),
        stableFailures: boundedInteger(1, 10),
        jitterPercent: boundedInteger(0, 50),
      })
      .strict(),
    limits: z
      .object({
        requestBodyBytes: boundedInteger(1_024, 4_194_304),
        downstreamCatalogBytes: boundedInteger(1_024, 16_777_216),
        downstreamToolCount: boundedInteger(1, 5_000),
        downstreamToolDefinitionBytes: boundedInteger(1_024, 1_048_576),
        toolResultBytes: boundedInteger(1_024, 16_777_216),
        globalConcurrentCalls: boundedInteger(1, 1_024),
        perBackendConcurrentCalls: boundedInteger(1, 128),
        defaultToolTimeoutMs: boundedInteger(100, 300_000),
        refreshCooldownMs: boundedInteger(100, 60_000),
      })
      .strict(),
    naming: z.object({ mode: z.literal("dotted") }).strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (isIP(value.server.bind) === 0) {
      context.addIssue({ code: "custom", path: ["server", "bind"], message: "must be an IP" });
    }
    const normalizedBind = value.server.bind.toLowerCase();
    if (
      normalizedBind === "0.0.0.0" ||
      normalizedBind === "::" ||
      normalizedBind === "::1" ||
      normalizedBind.startsWith("127.")
    ) {
      context.addIssue({
        code: "custom",
        path: ["server", "bind"],
        message: "must be an explicit non-loopback management address",
      });
    }
    try {
      const publicBaseUrl = new URL(value.server.publicBaseUrl);
      if (publicBaseUrl.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          path: ["server", "publicBaseUrl"],
          message: "must use HTTPS",
        });
      }
    } catch {
      // z.url reports the primary issue.
    }
    for (const backendType of ["x64dbg", "x32dbg", "ce"] as const) {
      try {
        const url = new URL(value[backendType].url);
        const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
        if (
          url.protocol !== "http:" ||
          !allowedHosts.has(url.hostname.toLowerCase()) ||
          url.username !== "" ||
          url.password !== "" ||
          url.search !== "" ||
          url.hash !== "" ||
          url.pathname !== "/mcp"
        ) {
          context.addIssue({
            code: "custom",
            path: [backendType, "url"],
            message: "must be a loopback HTTP /mcp URL without credentials, query, or fragment",
          });
        }
      } catch {
        // z.url reports the primary issue.
      }
    }
    if (value.limits.perBackendConcurrentCalls > value.limits.globalConcurrentCalls) {
      context.addIssue({
        code: "custom",
        path: ["limits", "perBackendConcurrentCalls"],
        message: "must not exceed globalConcurrentCalls",
      });
    }
  });

export type GatewayConfigFile = z.infer<typeof GatewayConfigFileSchema>;
