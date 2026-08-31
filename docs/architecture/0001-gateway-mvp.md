# ADR-0001: Dynamic Analysis MCP Gateway MVP

- Status: Accepted for MVP implementation
- Date: 2026-08-28
- Scope: `dynamic-analysis-mcp-gateway`

## Context and goals

The Gateway provides one stable MCP endpoint to remote clients while debugger MCP
servers remain independently usable on localhost. The MVP federates a static set
of backend endpoints, exposes only tools from reachable backends, namespaces those
tools, and routes calls without containing debugger-specific implementation.

This record is the implementation boundary for the MVP. Features explicitly
deferred here are not part of the first implementation.

## Decisions at a glance

- Expose one stateful Streamable HTTP endpoint at `/mcp`.
- Implement the Gateway in strict TypeScript on a pinned Node.js LTS release.
- Use the official MCP TypeScript SDK v2 packages for both server and client roles.
- Configure fixed localhost backend URLs and independent bearer-token file
  references.
- Allow at most one configured backend per backend type.
- Publish immutable, generation-numbered catalog and routing snapshots.
- Expose a backend only after successful MCP initialization and `tools/list`.
- Namespace downstream tools as `<backend type>.<downstream name>`.
- Never automatically retry `tools/call`; unknown tools are mutation-classified by
  default unless explicitly identified as retry-safe reads.
- Always expose `gateway.backends`, `gateway.status`, and `gateway.refresh`.

## 1. Architecture and component boundaries

```text
Remote MCP client
        |
        | HTTPS Streamable HTTP /mcp + client bearer token
        v
+-------------------------- Gateway process ---------------------------+
| HTTP/auth/limits -> MCP server adapter -> management tools            |
|                                      \-> catalog + router             |
|                                           | immutable snapshot        |
|                          backend supervisor + discovery workers       |
|                                           |                           |
|                              MCP client/transport adapters            |
+-------------------------------------------|---------------------------+
                                            | localhost HTTP + distinct
                                            | backend bearer tokens
                    +-----------------------+-----------------------+
                    v                       v                       v
                 CE MCP                 x64dbg MCP              x32dbg MCP
```

### Inbound transport and session layer

Owns the single `/mcp` route, MCP session lifecycle, authentication, protocol
headers, body limits, and connection limits. It creates/tracks an MCP server
session and delivers catalog-change signals to connected clients. No debugger or
backend-specific behavior belongs here.

The production listener may speak TLS directly or sit behind an explicitly
trusted TLS reverse proxy. No other MCP endpoint is exposed. A non-MCP liveness
probe may be added on the management interface but must reveal no backend or
target details and is not required for MVP acceptance.

### Gateway MCP server adapter

Maps SDK requests to application services. It always registers the three
management tools and serves dynamic tool definitions from the current catalog
snapshot. SDK-specific request/result types stop at this boundary.

### Backend registry and supervisor

Loads validated static configuration and owns one state machine per backend. Each
backend worker independently connects, initializes MCP, discovers tools, observes
disconnects, applies deadlines, and schedules health probes with jitter. No
registry lock is held during network I/O.

### Catalog builder and publisher

Validates untrusted downstream tool definitions, rewrites names, detects
collisions, sorts deterministically, and builds an immutable snapshot containing:

- a monotonically increasing generation;
- a stable catalog hash;
- public tool definitions;
- public-name to backend-ID/downstream-name routes;
- the safety classification captured at publication time.

It atomically publishes a new snapshot only when the stable catalog hash changes.
In-flight calls retain the snapshot with which they started. Publication signals
every active upstream session using the change mechanism appropriate to its
negotiated MCP protocol era.

### Tool router

Resolves a public name only through the request's captured snapshot, validates
arguments against the published schema, applies policy and per-backend concurrency
limits, makes exactly one downstream `tools/call`, and normalizes the result or
error. It does not rediscover a route during an in-flight call.

### Policy, limits, observability, and secrets

Cross-cutting services provide authentication, safety classification, deadlines,
bounded concurrency/output, secret resolution/redaction, audit events, metrics,
and correlation IDs. Logs contain tool/backend identifiers and outcome metadata,
not tokens, arguments, memory contents, or full results by default.

