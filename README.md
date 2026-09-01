# Dynamic Analysis MCP Gateway

An authenticated MCP gateway for localhost dynamic-analysis backends.

Supported backends:

- [x64dbg-mcp-backend](https://github.com/a45s67/x64dbg-mcp-backend)
- [CE-mcp-backend](https://github.com/a45s67/CE-mcp-backend)

## Windows installation

Run from an elevated PowerShell session using the release package:

```powershell
.\install.ps1 `
  -Mode ServiceWithUserAgent `
  -X64dbgRoot 'C:\tools\x64dbg' `
  -CheatEngineRoot 'C:\tools\CE'
```

The installer reads the existing backend configurations, creates a boot-started
Gateway service, and registers a per-user agent that starts at logon. It does not
modify either backend installation.

GUI lifecycle operations are available only while the installing user is logged
in. The Gateway endpoint remains online when that user is logged out.

Open a new terminal and register the public endpoint:

```powershell
codex mcp add dynamic-analysis `
  --url http://127.0.0.1:8000/mcp `
  --bearer-token-env-var DYNAMIC_ANALYSIS_MCP_TOKEN
```

Operational details and uninstall commands are in
[`docs/service-with-user-agent.md`](docs/service-with-user-agent.md). Configuration
and secret handling are described in
[`docs/configuration.md`](docs/configuration.md).

## Development

Requirements: Node.js 24.20.0, npm 11.19.0, and Bun for the self-contained
Windows executable.

```powershell
npm ci
npm run check
npm run build
npm run build:exe
npm run test:install
npm run package:windows
```

The executable defaults to
`%ProgramData%\DynamicAnalysisMcpGateway\gateway.toml`. Use `--config <path>` to
select another file, `--check-config` to validate configuration, or `--version`
to print the version.

## Reference

- [Architecture](docs/architecture/0001-gateway-mvp.md)
- [Backend naming compatibility](docs/contracts/backend-naming-compatibility.md)
- [Debugger restart contract](docs/contracts/debugger-restart-v1.md)
