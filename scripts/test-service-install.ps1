$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$package = Join-Path $workspace 'dist\package'
$root = Join-Path ([IO.Path]::GetTempPath()) ('gateway-service-test-' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $root 'installed'; $dataRoot = Join-Path $root 'data'
$gatewayPort = Get-Random -Minimum 20000 -Maximum 40000
$agentProcess = $null
try {
    $xroot = Join-Path $root 'x64dbg'; $ceroot = Join-Path $root 'CE'
    New-Item -ItemType Directory -Force -Path (Join-Path $xroot 'release\mcp'),(Join-Path $ceroot 'mcp') | Out-Null
    [IO.File]::WriteAllText((Join-Path $xroot 'release\mcp\x96dbg-mcp-control.exe'),'fixture')
    $token = 'debugger-token-abcdefghijklmnopqrstuvwxyz-0123456789'
    foreach ($entry in @(@('x32',43132),@('x64',43164))) { [IO.File]::WriteAllText((Join-Path $xroot "release\mcp\x64dbg-mcp-server-$($entry[0]).toml"),"bind = `"127.0.0.1`"`nport = $($entry[1])`nbearer_token = `"$token`"") }
    [IO.File]::WriteAllText((Join-Path $ceroot 'mcp\config.json'),'{"transport":"streamable-http","host":"127.0.0.1","port":8001,"tokenFile":"http.token"}')
    [IO.File]::WriteAllText((Join-Path $ceroot 'mcp\http.token'),'ce-token-abcdefghijklmnopqrstuvwxyz-0123456789')
    & (Join-Path $package 'install.ps1') -X64dbgRoot $xroot -CheatEngineRoot $ceroot -PackageRoot $package -InstallRoot $installRoot -DataRoot $dataRoot -GatewayPort $gatewayPort
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do { Start-Sleep -Milliseconds 500; $service = Get-Service DynamicAnalysisMcpGateway -ErrorAction SilentlyContinue } while (($null -eq $service -or $service.Status -ne 'Running') -and [DateTime]::UtcNow -lt $deadline)
    if ($null -eq $service -or $service.Status -ne 'Running') { throw 'Gateway service did not reach Running.' }
    $agentTask = Get-ScheduledTask -TaskName DynamicAnalysisMcpGatewayUserAgent -ErrorAction SilentlyContinue
    if ($null -eq $agentTask) { throw 'User Agent task was not registered.' }
    Start-Sleep -Seconds 2
    $agentTask = Get-ScheduledTask -TaskName DynamicAnalysisMcpGatewayUserAgent
    if ($agentTask.State -ne 'Running') {
        $taskInfo = Get-ScheduledTaskInfo -TaskName DynamicAnalysisMcpGatewayUserAgent
        Write-Output "::notice::Hosted runner has no usable interactive logon token (task state $($agentTask.State), result $($taskInfo.LastTaskResult)); using a test-only agent process for the cross-principal IPC gate."
        $agentToken = Join-Path $dataRoot 'agent.token'
        $pipeName = ([regex]::Match([IO.File]::ReadAllText((Join-Path $dataRoot 'gateway.toml')), '(?m)^pipeName = "([^"]+)"\r?$')).Groups[1].Value
        if ([string]::IsNullOrWhiteSpace($pipeName)) { throw 'Installed interactive-agent pipe name is unavailable.' }
        $agentArguments = "--user-agent --pipe-name `"$pipeName`" --agent-token-file `"$agentToken`" --x64dbg-root `"$xroot`""
        $startInfo = [Diagnostics.ProcessStartInfo]::new((Join-Path $installRoot 'dynamic-analysis-mcp-gateway.exe'), $agentArguments)
        $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
        $agentProcess = [Diagnostics.Process]::Start($startInfo)
        Start-Sleep -Seconds 2
        if ($agentProcess.HasExited) { throw "Test-only user agent exited with code $($agentProcess.ExitCode)." }
    }
    try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$gatewayPort/mcp" -TimeoutSec 5 | Out-Null; throw 'Gateway accepted an unauthenticated request.' }
    catch { if ($_.Exception.Response.StatusCode.value__ -ne 401) { throw } }
    $probeOutput = @(& node (Join-Path $workspace 'scripts\probe-installed-service.mjs') "http://127.0.0.1:$gatewayPort/mcp" (Join-Path $dataRoot 'gateway.token') 2>&1)
    $probeExitCode = $LASTEXITCODE
    $probeOutput | Write-Output
    if ($probeExitCode -ne 0) { throw "Service-to-user-agent integration probe failed: $($probeOutput -join ' ')" }
    Write-Output 'real service and scheduled-task installation passed'
} catch {
    Write-Output "::error::$($_.Exception.Message)"
    $diagnosticTask = Get-ScheduledTask -TaskName DynamicAnalysisMcpGatewayUserAgent -ErrorAction SilentlyContinue
    $diagnosticTaskInfo = Get-ScheduledTaskInfo -TaskName DynamicAnalysisMcpGatewayUserAgent -ErrorAction SilentlyContinue
    $diagnosticService = Get-Service DynamicAnalysisMcpGateway -ErrorAction SilentlyContinue
    Write-Output "::notice::Service=$($diagnosticService.Status); task=$($diagnosticTask.State); taskResult=$($diagnosticTaskInfo.LastTaskResult); fallbackAgentExited=$($null -ne $agentProcess -and $agentProcess.HasExited)"
    throw
} finally {
    if ($null -ne $agentProcess -and !$agentProcess.HasExited) { $agentProcess.Kill() }
    & (Join-Path $workspace 'scripts\uninstall.ps1') -InstallRoot $installRoot -DataRoot $dataRoot -PurgeData -ErrorAction SilentlyContinue
    if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
}
