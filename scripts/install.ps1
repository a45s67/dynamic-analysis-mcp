[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('ServiceWithUserAgent')][string]$Mode = 'ServiceWithUserAgent',
    [Parameter(Mandatory)][string]$X64dbgRoot,
    [string]$CheatEngineRoot,
    [ValidateSet('127.0.0.1','0.0.0.0')][string]$GatewayBind = '127.0.0.1',
    [switch]$AllowBearerOnlyHttp,
    [string]$GatewayTokenFile,
    [ValidateRange(1,65535)][int]$GatewayPort = 8000,
    [string]$PackageRoot,
    [string]$InstallRoot = "$env:ProgramFiles\DynamicAnalysisMcpGateway",
    [string]$DataRoot = "$env:ProgramData\DynamicAnalysisMcpGateway",
    [switch]$Reconfigure,
    [switch]$SkipClientEnvironment,
    [switch]$SkipRegistration
)
$ErrorActionPreference = 'Stop'
if ($Mode -ne 'ServiceWithUserAgent') { throw 'Unsupported install mode.' }
if ($GatewayBind -eq '0.0.0.0' -and !$AllowBearerOnlyHttp) { throw 'Wildcard binding requires -AllowBearerOnlyHttp.' }
$suppliedGatewayToken = $null
if ($GatewayTokenFile) {
    $tokenItem = Get-Item -LiteralPath $GatewayTokenFile -Force
    if ($tokenItem.PSIsContainer -or $tokenItem.Length -gt 4096) { throw 'Gateway token file is invalid.' }
    $suppliedGatewayToken = [IO.File]::ReadAllText($tokenItem.FullName).TrimEnd("`r", "`n")
    if ($suppliedGatewayToken.Length -lt 32 -or $suppliedGatewayToken.Length -gt 512 -or $suppliedGatewayToken -match '[^\x21-\x7e]') {
        throw 'Gateway token must contain 32..512 visible ASCII characters.'
    }
}
if (!$SkipRegistration) {
    $administrator = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (!$administrator.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'ServiceWithUserAgent installation requires an elevated administrator session.'
    }
}
if ([string]::IsNullOrWhiteSpace($PackageRoot)) { $PackageRoot = $PSScriptRoot }
$package = (Resolve-Path -LiteralPath $PackageRoot).Path
$xRoot = (Resolve-Path -LiteralPath $X64dbgRoot).Path
$ceRoot = if ($CheatEngineRoot) { (Resolve-Path -LiteralPath $CheatEngineRoot).Path } else { $null }
$debuggerRoot = if (Test-Path -LiteralPath (Join-Path $xRoot 'release\mcp')) { Join-Path $xRoot 'release' } else { $xRoot }
$mcpRoot = Join-Path $debuggerRoot 'mcp'
$controller = Join-Path $mcpRoot 'x96dbg-mcp-control.exe'
$x32Config = Join-Path $mcpRoot 'x64dbg-mcp-server-x32.toml'
$x64Config = Join-Path $mcpRoot 'x64dbg-mcp-server-x64.toml'
foreach ($required in @($controller,$x32Config,$x64Config)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required backend file is missing: $required" }
}
function Read-XConfig([string]$Path) {
    $text = [IO.File]::ReadAllText($Path)
    $port = [regex]::Match($text, '(?m)^port = ([0-9]+)\r?$')
    $token = [regex]::Match($text, '(?m)^bearer_token = "([^"\r\n]+)"\r?$')
    if (!$port.Success -or !$token.Success) { throw "Invalid x64dbg MCP config: $Path" }
    [pscustomobject]@{ Port = [int]$port.Groups[1].Value; Token = $token.Groups[1].Value }
}
$x32 = Read-XConfig $x32Config
$x64 = Read-XConfig $x64Config
if ($x32.Token -cne $x64.Token) { throw 'Installed x32dbg and x64dbg tokens differ.' }
if ($ceRoot) {
    $ceConfigPath = Join-Path $ceRoot 'mcp\config.json'
    $ceConfig = Get-Content -LiteralPath $ceConfigPath -Raw | ConvertFrom-Json
    if ($ceConfig.transport -ne 'streamable-http' -or !$ceConfig.port -or !$ceConfig.tokenFile) {
        throw 'Installed CE MCP configuration is incompatible.'
    }
    $ceToken = Join-Path (Split-Path -Parent $ceConfigPath) $ceConfig.tokenFile
    if (!(Test-Path -LiteralPath $ceToken -PathType Leaf)) { throw 'Installed CE MCP token file is missing.' }
}

