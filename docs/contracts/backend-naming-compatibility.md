# Backend naming compatibility

The Gateway preserves backend-owned MCP contracts. It standardizes only its
namespace and management surface.

## Preserved backend conventions

| Concern | x64dbg/x32dbg | Cheat Engine | Gateway behavior |
| --- | --- | --- | --- |
| Local tool name | Dotted domain/operation, e.g. `debugger.state` | Often CE-prefixed, e.g. `ce.status` | Prepend `<backendType>.` without rewriting |
| Public example | `x64dbg.debugger.state` | `ce.ce.status` | No aliases or prefix stripping |
| Tool shape | Usually one operation per tool | May use an `action` discriminator | Preserve the published input schema |
| JSON fields | Primarily `snake_case` | Primarily `camelCase` | Preserve exactly |
| Error codes | `SCREAMING_SNAKE_CASE` | `SCREAMING_SNAKE_CASE` | Preserve as downstream data |
| Retry metadata | `retryable` | `recoverable`, `safeToRetry` | Do not treat as equivalent |
| Identity | `instance_id` | `sessionId`, `generation`, `stopGeneration` | Keep distinct from Gateway catalog identity |
| Addresses | Canonical hexadecimal plus module/RVA forms | Hexadecimal or expressions | Treat as opaque validated data |
| Pagination result | Commonly `next_cursor` | Commonly `nextCursor` | Preserve fields and cursors |
| Catalog changes | Stable per sidecar configuration | Stable per process/policy | Polling remains authoritative |

The public name is always:

```text
publicName = backend.type + "." + downstream.name
```

No case folding, separator replacement, backend-prefix stripping, or aliasing is
allowed.

## Gateway-owned conventions

Gateway JSON fields use `camelCase`, including:

- `catalogGeneration`, `catalogHash`, and `traceId`;
- `backendId`, `backendType`, and `backendInstanceId`;
- `downstreamCode`, `safeToRetry`, and `dispatchStarted`;
- `lastTransitionAt`, `lastDiscoveryAt`, and `toolCount`.

Stable enum and error values use `SCREAMING_SNAKE_CASE`. Backend IDs and types
use lowercase ASCII `[a-z][a-z0-9_-]{0,31}`. Timestamps use UTC RFC 3339.
Durations use integer milliseconds with an `Ms` suffix.

Gateway management tools are:

- `gateway.status`
- `gateway.backends`
- `gateway.refresh`
- `gateway.backend_control`
- `gateway.debugger_restart`

The first segment `gateway` is reserved.

## Safety boundary

Safety applies to a complete published tool, not an argument variant. An
action-multiplexed tool is mutation-classified if any action may mutate state.
Only unconditionally read-only tools belong in `readOnlyTools`.

Backend annotations may make the Gateway classification stricter but cannot make
an unknown tool retry-safe. Downstream tool calls are not automatically retried.

## Recommended backend conventions

New backend APIs should prefer:

- `camelCase` JSON fields;
- `SCREAMING_SNAKE_CASE` error codes;
- distinct `retryable` and `safeToRetry` booleans;
- `limit`/`cursor` inputs and `nextCursor` output;
- a non-secret process-lifetime `instanceId`;
- explicit MCP read-only, destructive, idempotent, and open-world annotations;
- deterministic catalogs with list-change notifications when catalogs can vary.

Existing fields should remain compatible with direct backend clients.
