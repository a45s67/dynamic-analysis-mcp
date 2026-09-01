import { describe, expect, it } from "vitest";

import { lifecycleArguments, runLifecycleProcess } from "../src/index.js";

describe("bounded backend lifecycle process", () => {
  it("builds the controller CLI without a shell command string", () => {
    expect(
      lifecycleArguments(
        ["--backend", "x64", "--root", "C:\\tools\\x64dbg"],
        "restart",
        true,
        29_000,
      ),
    ).toEqual([
      "restart",
      "--backend",
      "x64",
      "--root",
      "C:\\tools\\x64dbg",
      "--force",
      "--timeout-ms",
      "29000",
    ]);
  });

  it("accepts exactly one successful bounded JSON object", async () => {
    const result = await runLifecycleProcess(
      process.execPath,
      ["--eval", 'process.stdout.write(JSON.stringify({status:"ok",process_id:42}))'],
      2_000,
    );
    expect(result).toEqual({ ok: true, value: { status: "ok", process_id: 42 } });
  });

  it("rejects multiline output", async () => {
    const result = await runLifecycleProcess(
      process.execPath,
      ["--eval", 'process.stdout.write("{}\\n{}")'],
      2_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_OUTPUT");
  });

  it("kills a controller that exceeds its deadline", async () => {
    const result = await runLifecycleProcess(
      process.execPath,
      ["--eval", "setTimeout(() => {}, 10000)"],
      100,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("TIMEOUT");
      expect(result.outcomeUnknown).toBe(true);
    }
  });

  it("preserves a bounded controller error and marks exit code 4 unknown", async () => {
    const result = await runLifecycleProcess(
      process.execPath,
      [
        "--eval",
        'process.stdout.write(JSON.stringify({status:"error",code:"START_TIMEOUT",message:"outcome unknown"}));process.exit(4)',
      ],
      2_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("START_TIMEOUT: outcome unknown");
      expect(result.dispatchStarted).toBe(true);
      expect(result.outcomeUnknown).toBe(true);
    }
  });

  it("treats output-limit termination as a dispatched unknown outcome", async () => {
    const result = await runLifecycleProcess(
      process.execPath,
      ["--eval", 'process.stdout.write("x".repeat(70000))'],
      2_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.dispatchStarted).toBe(true);
      expect(result.outcomeUnknown).toBe(true);
    }
  });
});
