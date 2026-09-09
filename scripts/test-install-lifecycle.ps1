$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'install.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Installer parse errors: $errors" }
foreach ($name in @('Copy-GatewayFile','Stop-InstalledGateway')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}

# Mock the Windows control plane: this test never touches registered services/tasks.
$existingService = 'C:\test\DynamicAnalysisMcpGatewayService.exe'
$gatewayExe = 'C:\test\dynamic-analysis-mcp-gateway.exe'
$sid = 'S-1-5-21-123'; $pipeName = 'dynamic-analysis-mcp-agent-test'
$arguments = '--user-agent --pipe-name "dynamic-analysis-mcp-agent-test" --agent-token-file "C:\data\agent.token" --x64dbg-root "C:\backend"'
$script:events = [Collections.Generic.List[string]]::new()
$script:service = $null; $script:task = $null; $script:processes = @()
$script:processOwnerSid = $sid
function Get-CimInstance { param($ClassName, $Filter) if ($ClassName -eq 'Win32_Service') { return $script:service }; return $script:processes }
function Get-ScheduledTask { param($TaskPath) return $script:task }
function Stop-Service { param($Name, $ErrorAction) $script:events.Add('service-stop'); if ($script:stopFails) { throw 'stop failed' } }
function Get-Service {
    param($Name)
    $value = [pscustomobject]@{}
    $value | Add-Member ScriptMethod WaitForStatus { param($status, $timeout) $script:events.Add('service-wait') }
    return $value
}
function Disable-ScheduledTask { param($InputObject) $script:events.Add('task-disable') }
function Stop-ScheduledTask { param($InputObject) $script:events.Add('task-stop') }
function Invoke-CimMethod {
    param($InputObject, $MethodName)
    if ($script:cimFailure -and $MethodName -eq $script:cimFailureMethod) {
        $script:processes = @()
        throw $script:cimFailure
    }
    if ($MethodName -eq 'GetOwnerSid') { return @{ ReturnValue = 0; Sid = $script:processOwnerSid } }
    $script:events.Add("terminate-$($InputObject.ProcessId)")
    $script:processes = @($script:processes | Where-Object ProcessId -ne $InputObject.ProcessId)
    return @{ ReturnValue = 0 }
}
function Assert-Rejected {
    $rejected = $false
    try { Stop-InstalledGateway } catch { $rejected = $true }
    if (!$rejected) { throw 'Expected ownership/shutdown rejection' }
}
$script:service = @{ PathName = '"C:\other\service.exe"' }
Assert-Rejected
if ($script:events.Count) { throw 'Foreign service was touched' }
$script:service = @{ PathName = '"' + $existingService + '"' }
$script:task = [pscustomobject]@{ TaskName = 'DynamicAnalysisMcpGatewayUserAgent'; Principal = @{ UserId = 'S-1-5-21-999' }; Actions = @(@{ Execute = $gatewayExe; Arguments = $arguments }) }
Assert-Rejected
if ($script:events.Count) { throw 'Foreign task owner was touched' }
$script:task.Principal.UserId = $sid
$script:task.Actions[0].Execute = 'C:\other\gateway.exe'
Assert-Rejected
if ($script:events.Count) { throw 'Foreign task path was touched' }
$script:task.Actions[0].Execute = $gatewayExe
$script:stopFails = $true
Assert-Rejected
if (($script:events -join ',') -ne 'service-stop') { throw 'Shutdown continued after service stop failure' }
$script:stopFails = $false; $script:service = $null; $script:events.Clear()
$script:processes = @(
    [pscustomobject]@{ ProcessId = 1; ExecutablePath = $gatewayExe; CommandLine = '"' + $gatewayExe + '" ' + $arguments },
    [pscustomobject]@{ ProcessId = 2; ExecutablePath = 'C:\other\gateway.exe'; CommandLine = $arguments },
    [pscustomobject]@{ ProcessId = 3; ExecutablePath = $gatewayExe; CommandLine = '--config unrelated.toml' }
)
Stop-InstalledGateway
if (($script:events -join ',') -ne 'task-disable,task-stop,terminate-1') { throw 'Agent shutdown was not scoped to installed action' }
if ($script:processes.Count -ne 2) { throw 'Unrelated processes were changed' }
$script:events.Clear()
$script:processOwnerSid = 'S-1-5-21-999'
$script:processes = @([pscustomobject]@{ ProcessId = 4; ExecutablePath = $gatewayExe; CommandLine = '"' + $gatewayExe + '" ' + $arguments })
Assert-Rejected
if (($script:events -join ',') -ne 'task-disable,task-stop' -or $script:processes.Count -ne 1) { throw 'Foreign process owner was terminated' }

