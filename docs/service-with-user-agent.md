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

`-CheatEngineRoot` is optional. Omit it for a debugger-only installation; CE is
disabled and its Gateway-owned credential copy is removed. The existing x64dbg
package must still contain both x32/x64 MCP configurations with matching tokens
and the controller. Neither backend token installer is changed.

### Single-machine LAN HTTP

On the DBG VM, run from the extracted release package in elevated PowerShell:

```powershell
.\install.ps1 `
  -Mode ServiceWithUserAgent `
  -X64dbgRoot 'C:\tools\x64dbg' `
  -GatewayBind '0.0.0.0' `
  -GatewayPort 8000 `
  -AllowBearerOnlyHttp `
  -GatewayTokenFile 'C:\secrets\gateway.token'
```

Replace `analysis-host` with the reachable transparent host proxy address. The
proxy forwards TCP/HTTP to the DBG VM's port 8000 without replacing Authorization
or rewriting `/mcp`. No orchestrator is installed; debugger backends remain local
to the VM. Configure host and VM firewalls separately to allow only intended
sources; the installer does not open firewall ports or configure the host proxy.

The supplied token file must contain 32..512 visible ASCII characters (an ending
CR/LF is allowed). Use a cryptographically random token. Its contents are copied
to the ACL-protected `gateway.token`, not referenced at runtime. Protect the
source file separately. On the client host, securely provision the same token:

```powershell
$env:DYNAMIC_ANALYSIS_MCP_TOKEN = [IO.File]::ReadAllText('C:\secrets\gateway.token').TrimEnd("`r", "`n")
codex mcp add dynamic-analysis --url http://analysis-host:8000/mcp --bearer-token-env-var DYNAMIC_ANALYSIS_MCP_TOKEN
curl.exe -i http://analysis-host:8000/mcp
```

The unauthenticated probe must return HTTP 401. Use the MCP client to initialize
and list tools with the token; a successful TCP connection alone is not an MCP
health check. Plaintext HTTP exposes bearer credentials and debugger data on the
wire. See [security caveats](configuration.md#opt-in-lan-http).

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

The service runs as LocalSystem and owns the stable MCP listener (loopback by default). The
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
Before replacing binaries, the installer verifies the existing service executable
path and user task action/owner SID. A different install path or owner is rejected
without stopping either registration. Run upgrades as the original owner.
The service is stopped first, then the task is disabled and stopped; any remaining
agent process is stopped only when its executable, task arguments, and owner SID
match. Debuggers and backend installations are not stopped or modified.
If an upgrade fails after shutdown, the service may remain stopped/unregistered
and the task disabled; correct the reported error and rerun the installer.
Windows sharing/lock violations during binary replacement are retried for up to
approximately ten seconds, then reported rather than killing other processes.
`-SkipRegistration` does not stop or alter any services, tasks, or processes; it is
intended for isolated package tests, not upgrades of a running registered Gateway.

Every install, including `-Reconfigure`, regenerates configuration from that
invocation's options; it does not merge the previous TOML. Repeat all listener
options above (and `-CheatEngineRoot` if wanted) on each reinstall. Omitted listener
options restore `127.0.0.1:8000` / `local`; omitted CE root disables CE.
`-Reconfigure` labels the operation, not a different preservation policy.
Gateway and agent tokens are retained when already present, except an explicit
`-GatewayTokenFile` replaces the Gateway token on every invocation. Backend
credentials are reread from the supplied installations. Update clients after
replacing the Gateway token; editing the original supplied file alone has no
effect until reinstall. Manual TOML edits are overwritten.

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

- The public listener is loopback-only by default; LAN HTTP requires explicit opt-in.
- All backend endpoints remain loopback-only, including in LAN HTTP mode.
- Tokens do not appear in TOML, service XML, or command-line arguments.
- The launcher injects tokens into the service process environment.
- Backend credentials are not persisted as machine-wide environment variables.
- Named-pipe requests accept only the closed lifecycle schema and fixed installed
  controller paths.
