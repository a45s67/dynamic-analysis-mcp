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
    $installRoot = Join-Path $root 'installed'; $dataRoot = Join-Path $root 'data'
    & (Join-Path $workspace 'scripts\install.ps1') -X64dbgRoot $xroot -CheatEngineRoot $ceroot -PackageRoot $package -InstallRoot $installRoot -DataRoot $dataRoot -SkipRegistration
    $firstGatewayToken = [IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.token'))
    & (Join-Path $workspace 'scripts\install.ps1') -X64dbgRoot $xroot -CheatEngineRoot $ceroot -PackageRoot $package -InstallRoot $installRoot -DataRoot $dataRoot -SkipRegistration -Reconfigure
    if ([IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.token')) -cne $firstGatewayToken) { throw 'reconfigure rotated the Gateway token' }
    $config = [IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.toml'))
    if ($config -notmatch '127\.0\.0\.1:43164/mcp' -or $config -notmatch 'mode = "local"' -or $config -notmatch '\[interactiveAgent\]') { throw 'generated Gateway configuration is invalid' }
    if ($config.Contains($token) -or $config.Contains('ce-token-abcdefghijklmnopqrstuvwxyz-0123456789')) { throw 'generated config contains a backend secret' }
    if ([IO.File]::ReadAllText((Join-Path $dataRoot 'x64dbg.token')) -cne $token) { throw 'x64dbg service secret was not synchronized' }
    $serviceXml = [IO.File]::ReadAllText((Join-Path $installRoot 'DynamicAnalysisMcpGatewayService.xml'))
    if ($serviceXml.Contains($token) -or $serviceXml.Contains('CE_MCP_TOKEN')) { throw 'service XML contains secret material' }
    [xml]$parsedService = $serviceXml
    if ($parsedService.service.id -ne 'DynamicAnalysisMcpGateway' -or $parsedService.service.startmode -ne 'Automatic') { throw 'service XML contract is invalid' }
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
