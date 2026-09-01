# ADR-0001: Gateway architecture

- Status: Accepted
- Scope: Windows gateway for x64dbg, x32dbg, and Cheat Engine MCP backends

## Context

The debugger backends are independently usable localhost MCP servers with
different tool names and schemas. The Gateway provides one authenticated endpoint
without changing backend-owned contracts or installations.

## Decision

### Federation

The configured backend set is static: `x64dbg`, `x32dbg`, and `ce`. Each
backend is connected, initialized, and discovered independently. A backend is
published only after a successful MCP initialization and `tools/list`.

Public tool names are mechanical:

```text
<backendType>.<downstreamToolName>
```

Downstream names, arguments, results, and error details remain opaque. The
Gateway does not create aliases or translate backend field naming.

### Catalog snapshots

Discovered tools are normalized into a deterministic catalog, hashed, and
published as an immutable snapshot. Each call is routed against the snapshot on
which it was accepted, preventing a refresh from redirecting an in-flight call.

Polling is authoritative for discovery. Catalog-change notifications may trigger
an earlier refresh but do not replace polling.

### Routing and retry

A tool call is dispatched at most once. The Gateway does not automatically retry
downstream `tools/call`, including read-only calls. Errors report whether
dispatch started and whether the outcome may be unknown so the client can make
an informed retry decision.

Safety classification is configured per complete downstream tool name. Backend
annotations may make classification stricter. Action values inside a
multiplexed tool are not used to weaken its classification.

### Authentication and network boundary

The public endpoint and backend endpoints are bearer-authenticated. Installed
profiles bind to loopback. Tokens are supplied through process environment
variables referenced by TOML `tokenEnv` fields and are compared in constant
time after validation.

Proxy TLS mode requires an explicit trusted-proxy allowlist. Direct TLS listener
mode is not supported.

### Interactive lifecycle

The installed Windows deployment separates non-interactive service availability
from GUI lifecycle execution:

```text
MCP client -> LocalSystem Gateway service -> authenticated named pipe
           -> per-user logon agent -> x96dbg lifecycle controller
```

The pipe accepts a closed, bounded request schema for x32dbg/x64dbg
`status`, `start`, `stop`, and `restart`. Controller paths and base
arguments come from the installed backend root. No user session means
`USER_SESSION_UNAVAILABLE`; requests are not queued.

CE is discovered as an MCP backend but has no Gateway-managed GUI lifecycle.

## Runtime states

A backend reports one of these states:

- `offline`: transport or initialization is unavailable;
- `online`: initialized but without a publishable catalog;
- `ready`: catalog is published and calls may be routed;
- `degraded`: the last stable catalog remains available while discovery is
  failing.

Health transitions use configured consecutive-success and consecutive-failure
thresholds. Backend failure does not take the Gateway or other backends offline.

## Management surface

Gateway-owned tools use camelCase fields and `SCREAMING_SNAKE_CASE` error codes:

- `gateway.status`
- `gateway.backends`
- `gateway.refresh`
- `gateway.backend_control`
- `gateway.debugger_restart`

The `gateway` namespace is reserved.

## Packaging

The release artifact contains a self-contained Bun Windows executable, the WinSW
service wrapper, installer and uninstaller scripts, example configuration,
documentation, licenses, and a checksum manifest. Package verification rejects
missing, modified, or unexpected files and performs an executable startup check.

## Consequences

- Existing direct backend clients remain compatible.
- Backend naming differences remain visible through the public namespace.
- The Gateway can remain online without a logged-in desktop.
- GUI automation is unavailable until the configured owner logs in.
- Credential rotation and generated configuration changes require service
  reconfiguration or restart.
