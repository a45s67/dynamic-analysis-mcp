# ServiceWithUserAgent deployment

This mode runs the stable MCP endpoint as an automatic Windows service and all
interactive debugger lifecycle operations in a scheduled per-user agent.

```powershell
.\install.ps1 `
  -Mode ServiceWithUserAgent `
  -X64dbgRoot 'C:\tools\x64dbg' `
  -CheatEngineRoot 'C:\tools\CE'
```

The installer derives ports and credential sources from the existing x32dbg,
x64dbg, and CE configuration. It never modifies backend-owned files. The
installer copies the effective credentials into Gateway-owned, ACL-restricted
service secrets without modifying backend files. The service launcher injects
them only into the Gateway process environment.

The installation creates the automatic `DynamicAnalysisMcpGateway` WinSW
service and a `DynamicAnalysisMcpGatewayUserAgent` task for the installing user
SID. The generated Gateway profile is bearer-protected and loopback-only. The
agent starts at interactive logon and uses an authenticated bounded named pipe.
By default the installer also places the Gateway's public client credential in
the owner's user-scoped `DYNAMIC_ANALYSIS_MCP_TOKEN`; use
`-SkipClientEnvironment` when another client secret facility owns registration.
Backend credentials are never placed in persistent environment variables.

Open a new terminal and register only the public Gateway endpoint:

```powershell
codex mcp add dynamic-analysis `
  --url http://127.0.0.1:8000/mcp `
  --bearer-token-env-var DYNAMIC_ANALYSIS_MCP_TOKEN
```

Without that user session, the Gateway remains online while GUI backends are
offline. `gateway.backend_control` and `gateway.debugger_restart` return
`USER_SESSION_UNAVAILABLE` with `dispatchStarted: false`; requests are never
queued for a future login. With the agent online, x32dbg/x64dbg lifecycle uses the installed
`x96dbg-mcp-control.exe` on the visible desktop. CE is discovered after the user
starts CE; CE host lifecycle control is not yet supported.

```powershell
.\uninstall.ps1             # preserve Gateway data
.\uninstall.ps1 -PurgeData  # also remove Gateway-owned credentials/config
```

Backend installations are never removed. The release bundles the stable WinSW
2.12.0 .NET 4.6.1 wrapper with SHA-256
`B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F`
and its MIT license; packaging rejects any other binary.

Rerun installation with `-Reconfigure` after moving a backend, changing an
installed port, rotating a backend token, or selecting a new owner from that
owner's elevated session. Reconfiguration synchronizes the Gateway-owned service
secrets; restart the service afterward.