# Obtain a real missing-instance error without starting or stopping a process.
$missingProcess = New-CimInstance -ClassName Win32_Process -Namespace root/cimv2 -ClientOnly -Key Handle -Property @{ Handle = '4294967295' }
$notFound = $null
try { CimCmdlets\Invoke-CimMethod -InputObject $missingProcess -MethodName GetOwnerSid -ErrorAction Stop }
catch [Microsoft.Management.Infrastructure.CimException] { $notFound = $_.Exception }
if (!$notFound -or $notFound.NativeErrorCode -ne [Microsoft.Management.Infrastructure.NativeErrorCode]::NotFound) { throw 'Missing-process CIM fixture did not return NotFound' }
$script:processOwnerSid = $sid
foreach ($failure in @($notFound, [Microsoft.Management.Infrastructure.CimException]::new('other CIM failure'))) {
    $script:cimFailure = $failure
    foreach ($method in @('GetOwnerSid','Terminate')) {
        $script:cimFailureMethod = $method
        $script:processes = @([pscustomobject]@{ ProcessId = 5; ExecutablePath = $gatewayExe; CommandLine = '"' + $gatewayExe + '" ' + $arguments })
        if ($failure.NativeErrorCode -eq [Microsoft.Management.Infrastructure.NativeErrorCode]::NotFound) { Stop-InstalledGateway } else { Assert-Rejected }
    }
}
$script:cimFailure = $null

# Exercise real Windows sharing violations, including a persistent lock and a non-lock error.
$root = Join-Path ([IO.Path]::GetTempPath()) ('gateway-copy-test-' + [guid]::NewGuid().ToString('N'))
$job = $null
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $source = Join-Path $root 'source.exe'; $destination = Join-Path $root 'destination.exe'
    [IO.File]::WriteAllText($source, 'new'); [IO.File]::WriteAllText($destination, 'old')
    $job = Start-Job -ArgumentList $destination -ScriptBlock {
        param($path)
        $lock = [IO.File]::Open($path, 'Open', 'Read', 'Read')
        try { Write-Output 'locked'; Start-Sleep -Seconds 2 } finally { $lock.Dispose() }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while (!(Receive-Job $job -Keep)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Lock fixture did not start' }
        Start-Sleep -Milliseconds 50
    }
    Copy-GatewayFile $source $destination
    if ([IO.File]::ReadAllText($destination) -ne 'new') { throw 'Transient-lock replacement failed' }
    $lock = [IO.File]::Open($destination, 'Open', 'Read', 'Read')
    try {
        $rejected = $false
        try { Copy-GatewayFile $source $destination } catch { $rejected = $true }
        if (!$rejected) { throw 'Persistent lock was ignored' }
    } finally { $lock.Dispose() }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $rejected = $false
    try { Copy-GatewayFile (Join-Path $root 'missing.exe') $destination } catch { $rejected = $true }
    if (!$rejected -or $timer.Elapsed.TotalSeconds -gt 2) { throw 'Non-lock errors must fail immediately' }
    Write-Output 'installer lifecycle tests passed'
} finally {
    if ($job) { Stop-Job $job; Remove-Job $job }
    if (Test-Path $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
