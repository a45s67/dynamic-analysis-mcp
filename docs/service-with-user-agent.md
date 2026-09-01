# ServiceWithUserAgent deployment

## Install

Run `install.ps1` from an elevated PowerShell session owned by the Windows user
who will run the GUI debuggers:

```powershell
.\install.ps1 `
  -Mode ServiceWithUserAgent `
  -X64dbgRoot 'C:\tools\x64dbg' `
  -CheatEngineRoot 'C:\tools\CE'
```

The supplied roots must contain working backend configurations. The installer
derives the x32dbg, x64dbg, and CE ports and credentials; backend files are read
but never changed.

Installation creates:

- `DynamicAnalysisMcpGateway`, an automatic WinSW service;
- `DynamicAnalysisMcpGatewayUserAgent`, an interactive-logon Scheduled Task for
  the installing user SID;
- `%ProgramData%\DynamicAnalysisMcpGateway`, containing Gateway configuration and
  ACL-protected Gateway-owned credential copies; and
- user-scoped `DYNAMIC_ANALYSIS_MCP_TOKEN`, unless
  `-SkipClientEnvironment` is specified.

Register only the Gateway endpoint after opening a new terminal:

```powershell
codex mcp add dynamic-analysis `
  --url http://127.0.0.1:8000/mcp `
  --bearer-token-env-var DYNAMIC_ANALYSIS_MCP_TOKEN
```

## Runtime model

The service runs as LocalSystem and owns the stable loopback MCP listener. The
user agent runs only in the installing user's interactive session. An
authenticated, bounded named pipe carries x32dbg/x64dbg lifecycle requests from
the service to that agent.

When the owner is logged out, the service remains online and lifecycle calls
return `USER_SESSION_UNAVAILABLE` with `dispatchStarted: false`. Calls are not
queued. After logon, lifecycle commands run through the installed
`x96dbg-mcp-control.exe` on the visible desktop.

CE is discovered when its MCP backend is reachable. The Gateway does not start
or stop the CE GUI.

## Reconfigure

Run from the intended owner's elevated session after moving a backend, changing
a backend port, or rotating a backend credential:

```powershell
.\install.ps1 `
  -Mode ServiceWithUserAgent `
  -X64dbgRoot 'C:\tools\x64dbg' `
  -CheatEngineRoot 'C:\tools\CE' `
  -Reconfigure
```

Reconfiguration replaces the generated service configuration, synchronizes the
Gateway-owned credential copies, and restarts the service and user task.

## Uninstall

```powershell
.\uninstall.ps1
.\uninstall.ps1 -PurgeData
```

The default removes the service, task, and installed binaries while preserving
Gateway data. `-PurgeData` also removes Gateway configuration, Gateway-owned
credentials, and the matching user-scoped client variable. Backend installations
are never removed.

## Security boundaries

- The public listener and all backend endpoints are loopback-only.
- Tokens do not appear in TOML, service XML, or command-line arguments.
- The launcher injects tokens into the service process environment.
- Backend credentials are not persisted as machine-wide environment variables.
- Named-pipe requests accept only the closed lifecycle schema and fixed installed
  controller paths.
