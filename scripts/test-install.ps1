$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('gateway-install-test-' + [guid]::NewGuid().ToString('N'))
try {
    $package = Join-Path $root 'package'; $xroot = Join-Path $root 'x64dbg'; $ceroot = Join-Path $root 'CE'
    New-Item -ItemType Directory -Force -Path (Join-Path $package 'service'),(Join-Path $package 'config'),(Join-Path $package 'scripts'),(Join-Path $xroot 'release\mcp'),(Join-Path $ceroot 'mcp') | Out-Null
    Copy-Item (Join-Path $workspace 'dist\dynamic-analysis-mcp-gateway.exe') (Join-Path $package 'dynamic-analysis-mcp-gateway.exe')
    Copy-Item (Join-Path $workspace 'config\gateway.example.toml') (Join-Path $package 'config')
    Copy-Item (Join-Path $workspace 'scripts\service-launch.ps1') (Join-Path $package 'scripts')
    [IO.File]::WriteAllText((Join-Path $package 'service\WinSW-x64.exe'),'fixture')
    [IO.File]::WriteAllText((Join-Path $xroot 'release\mcp\x96dbg-mcp-control.exe'),'fixture')
    $token = 'debugger-token-abcdefghijklmnopqrstuvwxyz-0123456789'
    foreach ($entry in @(@('x32',43132),@('x64',43164))) { [IO.File]::WriteAllText((Join-Path $xroot "release\mcp\x64dbg-mcp-server-$($entry[0]).toml"),"bind = `"127.0.0.1`"`nport = $($entry[1])`nbearer_token = `"$token`"") }
    [IO.File]::WriteAllText((Join-Path $ceroot 'mcp\config.json'),'{"transport":"streamable-http","host":"127.0.0.1","port":8001,"tokenFile":"http.token"}')
    [IO.File]::WriteAllText((Join-Path $ceroot 'mcp\http.token'),'ce-token-abcdefghijklmnopqrstuvwxyz-0123456789')
    $backendHashes = @(Get-ChildItem -LiteralPath $xroot,$ceroot -Recurse -File | Get-FileHash | Select-Object Path,Hash)
    $installRoot = Join-Path $root 'installed'; $dataRoot = Join-Path $root 'data'
    & (Join-Path $workspace 'scripts\install.ps1') -X64dbgRoot $xroot -CheatEngineRoot $ceroot -PackageRoot $package -InstallRoot $installRoot -DataRoot $dataRoot -SkipRegistration
    $firstGatewayToken = [IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.token'))
    $firstAgentToken = [IO.File]::ReadAllText((Join-Path $dataRoot 'agent.token'))
    $firstPipe = ([regex]::Match([IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.toml')), '(?m)^pipeName = "([^"]+)"')).Value
    & (Join-Path $workspace 'scripts\install.ps1') -X64dbgRoot $xroot -CheatEngineRoot $ceroot -PackageRoot $package -InstallRoot $installRoot -DataRoot $dataRoot -SkipRegistration -Reconfigure
    if ([IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.token')) -cne $firstGatewayToken) { throw 'reconfigure rotated the Gateway token' }
    $config = [IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.toml'))
    if ($config -notmatch '127\.0\.0\.1:43164/mcp' -or $config -notmatch 'mode = "local"' -or $config -notmatch '\[interactiveAgent\]') { throw 'generated Gateway configuration is invalid' }
    if (!$config.Contains($firstPipe) -or [IO.File]::ReadAllText((Join-Path $dataRoot 'agent.token')) -cne $firstAgentToken) { throw 'reconfigure changed agent identity or token' }
    if ($config.Contains($token) -or $config.Contains('ce-token-abcdefghijklmnopqrstuvwxyz-0123456789')) { throw 'generated config contains a backend secret' }
    if ([IO.File]::ReadAllText((Join-Path $dataRoot 'x64dbg.token')) -cne $token) { throw 'x64dbg service secret was not synchronized' }
    $serviceXml = [IO.File]::ReadAllText((Join-Path $installRoot 'DynamicAnalysisMcpGatewayService.xml'))
    if ($serviceXml.Contains($token) -or $serviceXml.Contains('CE_MCP_TOKEN')) { throw 'service XML contains secret material' }
    [xml]$parsedService = $serviceXml
    if ($parsedService.service.id -ne 'DynamicAnalysisMcpGateway' -or $parsedService.service.startmode -ne 'Automatic') { throw 'service XML contract is invalid' }
    $suppliedTokenFile = Join-Path $root 'supplied.token'
    $suppliedToken = 'supplied-gateway-token-abcdefghijklmnopqrstuvwxyz-0123456789'
    [IO.File]::WriteAllText($suppliedTokenFile, "$suppliedToken`r`n")
    $options = @{ X64dbgRoot = $xroot; PackageRoot = $package; InstallRoot = $installRoot; DataRoot = $dataRoot; SkipRegistration = $true }
    $rejected = $false
    try { & (Join-Path $workspace 'scripts\install.ps1') @options -GatewayBind '0.0.0.0' } catch { $rejected = $true }
    if (!$rejected) { throw 'wildcard binding accepted without opt-in' }
    $output = & (Join-Path $workspace 'scripts\install.ps1') @options -GatewayBind '0.0.0.0' -GatewayPort 8000 -AllowBearerOnlyHttp -GatewayTokenFile $suppliedTokenFile -Reconfigure
    if ($output -notcontains 'Gateway bind listener: http://0.0.0.0:8000/mcp' -or ($output -match 'codex mcp add')) { throw 'installer must report the bind listener without inventing a client URL' }
    $config = [IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.toml'))
    if ($config -notmatch 'bind = "0.0.0.0"' -or $config -notmatch 'mode = "bearer-only-http"' -or $config -notmatch '\[ce\]\r?\nenabled = false' -or $config.Contains('trustedProxyCidrs')) { throw 'LAN HTTP configuration is invalid' }
    if (Test-Path (Join-Path $dataRoot 'ce.token')) { throw 'disabled CE retained credential copy' }
    if ([IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.token')) -cne $suppliedToken) { throw 'supplied token was not installed' }
    if ($config.Contains($suppliedToken)) { throw 'config contains supplied secret' }
    & (Join-Path $workspace 'scripts\install.ps1') @options -Reconfigure
    $config = [IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.toml'))
    if ($config -notmatch 'bind = "127.0.0.1"' -or $config -notmatch 'mode = "local"') { throw 'omitted listener options did not restore defaults' }
    if ([IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.token')) -cne $suppliedToken) { throw 'omitted token option rotated token' }
    $afterHashes = @(Get-ChildItem -LiteralPath $xroot,$ceroot -Recurse -File | Get-FileHash | Select-Object Path,Hash)
    if (Compare-Object $backendHashes $afterHashes -Property Path,Hash) { throw 'installer mutated backend installations' }
    & (Join-Path $workspace 'scripts\uninstall.ps1') -InstallRoot $installRoot -DataRoot $dataRoot -SkipRegistration
    if (Test-Path $installRoot) { throw 'uninstall retained binaries' }
    if (!(Test-Path $dataRoot)) { throw 'uninstall removed data without PurgeData' }
    & (Join-Path $workspace 'scripts\uninstall.ps1') -InstallRoot $installRoot -DataRoot $dataRoot -SkipRegistration -PurgeData
    if (Test-Path $dataRoot) { throw 'PurgeData retained Gateway data' }
    Write-Output 'installer contract tests passed'
} finally {
    if (Test-Path $root) {
        for ($attempt = 1; $attempt -le 10; $attempt++) {
            try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop; break }
            catch { if ($attempt -eq 10) { throw }; Start-Sleep -Milliseconds 250 }
        }
    }
}
