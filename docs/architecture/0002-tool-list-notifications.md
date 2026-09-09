# ADR-0002: Sessionful Streamable HTTP catalog invalidation

- Status: Accepted for candidate qualification
- Supersedes: Per-request stateless upstream HTTP transport wiring

## Protocol and catalog

The Gateway advertises `tools.listChanged: true`. Each authenticated upstream
initialization creates a dedicated SDK `Server` and
`NodeStreamableHTTPServerTransport` with a cryptographically random session ID.
Subsequent POST, GET and DELETE requests route to that same pair using
`Mcp-Session-Id`. The official SDK owns initialization, protocol-version validation,
JSON-RPC responses, and standalone GET/SSE framing. POST response streams are not
the subscription channel. No backend call is retried or replayed.

`CatalogPublisher` invokes subscribers only after publishing a different canonical
tool-definition hash. Additions, removals, input/output schema, description and
annotation changes therefore invalidate the list; unchanged discovery polls do
not. Each session coalesces publication bursts over 25 ms and sends the actual
`notifications/tools/list_changed` JSON-RPC notification on its GET/SSE stream.
SDK comment heartbeats are disabled; no timer periodically announces tool changes.

Subscriptions are installed when the session is created, before initialization.
`tools/list` captures the immutable catalog and acknowledges that session's hash.
After both initialization and successful GET/SSE headers, the session reconciles
the current hash against its acknowledged baseline. This covers changes between
connect/list and subscription, and between a dropped SSE stream and a new GET.
Notifications are invalidation hints, not durable events: clients must list again.
A reconnect may repeat an unacknowledged invalidation. There is no event store,
unbounded notification queue, or tool-call replay. Subscriber/send failures cannot
abort publication; a failed or backpressured notification session is closed.

## Authentication and resource lifecycle

Bearer authentication occurs before session lookup on **every request**, including
GET subscription/reconnect and DELETE. A session ID is never a credential. The
existing deployment has one bearer identity and one shared authorized catalog;
clients with that same token have the same authority, not separate tenant ACLs.
Each client nevertheless has isolated SDK protocol/request state and SSE streams.
An invalid token cannot enumerate, subscribe to, call through, or delete a session.
Backend bearer authentication and service/user-agent authentication are unchanged.

Production bounds (transport defaults are fixed; execution uses the existing
`limits.globalConcurrentCalls` setting, with no new TOML fields):

| Resource | Bound |
| --- | --- |
| Sessions, including pending initialization | 32 |
| Concurrent admitted HTTP responses, including SSE | 128 |
| TCP connections | 256 |
| Concurrent POST responses per session | 8 |
| Unsettled tool executions per session | 8, retained after POST disconnect or session close |
| Unsettled tool executions across all sessions | `limits.globalConcurrentCalls` (default profile: 32; valid range 1–1024) |
| Standalone SSE streams per session | 1 |
| POST body | 1 MiB, one JSON-RPC message; batches rejected |
| Headers/body receive deadline | 30 seconds |
| Non-GET response lifetime | 5 minutes |
| Session idle time since last admitted request | 15 minutes, swept at most 30 seconds later |

SSE traffic and catalog changes do not refresh idle time. Long-idle clients must
reinitialize after HTTP 404; opening a stream alone cannot retain resources
forever. HTTP expiration/disconnect does not establish whether an already
dispatched operation completed. `OUTCOME_UNKNOWN` mutations must never be retried.
Existing router limits and fixed internal controller/agent deadlines remain in
force independently of these upstream HTTP bounds.

Transport response counters are not execution admission. The shared `ToolRouter`
reserves global and per-session execution capacity synchronously before dispatch
of either a management or backend handler, and releases it in `finally` only when
that actual handler promise settles (success or rejection). Disconnecting a POST,
cancelling an SDK request, DELETE, idle expiry or disposing a session does not
release its outstanding executions. Reinitializing creates a fresh session scope
but uses the same global router bound, so detached calls cannot accumulate without
limit through session churn. A permanently unsettled handler keeps its slot; no
unbounded queue or timeout-based optimistic release is used.

When execution capacity is unavailable, tools/call returns an MCP tool error with
code `EXECUTION_CAPACITY`, `dispatchStarted: false`, `retryable: false` and
`safeToRetry: false`. This describes only the newly rejected request. It neither
cancels earlier dispatched operations nor establishes their outcome or authorizes
a mutation retry. Session scope closure prevents new dispatch but never revokes
reservations held by running handlers.

Authenticated DELETE, protocol close, idle expiry, send failure, and Gateway
shutdown dispose session routing, catalog subscription, timer and response streams.
Local SDK client `close()` can merely drop its stream; clients should use
`terminateSession()` (DELETE) for immediate reclamation, with idle expiry as fallback.
Capacity failures use 503 (global/sessions), 429 (session POSTs), and 409 (duplicate
SSE); malformed/missing-session requests use 400 and unknown/expired IDs use 404.

## Upgrade and compatibility

Existing connections initialized against `listChanged: false` must reconnect and
reinitialize once after upgrade to negotiate the new capability/session. Thereafter
backend start/stop/schema changes can update the tool list in that same MCP
session, provided the host opens GET/SSE, handles the notification, reissues
`tools/list`, and refreshes its model-facing tool cache. The Gateway cannot force a
host to update its cache. Official SDK HTTP tests establish wire delivery and
same-session discovery, not OpenCode/Claude UI behavior in a live deployment.

Proxies must forward Authorization, Mcp-Session-Id and MCP-Protocol-Version on all
methods, permit GET/POST/DELETE, preserve streaming without buffering, and route
a session to this process. Restart loses in-memory sessions. Legacy clients that
discard session headers or only support stateless POST need compatible transport
support. No modern per-request/subscription protocol migration is implied by this
use of the SDK's sessionful Streamable HTTP transport.