### Explicit non-responsibilities

The Gateway does not call debugger SDKs, interpret debugger state, serialize
debugger-affine mutations, unify equivalent tools across debuggers, or
dynamically register backends. It may invoke an explicitly configured,
backend-owned lifecycle controller as a bounded child process; all debugger,
path, readiness, and graceful-close semantics remain backend concerns.

## 2. Selected language and SDK

Use strict TypeScript, ESM, and a pinned supported Node.js LTS release. Use the
official MCP TypeScript SDK v2 packages:

- `@modelcontextprotocol/server` for the upstream server;
- `@modelcontextprotocol/client` for downstream clients;
- the smallest official Node HTTP adapter required by the chosen hosting layer;
- Zod v4 for configuration and additional boundary validation.

Pin exact dependency and runtime versions in the lockfile and CI. Keep MCP server
and client construction behind local interfaces so SDK upgrades do not leak into
catalog, health, routing, or policy logic.

Rationale: this process is mostly asynchronous protocol federation, schema
validation, and HTTP lifecycle management. TypeScript has a Tier 1 official MCP
SDK, strong schema tooling, rapid protocol support, and aligns with the reviewed
best-separated backend architecture. Rust remains a future packaging/hardening
option, not an MVP requirement; Python, C++, and Zig offer no advantage at this
non-debugger process boundary.

The Gateway should negotiate supported MCP protocol versions rather than silently
reinterpret them. The initial compatibility target includes currently required
Streamable HTTP clients and backends; exact protocol revisions are pinned during
implementation after contract fixtures confirm deployed backend compatibility.
Legacy standalone HTTP+SSE is not exposed as a second endpoint.

## 3. Configuration schema

Configuration is one strict TOML file. Every bearer secret is referenced through
`tokenEnv`; literal tokens and token-file paths are not supported.
The resolved runtime configuration is never serialized or returned by management
tools.

```toml
version = 1

[server]
bind = "10.20.0.15"
port = 8000
path = "/mcp"
publicBaseUrl = "https://analysis-vm.example:8000"
tokenEnv = "DYNAMIC_ANALYSIS_MCP_TOKEN"

[server.tls]
mode = "proxy" # proxy | direct
trustedProxyCidrs = ["10.20.0.1/32"]
# certFile and keyFile are required instead when mode = "direct".

[x64dbg]
enabled = true
url = "http://127.0.0.1:8064/mcp"
tokenEnv = "X64DBG_MCP_TOKEN"

[x64dbg.safety]
readOnlyTools = ["debugger.state", "memory.read", "memory.map"]
mutationTools = ["debugger.resume", "memory.write"]

[x32dbg]
enabled = true
url = "http://127.0.0.1:8032/mcp"
tokenEnv = "X64DBG_MCP_TOKEN"

[x32dbg.safety]
readOnlyTools = ["debugger.state", "memory.read", "memory.map"]
mutationTools = ["debugger.resume", "memory.write"]

[ce]
enabled = true
url = "http://127.0.0.1:8001/mcp"
tokenEnv = "CE_MCP_TOKEN"

[ce.safety]
readOnlyTools = ["ce.status", "ce.memory_read", "ce.memory_map"]
mutationTools = ["ce.process", "ce.debug_control"]

[discovery]
intervalMs = 5000
connectTimeoutMs = 1000
listTimeoutMs = 3000
stableSuccesses = 2
stableFailures = 2
jitterPercent = 20

[limits]
requestBodyBytes = 1048576
downstreamCatalogBytes = 1048576
downstreamToolCount = 500
downstreamToolDefinitionBytes = 65536
toolResultBytes = 4194304
globalConcurrentCalls = 32
perBackendConcurrentCalls = 4
defaultToolTimeoutMs = 30000
refreshCooldownMs = 1000

[naming]
mode = "dotted"
```

Required validation rules:

- `version` must be supported; unknown keys are rejected.
- Backend section names are exactly `x64dbg`, `x32dbg`, and `ce`; each name is
  both its stable backend ID and type for the MVP.
