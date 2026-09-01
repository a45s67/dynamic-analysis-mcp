# Gateway configuration and bearer-token environment

The Gateway uses strict TOML for non-secret settings. Every credential is named
with `tokenEnv`; literal tokens and token-file paths are rejected.

```toml
[server]
tokenEnv = "DYNAMIC_ANALYSIS_MCP_TOKEN"

[x64dbg]
tokenEnv = "X64DBG_MCP_TOKEN"
# Optional; both fields must be present together. No separate lifecycle table.
lifecycleCommand = 'C:\tools\x64dbg\release\mcp\x96dbg-mcp-control.exe'
lifecycleArgs = ['--backend', 'x64', '--root', 'C:\tools\x64dbg']

[x32dbg]
tokenEnv = "X64DBG_MCP_TOKEN"
lifecycleCommand = 'C:\tools\x64dbg\release\mcp\x96dbg-mcp-control.exe'
lifecycleArgs = ['--backend', 'x32', '--root', 'C:\tools\x64dbg']

[ce]
tokenEnv = "CE_MCP_TOKEN"
```

Each named variable must exist in the Gateway process environment and contain
32 through 512 visible ASCII characters. Its value is never returned by
management tools or written to logs. Generate and rotate independent credentials
for the public Gateway listener and each backend.

Environment variables are the runtime interface, not a requirement to persist
secrets in the registry or a user profile. A Windows service wrapper, service
manager, or secret-manager launcher may retrieve secrets from its preferred
store and construct the child process environment immediately before launch.
Avoid machine-wide persistent variables when a service-scoped mechanism exists.

## Backend contract

All components should use the same environment-variable convention:

- Gateway listener: `DYNAMIC_ANALYSIS_MCP_TOKEN`
- x64dbg: `X64DBG_MCP_TOKEN`
- x32dbg: `X64DBG_MCP_TOKEN` (shared with x64dbg by the current backend contract)
- Cheat Engine: `CE_MCP_TOKEN`

x64dbg and CE both accept their environment variables. The installer reads the
effective backend credentials, writes ACL-restricted Gateway-owned service
secrets, and the launcher injects only process-scoped variables. Persistent
machine-wide token variables are not required. Run installer `-Reconfigure`
after rotating a backend credential.

Service deployments add a generated endpoint for the interactive agent:

```toml
[interactiveAgent]
pipeName = "dynamic-analysis-mcp-agent-<owner-sid-hash>"
tokenEnv = "DYNAMIC_ANALYSIS_AGENT_TOKEN"
```

When present, debugger lifecycle never executes directly in Session 0. It is
delegated to the authenticated user agent and fails with
`USER_SESSION_UNAVAILABLE` when the owner is not logged in.

Changing the Gateway process environment requires a restart in the MVP.

`gateway.debugger_restart` accepts a configured `x32dbg` or `x64dbg` backend,
the currently observed backend instance UUID, a fresh operation UUID, and
optional `force`. The Gateway executes the exact absolute command directly
without a shell, verifies the current instance, caps runtime and output, and
permits only one active lifecycle call per backend.