$gatewaySource = Join-Path $package 'dynamic-analysis-mcp-gateway.exe'
$winswSource = Join-Path $package 'service\WinSW-x64.exe'
$templateSource = Join-Path $package 'config\gateway.example.toml'
$launcherSource = Join-Path $package 'scripts\service-launch.ps1'
foreach ($required in @($gatewaySource,$winswSource,$templateSource,$launcherSource)) {
    if (!(Test-Path -LiteralPath $required -PathType Leaf)) { throw "Package file is missing: $required" }
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$hasher = [Security.Cryptography.SHA256]::Create()
try { $sha = $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($sid)) } finally { $hasher.Dispose() }
$sidHash = -join ($sha[0..7] | ForEach-Object { $_.ToString('x2') })
$pipeName = "dynamic-analysis-mcp-agent-$sidHash"

if ($PSCmdlet.ShouldProcess($InstallRoot, 'Install Dynamic Analysis MCP Gateway')) {
    $existingService = Join-Path $InstallRoot 'DynamicAnalysisMcpGatewayService.exe'
    if (!$SkipRegistration) {
        Stop-ScheduledTask -TaskName 'DynamicAnalysisMcpGatewayUserAgent' -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $existingService -PathType Leaf) {
            & $existingService stop 2>$null | Out-Null
            & $existingService uninstall 2>$null | Out-Null
        }
    }
    New-Item -ItemType Directory -Force -Path $InstallRoot,$DataRoot | Out-Null
    Copy-Item -LiteralPath $gatewaySource -Destination (Join-Path $InstallRoot 'dynamic-analysis-mcp-gateway.exe') -Force
    Copy-Item -LiteralPath $winswSource -Destination (Join-Path $InstallRoot 'DynamicAnalysisMcpGatewayService.exe') -Force
    Copy-Item -LiteralPath $launcherSource -Destination (Join-Path $InstallRoot 'service-launch.ps1') -Force
    foreach ($secretName in @('gateway.token','agent.token')) {
        $secretPath = Join-Path $DataRoot $secretName
        if (!(Test-Path -LiteralPath $secretPath)) {
            $bytes = New-Object byte[] 48
            $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
            [IO.File]::WriteAllText($secretPath, [Convert]::ToBase64String($bytes))
        }
    }
    [IO.File]::WriteAllText((Join-Path $DataRoot 'x64dbg.token'), $x64.Token)
    if ($suppliedGatewayToken) { [IO.File]::WriteAllText((Join-Path $DataRoot 'gateway.token'), $suppliedGatewayToken) }
    if ($ceRoot) {
        [IO.File]::WriteAllText((Join-Path $DataRoot 'ce.token'), [IO.File]::ReadAllText($ceToken).TrimEnd("`r","`n"))
    } elseif (Test-Path -LiteralPath (Join-Path $DataRoot 'ce.token')) {
        Remove-Item -LiteralPath (Join-Path $DataRoot 'ce.token') -Force
    }
    $config = [IO.File]::ReadAllText($templateSource)
    $config = $config.Replace('bind = "10.20.0.15"',"bind = `"$GatewayBind`"")
    $config = $config.Replace('port = 8000',"port = $GatewayPort")
    $config = $config.Replace("[server.tls]`r`nmode = `"proxy`"`r`ntrustedProxyCidrs = [`"10.20.0.1/32`"]","[server.tls]`r`nmode = `"local`"")
    $config = $config.Replace("[server.tls]`nmode = `"proxy`"`ntrustedProxyCidrs = [`"10.20.0.1/32`"]","[server.tls]`nmode = `"local`"")
    if ($AllowBearerOnlyHttp) { $config = $config.Replace('mode = "local"','mode = "bearer-only-http"') }
    $config = $config.Replace('http://127.0.0.1:43164/mcp',"http://127.0.0.1:$($x64.Port)/mcp")
    $config = $config.Replace('http://127.0.0.1:43132/mcp',"http://127.0.0.1:$($x32.Port)/mcp")
    if ($ceRoot) {
        $config = $config.Replace('http://127.0.0.1:8001/mcp',"http://127.0.0.1:$($ceConfig.port)/mcp")
    } else {
        $config = $config -replace '(\[ce\]\r?\nenabled = )true', '${1}false'
    }
    $config += "`r`n[interactiveAgent]`r`npipeName = `"$pipeName`"`r`ntokenEnv = `"DYNAMIC_ANALYSIS_AGENT_TOKEN`"`r`n"
    $configPath = Join-Path $DataRoot 'gateway.toml'
    [IO.File]::WriteAllText($configPath, $config)
    $serviceExe = Join-Path $InstallRoot 'DynamicAnalysisMcpGatewayService.exe'
    $gatewayExe = Join-Path $InstallRoot 'dynamic-analysis-mcp-gateway.exe'
    $launcher = Join-Path $InstallRoot 'service-launch.ps1'
    $xml = @"
<service><id>DynamicAnalysisMcpGateway</id><name>Dynamic Analysis MCP Gateway</name>
<description>Authenticated federation gateway for local dynamic-analysis MCP backends.</description>
<executable>powershell.exe</executable>
<arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -File &quot;$launcher&quot; -GatewayExe &quot;$gatewayExe&quot; -ConfigFile &quot;$configPath&quot; -DataRoot &quot;$DataRoot&quot;</arguments>
<startmode>Automatic</startmode><stoptimeout>30sec</stoptimeout><onfailure action="restart" delay="10 sec"/><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>4</keepFiles></log></service>
"@
    [IO.File]::WriteAllText((Join-Path $InstallRoot 'DynamicAnalysisMcpGatewayService.xml'), $xml)
    if (!$SkipRegistration) {
        icacls $DataRoot /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "${sid}:(OI)(CI)R" | Out-Null
    }
    $env:DYNAMIC_ANALYSIS_MCP_TOKEN = [IO.File]::ReadAllText((Join-Path $DataRoot 'gateway.token'))
    $env:DYNAMIC_ANALYSIS_AGENT_TOKEN = [IO.File]::ReadAllText((Join-Path $DataRoot 'agent.token'))
    $env:X64DBG_MCP_TOKEN = $x64.Token
    $env:CE_MCP_TOKEN = if ($ceRoot) { [IO.File]::ReadAllText($ceToken).TrimEnd("`r","`n") } else { $null }
    try {
        & $gatewayExe --config $configPath --check-config
        if ($LASTEXITCODE -ne 0) { throw 'Gateway configuration validation failed.' }
    } finally {
        $env:DYNAMIC_ANALYSIS_MCP_TOKEN = $null; $env:DYNAMIC_ANALYSIS_AGENT_TOKEN = $null
        $env:X64DBG_MCP_TOKEN = $null; $env:CE_MCP_TOKEN = $null
    }
    if (!$SkipRegistration) {
        & $serviceExe install
        $agentArguments = "--user-agent --pipe-name `"$pipeName`" --agent-token-file `"$(Join-Path $DataRoot 'agent.token')`" --x64dbg-root `"$xRoot`""
        $action = New-ScheduledTaskAction -Execute $gatewayExe -Argument $agentArguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
        $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName 'DynamicAnalysisMcpGatewayUserAgent' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
        & $serviceExe start
        Start-ScheduledTask -TaskName 'DynamicAnalysisMcpGatewayUserAgent'
        if (!$SkipClientEnvironment) {
            [Environment]::SetEnvironmentVariable('DYNAMIC_ANALYSIS_MCP_TOKEN',[IO.File]::ReadAllText((Join-Path $DataRoot 'gateway.token')),'User')
        }
    }
    $verb = if ($Reconfigure) { 'reconfigured' } else { 'installed' }
    Write-Output "Gateway $verb in $Mode mode for owner SID $sid."
    Write-Output "Gateway bind listener: http://${GatewayBind}:$GatewayPort/mcp"
    if ($AllowBearerOnlyHttp) { Write-Warning 'Bearer tokens and MCP traffic travel in plaintext. Restrict network access; do not expose this listener to the Internet.' }
    Write-Output 'Configure the MCP client with the reachable host/proxy URL ending in /mcp and bearer token environment variable DYNAMIC_ANALYSIS_MCP_TOKEN. A wildcard bind address is not a client destination.'
}
