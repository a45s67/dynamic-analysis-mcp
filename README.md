# Dynamic Analysis MCP Gateway

One authenticated MCP endpoint federating independently usable localhost CE,
x64dbg, and x32dbg MCP backends.

The accepted MVP boundary is documented in
[`docs/architecture/0001-gateway-mvp.md`](docs/architecture/0001-gateway-mvp.md).
Observed backend naming differences and the preservation contract are documented
in
[`docs/contracts/backend-naming-compatibility.md`](docs/contracts/backend-naming-compatibility.md).

## Development status

The initial vertical slice implements deterministic backend namespace rewriting,
conservative safety classification, canonical catalog hashing, immutable snapshot
publication, snapshot-bound single-attempt routing, an authenticated Streamable
HTTP endpoint, and an official-SDK downstream HTTP client. Integration tests run
an official MCP client through the Gateway into a second fake MCP HTTP server.

Strict TOML configuration loading and the initial runtime discovery path are now
implemented. Optional flat backend lifecycle commands and the bounded
`gateway.backend_control` management tool are also implemented. Stateful
upstream session tracking, catalog-change signaling,
backend health thresholds, direct TLS, and installer/service packaging remain
subsequent MVP phases.

The configuration format and Windows secret layout are documented in
[`docs/configuration.md`](docs/configuration.md). The single convention is a TOML
`tokenEnv` reference for each endpoint; tokens are never placed literally in
TOML and the Gateway does not own backend secret storage.

## Toolchain

- Node.js 24.20.0 LTS
- npm 11.19.0
- TypeScript 6.0.2 in strict ESM mode
- MCP TypeScript SDK v2 split packages

Install exactly the locked dependency graph and verify the current slice:

```powershell
npm ci
npm run check
npm run build
```

Build the preferred self-contained Windows executable and perform a no-config
startup check:

```powershell
npm run build:exe
.\dist\dynamic-analysis-mcp-gateway.exe --version
```

The EXE does not embed configuration or secrets. At runtime it defaults to
`%ProgramData%\DynamicAnalysisMcpGateway\gateway.toml`; use `--config <path>` to
select another file or `--check-config` to validate it without listening.