- Backend URLs must use `http`, have hostname exactly `localhost`, `127.0.0.1`, or
  `[::1]`, contain no userinfo/query/fragment, and use the configured MCP path.
  Resolve/connect logic must not follow redirects to a non-loopback address.
- `server.bind` must be an explicit management address, not a wildcard or loopback.
- `tokenEnv` is required for the Gateway listener and every backend. Names use
  uppercase portable environment-variable syntax. Each variable must exist in
  the Gateway process environment and contain a bounded bearer credential.
  Literal token values and token-file paths are not accepted. Secret values are
  never returned by management tools or written to logs.
- Production launch tooling supplies a service-scoped environment from its
  chosen secret store. The Gateway does not prescribe or own secret persistence.
- TLS direct mode requires readable certificate/key paths. Proxy mode trusts
  forwarded identity only from configured proxy CIDRs.
- All durations, counts, and sizes have implementation-defined safe min/max bounds.
- A tool may not appear in both safety lists. Tools absent from both lists are
  classified as mutations for retry decisions.

Changing the backend set, listener, authentication, or naming mode requires a
restart in the MVP. `gateway.refresh` refreshes discovery; it does not reload
configuration or secrets.

## 4. Backend health and discovery model

Transport reachability and debugger readiness are separate concepts:

```text
disabled
   |
probing -> reachable -> catalog_ready
   ^           |              |
   |           +----failure---+
   +----------- degraded/offline
```

Public backend health states are:

- `disabled`: configured but administratively disabled;
- `offline`: no successful MCP connection/catalog within the failure threshold;
- `online`: MCP is reachable and initialized, but no usable catalog is currently
  published (including a valid empty catalog);
- `ready`: MCP is reachable and a validated non-empty catalog is published;
- `degraded`: the last published catalog remains temporarily usable, but a recent
  health or refresh attempt failed.

Debugger target state is backend-reported metadata and is not inferred by the
Gateway. If a backend reports `online` versus `target_loaded`/`paused`, the Gateway
may display that in status, but tool availability is determined by successful
`tools/list`, not by guessing debugger state.

### Probe and publication algorithm

1. On startup and at the configured interval, independently connect/initialize
   each enabled backend with its bearer token, or check the existing connection.
2. Call paginated `tools/list` to completion under one overall deadline and size/
   count limits. Validate every definition before it can enter the catalog.
3. A new or changed catalog becomes eligible after `stableSuccesses` consecutive
   equivalent observations. Removal becomes eligible after `stableFailures`
   consecutive failures. This is the debounce contract.
4. While fewer than `stableFailures` failures have occurred, retain the last good
   catalog and mark the backend `degraded`. After the threshold, mark it `offline`,
   remove its routes, publish one new generation, and notify clients.
5. Recovery follows the success threshold, republishes the validated catalog, and
   resets exponential reconnect backoff. Periodic healthy probes remain at the
   normal interval; failed reconnect attempts use capped exponential backoff plus
   jitter.
6. A backend `notifications/tools/list_changed` signal schedules immediate
   debounced rediscovery. It never directly mutates the published snapshot.

Only one discovery pass per backend may run at once. `gateway.refresh` coalesces
with an active pass and returns the resulting or already scheduled refresh ID; it
does not wait indefinitely for all backends.

### Management tools

- `gateway.backends`: concise configured-backend inventory with ID, type, state,
  last transition, last successful discovery, catalog tool count/hash, backend
  version/protocol metadata, non-secret backend instance identity when supplied,
  and sanitized diagnostic code. Never returns URLs, token environment names, or token
  material. Instance identity is correlation metadata and is never injected into
  downstream calls by the Gateway.
- `gateway.status`: gateway version, uptime, current catalog generation/hash,
  aggregate state/counts, active/queued calls, limit utilization, and last refresh
  summary. It contains no target memory or tool arguments.
- `gateway.refresh`: requests discovery of all backends or one backend ID, subject
  to cooldown/coalescing, and returns a refresh ID plus per-backend scheduled state.
