# Configuration

The Gateway reads strict TOML. Unknown fields and literal credentials are
rejected. The release installer generates this file from the supplied backend
roots; manual configuration is mainly for development and non-service use.

See [`config/gateway.example.toml`](../config/gateway.example.toml) for the full
schema.

## Credentials

Every endpoint references a process environment variable through `tokenEnv`:

| Endpoint | Variable |
| --- | --- |
| Gateway listener | `DYNAMIC_ANALYSIS_MCP_TOKEN` |
| x64dbg and x32dbg | `X64DBG_MCP_TOKEN` |
| Cheat Engine | `CE_MCP_TOKEN` |
| Service-to-user-agent IPC | `DYNAMIC_ANALYSIS_AGENT_TOKEN` |

Tokens must contain 32–512 visible ASCII characters. Restart the Gateway after
changing its process environment. In a service installation, use
`install.ps1 -Reconfigure` after rotating backend credentials.

The service installer keeps credential copies under
`%ProgramData%\DynamicAnalysisMcpGateway` with restricted ACLs. The service
launcher reads those files and sets process-scoped variables. Token files are an
installer storage detail; TOML always uses `tokenEnv`.

## Backend lifecycle

For a directly launched Gateway, x32dbg/x64dbg may define an exact controller:

```toml
[x64dbg]
tokenEnv = "X64DBG_MCP_TOKEN"
lifecycleCommand = 'C:\tools\x64dbg\release\mcp\x96dbg-mcp-control.exe'
lifecycleArgs = ['--backend', 'x64', '--root', 'C:\tools\x64dbg']
```

`lifecycleCommand` and `lifecycleArgs` must appear together. Commands execute
without a shell and permit one active lifecycle operation per backend.

Service installations instead add:

```toml
[interactiveAgent]
pipeName = "dynamic-analysis-mcp-agent-<owner-sid-hash>"
tokenEnv = "DYNAMIC_ANALYSIS_AGENT_TOKEN"
```

When `interactiveAgent` is present, debugger lifecycle is delegated to the
per-user agent. The controller path and arguments are derived from the installed
x64dbg root and are not accepted from lifecycle requests.

## Local server profile

The installed profile is bearer-protected and loopback-only:

```toml
[server]
bind = "127.0.0.1"
port = 8000
path = "/mcp"
tokenEnv = "DYNAMIC_ANALYSIS_MCP_TOKEN"

[server.tls]
mode = "local"
```

Use proxy TLS mode only behind a configured trusted reverse proxy. Direct TLS
listener mode is rejected by the runtime.

## Raw uploads

The listener also accepts `POST /upload` with the same bearer token used by
`/mcp`. Set the fixed destination directory with the optional server field
`uploadRoot`; it defaults to `C:\analysis\sandbox` when omitted:

```toml
[server]
uploadRoot = 'D:\samples\incoming'
```

Uploads require `X-Filename`, `X-Content-SHA256`, and a positive
`Content-Length`. Files are limited to 64 MiB, and an existing destination is
never overwritten.

## Opt-in LAN HTTP

For a single DBG VM with a transparent host proxy, explicitly select plaintext
HTTP with bearer authentication. No orchestrator or trusted-proxy headers are
required. Backend URLs must still be loopback HTTP; authentication is mandatory.

```toml
[server]
bind = "0.0.0.0"
port = 8000
path = "/mcp"
tokenEnv = "DYNAMIC_ANALYSIS_MCP_TOKEN"

[server.tls]
mode = "bearer-only-http"
```

Configure the MCP client's URL with the reachable host proxy address and `/mcp`. The
proxy must forward `/mcp` and `Authorization` unchanged and support MCP streaming.
It must also forward `Mcp-Session-Id` and `MCP-Protocol-Version`, support
GET/POST/DELETE, and avoid buffering the standalone GET/SSE notification stream.
See [session lifecycle and tool-list notifications](architecture/0002-tool-list-notifications.md)
for bounds and the one-time reinitialization required after upgrading.
This mode does not require or trust forwarded identity headers or proxy CIDRs.
Wildcard listeners are accepted only in this explicit mode. The installer still
defaults to loopback `local` mode. Disabled backends need no token environment
variable.

HTTP exposes tokens, requests, and results to network observers and permits
in-transit modification. Anyone holding the token can invoke exposed debugger
tools. Restrict both VM and host ingress to the intended management host/client
addresses with firewalls; do not expose this mode to the Internet or untrusted
LANs. A transparent proxy does not add encryption or authentication.
