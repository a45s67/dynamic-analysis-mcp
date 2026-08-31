# Backend naming and compatibility contract

- Status: Initial implementation contract
- Date: 2026-08-31
- Inputs: `../x64dbg-mcp-backend` and `../ce-mcp-backend`

## Purpose

The Gateway federates the two existing backend contracts without translating
debugger semantics. This record identifies which names the Gateway standardizes
and which backend-owned differences it must preserve.

## Observed conventions

| Concern | x64dbg/x32dbg backend | CE backend | Gateway treatment |
| --- | --- | --- | --- |
| Local tool names | Domain and operation, for example `debugger.state`, `memory.read` | Backend prefix plus grouped capability, for example `ce.status`, `ce.memory_read` | Preserve the complete local name and prepend `<type>.` |
| Public examples | `x64dbg.debugger.state`, `x32dbg.memory.read` | `ce.ce.status`, `ce.ce.memory_read` | No aliases or prefix stripping in MVP |
| Tool grouping | Usually one operation per tool | Often one tool with an `action` discriminator | Preserve; Gateway does not inspect actions for routing or safety |
| JSON field case | Primarily `snake_case` | Primarily `camelCase` | Preserve exactly as published |
| Action/value case | Lowercase and `snake_case` enums | Lowercase and `snake_case` action values | Preserve exactly as published |
| Error codes | `SCREAMING_SNAKE_CASE` | `SCREAMING_SNAKE_CASE` | Preserve as `downstreamCode` in the Gateway wrapper |
| Error retry field | `retryable` plus bounded `details` | `recoverable` and `safeToRetry` plus bounded details | Do not infer equivalence; compute Gateway `safeToRetry` independently |
| Backend identity | UUID `instance_id`; every mutation also has `operation_id` | Target `sessionId`, `generation`, and debugger `stopGeneration` | Preserve and expose only non-secret process identity as backend metadata |
| Addresses | Lowercase canonical `0x...`; module/RVA objects | Canonical `0x...` currently uses uppercase hex digits; expressions may be retained | Treat as opaque schema-validated backend data |
| Pagination | `limit` plus opaque `cursor`; result commonly `next_cursor` | `limit` plus opaque `cursor`; result commonly `nextCursor` | Preserve cursors and result fields verbatim |
| Lifecycle state | Debuggee state and `state_generation` | Session state, `generation`, and `stopGeneration` | Never merge with Gateway `catalogGeneration` |
| MCP HTTP | Authenticated localhost, stateless JSON Streamable HTTP | Authenticated localhost, stateless JSON Streamable HTTP | One generic downstream transport profile initially |
| Catalog changes | Static for a running sidecar; `listChanged: false` | Static for a running process/policy | Polling is authoritative; notifications are optional triggers |

## Gateway-owned naming

Gateway-owned public JSON uses `camelCase`, matching MCP wire conventions:

- `catalogGeneration`, `catalogHash`, and `traceId`;
- `backendId`, `backendType`, and optional `backendInstanceId`;
- `downstreamCode`, `retryable`, `safeToRetry`, and `dispatchStarted`;
- `lastTransitionAt`, `lastDiscoveryAt`, and `toolCount`.

Gateway-owned stable enum and error values use `SCREAMING_SNAKE_CASE`. Backend
IDs and types use lowercase ASCII `[a-z][a-z0-9_-]{0,31}`. Timestamps use UTC
RFC 3339 strings. Durations use integer milliseconds with an `Ms` suffix.

Management tool names are exactly:

- `gateway.backends`
- `gateway.status`
- `gateway.refresh`

The `gateway` first segment is reserved. A backend type named `gateway` is
invalid. The full public tool name is formed mechanically:

```text
publicName = backend.type + "." + downstream.name
```

No case folding, separator replacement, backend-prefix stripping, or aliasing is
permitted. Therefore a CE backend publishing `ce.status` under type `ce` is
intentionally exposed as `ce.ce.status` in the MVP.

## Common semantics worth aligning in future backend releases

These are recommendations for backend evolution, not Gateway rewrite rules:

1. Adopt `camelCase` for new public JSON fields to match MCP and CE, while
   retaining existing x64dbg fields for compatibility.
2. Keep stable error codes in `SCREAMING_SNAKE_CASE` and converge on explicit
   `retryable` and `safeToRetry` fields with distinct meanings.
3. Use `limit`/`cursor` inputs and `nextCursor` outputs for new pagination APIs.
4. Publish a non-secret process-lifetime `instanceId` in initialization metadata.
   CE target generations remain a separate concept.
5. Publish explicit `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
   `openWorldHint` booleans for every tool.
6. Keep tool catalogs deterministic and unchanged for the lifetime of a backend
   configuration, or advertise and emit MCP list-change notifications.

Changing existing fields solely to achieve cosmetic consistency would break
direct backend clients and is not recommended.

## Safety classification boundary

The Gateway classifies one published tool, not individual argument variants.
Consequently an action-multiplexed tool such as `ce.process` remains mutation
classified even when a particular call uses `action: "list"`. Only tools that
are unconditionally read-only may appear in Gateway `readOnlyTools` configuration.

Backend annotations can make the classification stricter but cannot make an
otherwise unknown tool retry-safe. No downstream `tools/call` is automatically
retried.

## Compatibility fixtures required before network implementation

Fixtures must cover:

- initialize responses from both backends, including x64dbg `instance_id`;
- complete tool catalogs with dotted downstream names and both field styles;
- successful structured content and structured tool errors;
- x64dbg replacement identity and `BACKEND_RESTARTED`;
- CE stale `sessionId`/generation and `OUTCOME_UNKNOWN`;
- `limit`/`cursor` preservation for both result naming styles; and
- catalogs whose only change is ordering, proving a stable canonical hash.