- `gateway.backend_control`: invokes the selected backend's optional controller
  once for `status`, `start`, `stop`, or `restart`. The command and fixed arguments
  come only from configuration; callers cannot supply paths or arbitrary arguments.

These names are reserved and cannot be shadowed by backend namespaces.

## 5. Tool routing and naming model

The public name is `<type>.<downstreamName>`, for example:

```text
x64dbg.read_memory -> backend id x64dbg -> downstream read_memory
```

Rules:

- The prefix is the configured backend `type`; the internal `id` is retained in
  the route but is not a public name segment or tool argument.
- Downstream names must match the MCP-supported tool-name grammar, be case-stable,
  and fit the configured length bound after prefixing. Dots and underscores inside
  the downstream name are preserved verbatim. The Gateway owns only the configured
  first segment and the first dot that joins it to the complete downstream name.
  Invalid tools reject that backend catalog atomically.
- The Gateway copies validated descriptions, input/output schemas, and annotations,
  then adds no semantic claims that the backend did not make. It may add bounded,
  namespaced Gateway metadata for backend type and catalog generation.
- The Gateway never rewrites downstream argument/result field casing, action names,
  hexadecimal strings, opaque IDs, cursors, generations, or debugger-specific
  identity fields. Backend contracts remain authoritative after name prefixing.
- Public definitions are sorted by full public name. The canonical hash is computed
  from a canonical JSON representation excluding volatile health timestamps.
- Collisions or duplicate downstream names reject the affected backend catalog;
  they are never resolved by last-writer-wins.
- There are no unprefixed aliases or underscore aliases in the MVP.

For `tools/call`, capture the current snapshot, look up the exact public name, and
route to the captured backend ID/downstream name. If absent, return `TOOL_NOT_FOUND`
with the current catalog generation. A later catalog refresh cannot redirect that
call. Arguments and results pass through without debugger-semantic transformation,
subject to schema, size, content, and policy validation.

## 6. Error and retry contract

Gateway-owned tool failures use MCP tool error results with a machine-readable
structured payload and a short human-readable text block. Protocol/framing errors
remain JSON-RPC/MCP protocol errors. The structured payload has this minimum form:

```json
{
  "code": "BACKEND_OFFLINE",
  "message": "x64dbg is not reachable",
  "backend": "x64dbg",
  "catalogGeneration": 12,
  "retryable": true,
  "safeToRetry": true,
  "traceId": "..."
}
```

Stable Gateway codes are:

- `UNAUTHENTICATED`, `PERMISSION_DENIED`, `RATE_LIMITED`;
- `INVALID_TOOL_ARGUMENTS`, `TOOL_NOT_FOUND`, `TOOL_BLOCKED`;
- `BACKEND_OFFLINE`, `BACKEND_UNAVAILABLE`, `BACKEND_PROTOCOL_ERROR`;
- `TIMEOUT`, `CANCELLED`, `RESULT_TOO_LARGE`;
- `OUTCOME_UNKNOWN`, `INTERNAL_ERROR`.

Downstream structured tool errors are preserved when safe, wrapped with backend,
generation, trace context, and the original stable downstream code, and scrubbed
of secrets/transport internals. In particular `OUTCOME_UNKNOWN`,
`BACKEND_RESTARTED`, identity mismatch, stale-session/generation, and stale-cursor
semantics must not be flattened into generic availability failures. Unknown
downstream error shapes become `BACKEND_PROTOCOL_ERROR` or `INTERNAL_ERROR`.

### Retry rules

- The Gateway makes one downstream `tools/call` attempt. It never automatically
  retries tool calls, including reads. This gives the MVP one simple, auditable
  execution guarantee and avoids relying on untrusted annotations.
- Connection establishment, health checks, and `tools/list` discovery may retry;
  they do not invoke debugger tools.
- Failure before a request body is handed to the downstream transport is
  `BACKEND_OFFLINE`/`BACKEND_UNAVAILABLE`. `safeToRetry` is true only for configured
  read-only tools and false for mutation-classified tools.
- For a mutation-classified call, any timeout, disconnect, malformed/lost response,
  or cancellation after dispatch begins returns `OUTCOME_UNKNOWN`,
  `safeToRetry: false`. The Gateway must not claim rollback.
