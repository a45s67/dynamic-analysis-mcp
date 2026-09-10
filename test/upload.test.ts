import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startGatewayHttp } from "../src/index.js";
import type { RunningGatewayHttpServer } from "../src/index.js";

const TOKEN = "gateway-test-token-32-characters-long";
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

let root: string;
let server: RunningGatewayHttpServer;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "gateway-upload-test-"));
  server = await startGatewayHttp({
    host: "127.0.0.1",
    port: 0,
    path: "/mcp",
    bearerToken: TOKEN,
    uploadRoot: root,
    createMcpServer: () => { throw new Error("MCP session should not be created by upload tests"); },
  });
});

afterEach(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

function uploadUrl(): URL {
  return new URL("/upload", server.url);
}

async function upload(filename: string, value: Buffer | string, hash = sha256(value)): Promise<Response> {
  return fetch(uploadUrl(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-length": String(Buffer.byteLength(value)),
      "x-content-sha256": hash,
      "x-filename": filename,
    },
    body: value,
    duplex: "half",
  });
}

async function rawRequest(headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(uploadUrl(), { method: "POST", headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("authenticated raw uploads", () => {
  it("authenticates before consuming or creating upload state", async () => {
    const isolatedRoot = path.join(root, "not-created");
    await server.close();
    server = await startGatewayHttp({
      host: "127.0.0.1", port: 0, path: "/mcp", bearerToken: TOKEN,
      uploadRoot: isolatedRoot,
      createMcpServer: () => { throw new Error("unexpected MCP session"); },
    });
    const response = await fetch(uploadUrl(), { method: "POST", body: "unauthorized" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await response.json()).toEqual({ code: "UNAUTHENTICATED" });
    await expect(access(isolatedRoot)).rejects.toThrow();
  });

  it("publishes a valid upload and returns its absolute identity", async () => {
    const value = Buffer.from([0, 1, 2, 3, 255]);
    const response = await upload("sample_1.bin", value);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      path: path.join(root, "sample_1.bin"),
      size: value.length,
      sha256: sha256(value),
    });
    expect(await readFile(path.join(root, "sample_1.bin"))).toEqual(value);
    expect(await readdir(root)).toEqual(["sample_1.bin"]);
  });

  it.each([".", "..", "../escape", "sub/file", "name with space", "caf\u00e9", "a".repeat(256)])(
    "rejects unsafe filename %j",
    async (filename) => {
      const response = await upload(filename, "x");
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "INVALID_FILENAME" });
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("requires an exact lowercase SHA-256 header", async () => {
    const response = await upload("sample.bin", "x", sha256("x").toUpperCase());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_SHA256" });
    expect(await readdir(root)).toEqual([]);
  });

  it("removes temporary state after a hash mismatch", async () => {
    const response = await upload("sample.bin", "wrong bytes", sha256("expected bytes"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "HASH_MISMATCH" });
    expect(await readdir(root)).toEqual([]);
  });

  it("does not overwrite an existing destination", async () => {
    expect((await upload("sample.bin", "first")).status).toBe(201);
    const response = await upload("sample.bin", "second");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "DESTINATION_EXISTS" });
    expect(await readFile(path.join(root, "sample.bin"), "utf8")).toBe("first");
    expect(await readdir(root)).toEqual(["sample.bin"]);
  });

  it("requires a positive Content-Length and rejects lengths above 64 MiB", async () => {
    const common = {
      authorization: `Bearer ${TOKEN}`,
      "x-content-sha256": sha256("x"),
      "x-filename": "sample.bin",
    };
    const missing = await rawRequest(common);
    const zero = await rawRequest({ ...common, "content-length": "0" });
    const oversized = await rawRequest({ ...common, "content-length": String(64 * 1024 * 1024 + 1) });

    expect(missing).toEqual({ status: 400, body: { code: "INVALID_CONTENT_LENGTH" } });
    expect(zero).toEqual({ status: 400, body: { code: "INVALID_CONTENT_LENGTH" } });
    expect(oversized).toEqual({ status: 413, body: { code: "UPLOAD_TOO_LARGE" } });
    expect(await readdir(root)).toEqual([]);
  });

  it("removes temporary state when the request body is truncated", async () => {
    await new Promise<void>((resolve) => {
      const request = httpRequest(uploadUrl(), {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-length": "10",
          "x-content-sha256": sha256("0123456789"),
          "x-filename": "truncated.bin",
        },
      });
      request.on("error", () => resolve());
      request.on("close", () => resolve());
      request.write("short");
      setTimeout(() => request.destroy(), 20).unref();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readdir(root)).toEqual([]);
  });

  it("returns 405 for other upload methods after authentication", async () => {
    const response = await fetch(uploadUrl(), {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({ code: "METHOD_NOT_ALLOWED" });
  });
});
