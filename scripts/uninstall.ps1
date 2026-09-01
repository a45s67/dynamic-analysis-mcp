[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$InstallRoot = "$env:ProgramFiles\DynamicAnalysisMcpGateway",
    [string]$DataRoot = "$env:ProgramData\DynamicAnalysisMcpGateway",
    [switch]$SkipRegistration,
    [switch]$PurgeData
)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$DataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
foreach ($target in @($InstallRoot,$DataRoot)) {
    if ($target -eq [IO.Path]::GetPathRoot($target) -or [string]::IsNullOrWhiteSpace((Split-Path -Leaf $target))) {
        throw 'Refusing an unsafe uninstall target.'
    }
}
function Remove-OwnedTree([string]$Path) {
    if (!(Test-Path -LiteralPath $Path)) { return }
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop; return }
        catch { if ($attempt -eq 10) { throw }; Start-Sleep -Milliseconds 250 }
    }
}
$service = Join-Path $InstallRoot 'DynamicAnalysisMcpGatewayService.exe'
if ($PSCmdlet.ShouldProcess('DynamicAnalysisMcpGateway', 'Uninstall service and user agent')) {
    $installedGatewayToken = if (Test-Path -LiteralPath (Join-Path $DataRoot 'gateway.token')) { [IO.File]::ReadAllText((Join-Path $DataRoot 'gateway.token')) } else { $null }
    if (!$SkipRegistration) {
        Stop-ScheduledTask -TaskName 'DynamicAnalysisMcpGatewayUserAgent' -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName 'DynamicAnalysisMcpGatewayUserAgent' -Confirm:$false -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $service) {
            & $service stop 2>$null | Out-Null
            & $service uninstall 2>$null | Out-Null
        }
    }
    Remove-OwnedTree $InstallRoot
    if ($PurgeData -and (Test-Path -LiteralPath $DataRoot)) {
        Remove-OwnedTree $DataRoot
        if ($null -ne $installedGatewayToken -and [Environment]::GetEnvironmentVariable('DYNAMIC_ANALYSIS_MCP_TOKEN','User') -ceq $installedGatewayToken) {
            [Environment]::SetEnvironmentVariable('DYNAMIC_ANALYSIS_MCP_TOKEN',$null,'User')
        }
    }
}