- For a configured read-only call with a lost response, return the applicable
  transport error with `safeToRetry: true`, but leave the retry decision to the
  client. State may have changed between attempts.
- A normal downstream tool error proves that a response was received and is not
  rewritten as `OUTCOME_UNKNOWN`.

Safety classification order is: explicit Gateway deny policy, explicit mutation
configuration, explicit read-only configuration, then conservative mutation
default. Backend annotations may make classification stricter but cannot alone
make an unknown tool retry-safe. A future idempotency-key contract may permit safe
mutation retries, but it is deferred until backends implement deduplication.

## 7. Security model

### Trust boundaries and authentication

- Remote clients authenticate to the Gateway with a Gateway-specific bearer token
  in the MVP. Compare token bytes in constant time after normalizing valid input.
- Each backend has a distinct bearer token resolved from a distinct token file
  variable. Gateway and backend tokens are never interchangeable.
- Backends must bind to loopback. Configuration validation and redirect policy
  prevent the Gateway from becoming a general SSRF proxy.
- The Gateway binds only to an explicit VM management address. Deployment must
  firewall the sample-facing network and use TLS, a management VPN, or both.
- Validate Host/Origin and MCP protocol/content headers according to the negotiated
  protocol. In proxy TLS mode, trust forwarded headers only from configured proxies.

### Least privilege and abuse resistance

- Authenticate every MCP request and bind session identity to the authenticated
  principal. Reject session/token mismatches.
- Enforce request, JSON depth, catalog, schema, result, timeout, connection, global
  concurrency, and per-backend concurrency limits.
- Treat schemas, descriptions, annotations, error text, and result content from a
  backend as untrusted bounded data. Never evaluate schema extensions or render
  downstream text as trusted HTML.
- Dangerous-tool policy exists at both Gateway and backend. Gateway policy reduces
  exposure; it is not the backend's sole safety control.
- Use separate correlation IDs for auditability. Audit principal, public tool,
  backend ID, safety class, start/end time, duration, outcome code, byte counts,
  and whether dispatch began. Do not log bearer tokens, authorization headers,
  arguments, memory, injected payloads, or complete results by default.
- Redact secrets from configuration errors, exception causes, metrics labels,
  management tools, and process crash reports where controllable.

MVP token rotation requires process restart. OAuth, per-tool user authorization,
multi-tenant isolation, and dynamic secret reload are deferred.

## 8. Test strategy

### Unit tests

- strict configuration validation, secret redaction, loopback URL/redirect checks;
- state-machine transitions, debounce thresholds, backoff, jitter, and coalescing;
- downstream tool/schema validation, namespace rewriting, collision rejection,
  canonical ordering/hash, and catalog size limits;
- immutable snapshot capture during concurrent publication;
- safety classification and every error/retry branch, especially dispatch-boundary
  handling of mutations;
- request/result limits, auth comparison, policy, and log redaction.

Use fake clocks and deterministic random sources for all timing tests.

### Contract tests

- upstream initialization, `tools/list`, `tools/call`, and catalog-change signaling
  against supported MCP protocol revisions;
- downstream MCP initialization, paginated `tools/list`, bearer headers, tool calls,
  errors, notifications, cancellation, and shutdown;
- exact contracts for all three `gateway.*` tools;
- deterministic golden catalogs and structured Gateway error schemas;
- compatibility fixtures for each supported backend type/version.

### Integration tests

Run the Gateway against controllable fake Streamable HTTP MCP backends and test:

- backend before/after Gateway startup, disappear/reappear, empty/changed catalogs;
- debounce without catalog flapping and notifications only after hash changes;
- routing while a new snapshot publishes;
- independent backend failures and bounded parallelism;
- response loss before dispatch versus after mutation dispatch;
- timeout/cancellation and `OUTCOME_UNKNOWN` behavior;
- malformed/oversized schemas, responses, JSON, HTTP headers, and redirects;
- stale/invalid client and backend tokens;
- graceful shutdown with discovery and tool calls in flight.

