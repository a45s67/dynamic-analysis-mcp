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
publicBaseUrl = "http://127.0.0.1:8000"
tokenEnv = "DYNAMIC_ANALYSIS_MCP_TOKEN"

[server.tls]
mode = "local"
```

Use proxy TLS mode only behind a configured trusted reverse proxy. Direct TLS
listener mode is rejected by the runtime.
