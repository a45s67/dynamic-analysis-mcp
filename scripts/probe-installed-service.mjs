import { readFile } from "node:fs/promises";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const [endpoint, tokenFile] = process.argv.slice(2);
if (endpoint === undefined || tokenFile === undefined) {
  throw new Error("endpoint and token file are required");
}
const token = (await readFile(tokenFile, "utf8")).replace(/\r?\n$/, "");
const deadline = Date.now() + 30_000;
let lastCode;
while (Date.now() < deadline) {
  const client = new Client({ name: "installed-service-probe", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const status = await client.callTool({ name: "gateway.status", arguments: {} });
    if (status.isError) throw new Error("Gateway status failed");
    const lifecycle = await client.callTool({ name: "gateway.backend_control", arguments: {
      backendId: "x64dbg", action: "status",
    } });
    const structured = lifecycle.structuredContent;
    lastCode = structured?.error?.code;
    if (lastCode !== "USER_SESSION_UNAVAILABLE") {
      if (lastCode !== "BACKEND_CONTROL_FAILED") {
        throw new Error(`unexpected lifecycle probe result: ${String(lastCode)}`);
      }
      process.stdout.write("service-to-user-agent named-pipe probe passed\n");
      process.exit(0);
    }
  } catch (error) {
    lastCode = error instanceof Error ? error.message : String(error);
  } finally {
    await client.close().catch(() => undefined);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const rawDiagnostic = String(lastCode ?? "");
const diagnostic = rawDiagnostic.includes("USER_SESSION_UNAVAILABLE")
  ? "USER_SESSION_UNAVAILABLE"
  : rawDiagnostic.includes("BACKEND_CONTROL_FAILED")
    ? "BACKEND_CONTROL_FAILED"
    : rawDiagnostic.includes("unexpected lifecycle probe result")
      ? "UNEXPECTED_LIFECYCLE_RESULT"
      : rawDiagnostic === ""
        ? "UNKNOWN"
        : "CLIENT_ERROR";
process.stdout.write(`::error title=Service-to-user-agent probe::${diagnostic}\n`);
process.exitCode = 1;