At least one end-to-end acceptance job should use real CE, x64dbg, and x32dbg
backend builds when available; deterministic fake backends remain the required CI
baseline. Add fuzz/property tests for configuration, name rewriting, canonical
hashing, JSON/schema boundaries, and response-loss schedules. CI pins Node, SDK,
package-manager, and lockfile versions and runs typecheck, lint, unit, contract,
integration, dependency audit, and build jobs.

## 9. Phased implementation plan

### Phase 0: contracts and skeleton

- Initialize the TypeScript project, pinned toolchain, lint/typecheck/test commands,
  CI, and dependency update policy.
- Define configuration, health, snapshot, route, safety, management result, and
  structured error types plus JSON/Zod schemas.
- Add fake backend and fake clock test infrastructure.

Exit: configuration and domain contracts pass unit tests; no network listener yet.

### Phase 1: downstream discovery and catalog core

- Implement secret resolution and strict configuration validation.
- Implement MCP client adapter, backend state machines, bounded discovery,
  pagination, validation, debounce/backoff, and immutable catalog publication.
- Implement deterministic names/hashes and management service logic.

Exit: fake backends can appear/disappear/change catalogs with deterministic tested
snapshots; still no public endpoint required.

### Phase 2: upstream Streamable HTTP and dynamic catalog

- Add authenticated `/mcp`, session lifecycle, limits, and all three management
  tools.
- Serve the current catalog and deliver catalog-change signals to every supported
  negotiated session.
- Add contract tests with official SDK clients.

Exit: a client connects to one URL and observes stable dynamic tool changes.

### Phase 3: routing, failure semantics, and policy

- Implement snapshot-bound routing, arguments/results validation, concurrency and
  deadlines, safety classification, and structured error translation.
- Prove the dispatch boundary and mutation response-loss behavior with fault
  injection; verify that no `tools/call` is automatically retried.

Exit: calls route end to end and every ambiguous mutation test returns
`OUTCOME_UNKNOWN` with `safeToRetry: false`.

### Phase 4: operational hardening and packaging

- Add audit logging, metrics, trace correlation, graceful drain/shutdown, TLS/proxy
  validation, robustness/fuzz tests, and Windows service packaging guidance.
- Run compatibility tests against real backend builds and document installation,
  health checking, upgrades, rollback, and token rotation.

Exit: all MVP acceptance criteria and security/robustness tests pass in CI, and a
fresh analysis VM can be configured to expose one authenticated Gateway URL.

## Deferred decisions

- dynamic backend registration or port discovery;
- multiple instances of one backend type;
- unprefixed/underscore aliases and semantic cross-debugger tools;
- exposing offline backend catalogs;
- automatic tool-profile reduction;
- automatic `tools/call` retries or mutation idempotency caches;
- OAuth/multi-user authorization and hot secret/config reload;
- a second legacy SSE endpoint, stdio mode, or debugger process launching;
- workflow orchestration and long-operation storage owned by the Gateway.

These require new ADRs because they change public naming, trust boundaries,
delivery semantics, or deployment behavior.

## MVP acceptance criteria

- One authenticated Streamable HTTP `/mcp` endpoint serves remote clients.
- Static CE, x64dbg, and x32dbg loopback backends use separate bearer tokens.
- Only stable, validated, reachable catalogs are published.
- Names are dotted, deterministic, collision-safe, and routed through immutable
  snapshots.
- Catalog changes are delivered reliably without flapping.
- The three `gateway.*` tools remain available with no backend online.
- Offline failures and ambiguous mutation outcomes are machine-actionable.
- The Gateway never automatically retries a downstream tool call.
- Request, catalog, output, time, and concurrency limits are enforced and tested.
- Active requests and sessions shut down cleanly without route/state use-after-free.

## Source material

This decision is based on the complete 2026-08-28 survey records:

- `DYNAMIC_ANALYSIS_GATEWAY_DESIGN.md`
- `REPOSITORY_REVIEW.md`
- `MCP_DEVELOPMENT_GUIDE.md`

It also selects the official MCP TypeScript SDK v2 server/client package split
current on the decision date. Dependency versions will be captured in the lockfile
during Phase 0 rather than embedded in this architecture record.
