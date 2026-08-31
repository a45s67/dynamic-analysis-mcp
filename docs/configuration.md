# Gateway configuration and bearer-token environment

The Gateway uses strict TOML for non-secret settings. Every credential is named
with `tokenEnv`; literal tokens and token-file paths are rejected.

```toml
[server]
tokenEnv = "DYNAMIC_ANALYSIS_MCP_TOKEN"

[x64dbg]
tokenEnv = "X64DBG_MCP_TOKEN"

[x32dbg]
tokenEnv = "X64DBG_MCP_TOKEN"

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

x64dbg already accepts its environment variable. CE currently requires
`--token-file`; it should add `CE_MCP_TOKEN` support before this convention is
used end to end. A temporary CE launcher may read its existing token file and
set `CE_MCP_TOKEN`, but the preferred final contract is native environment
support in CE MCP.

Changing the Gateway process environment requires a restart in the MVP.
