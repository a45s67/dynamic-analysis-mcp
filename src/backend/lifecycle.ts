import { execFile } from "node:child_process";

import type { JsonValue } from "../domain/types.js";

const MAX_OUTPUT_BYTES = 65_536;

export type LifecycleAction = "restart" | "start" | "status" | "stop";

export type LifecycleExecution =
  | { readonly ok: true; readonly value: Readonly<Record<string, JsonValue>> }
  | {
      readonly ok: false;
      readonly code: "INVALID_OUTPUT" | "PROCESS_FAILED" | "TIMEOUT";
      readonly message: string;
      readonly dispatchStarted: boolean;
      readonly outcomeUnknown: boolean;
    };

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function runLifecycleProcess(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<LifecycleExecution> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          const timedOut = "killed" in error && error.killed === true;
          const numericExitCode = typeof error.code === "number" ? error.code : undefined;
          const outputLimit = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          const terminatedBySignal = error.signal !== null && error.signal !== undefined;
          let controllerMessage: string | undefined;
          try {
            const parsed: unknown = JSON.parse(stdout.trim());
            if (
              isJsonObject(parsed) &&
              parsed.status === "error" &&
              typeof parsed.code === "string" &&
              typeof parsed.message === "string" &&
              parsed.code.length <= 64 &&
              parsed.message.length <= 512 &&
              !/[\u0000-\u001f\u007f]/u.test(parsed.code + parsed.message)
            ) {
              controllerMessage = `${parsed.code}: ${parsed.message}`;
            }
          } catch {
            // Process failures are still returned without trusting malformed output.
          }
          resolve({
            ok: false,
            code: timedOut ? "TIMEOUT" : "PROCESS_FAILED",
            message:
              controllerMessage ??
              (timedOut
                ? "backend controller exceeded its deadline; outcome is unknown"
                : "backend controller could not complete"),
            dispatchStarted:
              timedOut || outputLimit || terminatedBySignal || numericExitCode !== undefined,
            outcomeUnknown: timedOut || outputLimit || terminatedBySignal || numericExitCode === 4,
          });
          return;
        }
        const text = stdout.trim();
        if (text.length === 0 || text.includes("\n") || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) {
          resolve({
            ok: false,
            code: "INVALID_OUTPUT",
            message: "backend controller returned invalid bounded output",
            dispatchStarted: true,
            outcomeUnknown: true,
          });
          return;
        }
        try {
          const value: unknown = JSON.parse(text);
          if (!isJsonObject(value) || value.status !== "ok") {
            throw new Error("invalid controller result");
          }
          resolve({ ok: true, value });
        } catch {
          resolve({
            ok: false,
            code: "INVALID_OUTPUT",
            message: "backend controller returned invalid JSON",
            dispatchStarted: true,
            outcomeUnknown: true,
          });
        }
      },
    );
  });
}

export function runLifecycleCommand(
  command: string,
  configuredArgs: readonly string[],
  action: LifecycleAction,
  force: boolean,
  timeoutMs: number,
): Promise<LifecycleExecution> {
  return runLifecycleProcess(
    command,
    lifecycleArguments(configuredArgs, action, force, Math.max(1_000, timeoutMs - 1_000)),
    timeoutMs,
  );
}

export function lifecycleArguments(
  configuredArgs: readonly string[],
  action: LifecycleAction,
  force: boolean,
  timeoutMs: number,
): readonly string[] {
  return [
    action,
    ...configuredArgs,
    ...(force ? ["--force"] : []),
    "--timeout-ms",
    String(timeoutMs),
  ];
}
