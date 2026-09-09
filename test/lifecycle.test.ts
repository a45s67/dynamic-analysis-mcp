import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runLifecycleCommand } from "../src/backend/lifecycle.js";

import { lifecycleArguments, runLifecycleProcess } from "../src/index.js";

vi.mock("node:child_process", { spy: true });

describe("bounded backend lifecycle process", () => {
  it.each([2, 3, 10, 900, 1_000, 30_000, 60_000])("keeps the controller deadline inside the %s ms process budget", (timeoutMs) => {
    const exec = vi.mocked(execFile).mockClear().mockImplementationOnce(() => ({} as ChildProcess));
    try {
      void runLifecycleCommand("fixture", [], "restart", false, timeoutMs);
      const args = exec.mock.calls[0]?.[1] as string[];
      const options = exec.mock.calls[0]?.[2] as { timeout: number };
      const controllerMs = Number(args[args.length - 1]);
      expect(controllerMs).toBeGreaterThan(0);
      expect(controllerMs).toBeLessThan(timeoutMs);
      expect(options.timeout).toBe(timeoutMs);
    } finally { vi.restoreAllMocks(); }
  });
  it.each([0, 1, -1, 1.5, NaN, Infinity, 2_147_483_648])("does not spawn with an insufficient or invalid %s ms budget", async (timeoutMs) => {
    const exec = vi.mocked(execFile).mockClear();
    expect(await runLifecycleCommand("fixture", [], "restart", false, timeoutMs)).toMatchObject({
      ok: false, code: "TIMEOUT", dispatchStarted: false, outcomeUnknown: false,
    });
    expect(exec).not.toHaveBeenCalled();
  });
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
