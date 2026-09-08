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

function Copy-GatewayFile([string]$Source, [string]$Destination) {
    # Windows can briefly retain an image mapping after a process has exited.
    for ($attempt = 1; $attempt -le 40; $attempt++) {
        try { Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop; return }
        catch {
            $exception = $_.Exception
            while ($exception.InnerException) { $exception = $exception.InnerException }
            $code = $exception.HResult -band 0xffff
            if ($code -notin @(32,33) -or $attempt -eq 40) { throw }
            Start-Sleep -Milliseconds 250
        }
    }
}

function Stop-InstalledGateway {
    $service = Get-CimInstance Win32_Service -Filter "Name='DynamicAnalysisMcpGateway'"
    $task = Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq 'DynamicAnalysisMcpGatewayUserAgent'
    # Validate both registrations before stopping either; names alone are not ownership.
    if ($service -and $service.PathName.Trim().Trim('"') -ine $existingService) {
        throw 'Gateway service belongs to another install path; refusing to replace it.'
    }
    if ($task) {
        $owner = $task.Principal.UserId
        if ($owner -notmatch '^S-1-') { $owner = ([Security.Principal.NTAccount]::new($owner)).Translate([Security.Principal.SecurityIdentifier]).Value }
        if ($owner -ne $sid -or @($task.Actions).Count -ne 1 -or $task.Actions[0].Execute -ine $gatewayExe -or
            $task.Actions[0].Arguments -notmatch ('^--user-agent --pipe-name "' + [regex]::Escape($pipeName) + '" ')) {
            throw 'Gateway user task belongs to another install or owner; rerun as the installed owner.'
        }
    }
    if ($service) {
        Stop-Service -Name 'DynamicAnalysisMcpGateway' -ErrorAction Stop
        (Get-Service -Name 'DynamicAnalysisMcpGateway').WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    if ($task) {
        # Prevent a logon trigger from relaunching the agent during replacement.
        Disable-ScheduledTask -InputObject $task | Out-Null
        Stop-ScheduledTask -InputObject $task
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            $running = @(Get-CimInstance Win32_Process -Filter "Name='dynamic-analysis-mcp-gateway.exe'" | Where-Object {
                $_.ExecutablePath -ieq $gatewayExe -and $_.CommandLine -and
                $_.CommandLine.EndsWith($task.Actions[0].Arguments, [StringComparison]::Ordinal)
            })
            foreach ($process in $running) {
                $processOwner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
                if ($processOwner.ReturnValue -ne 0 -or $processOwner.Sid -ne $sid) {
                    throw 'Cannot confirm installed user-agent process ownership; refusing replacement.'
                }
                # Only the exact installed agent action under the owner SID is eligible.
                $result = Invoke-CimMethod -InputObject $process -MethodName Terminate
                if ($result.ReturnValue -notin @(0,9)) { throw 'Unable to stop installed user-agent process.' }
            }
            if ($running.Count -eq 0) { break }
            if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting for installed user agent to exit.' }
            Start-Sleep -Milliseconds 250
        } while ($true)
    }
    if ($service) {
        & $existingService uninstall | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Gateway service uninstall failed; binaries were not replaced.' }
    }
}

if ($PSCmdlet.ShouldProcess($InstallRoot, 'Install Dynamic Analysis MCP Gateway')) {
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $existingService = Join-Path $InstallRoot 'DynamicAnalysisMcpGatewayService.exe'
    $gatewayExe = Join-Path $InstallRoot 'dynamic-analysis-mcp-gateway.exe'
    if (!$SkipRegistration) { Stop-InstalledGateway }
    New-Item -ItemType Directory -Force -Path $InstallRoot,$DataRoot | Out-Null
    Copy-GatewayFile $gatewaySource $gatewayExe
    Copy-GatewayFile $winswSource $existingService
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
        if ($LASTEXITCODE -ne 0) { throw 'Gateway service install failed.' }
        $agentArguments = "--user-agent --pipe-name `"$pipeName`" --agent-token-file `"$(Join-Path $DataRoot 'agent.token')`" --x64dbg-root `"$xRoot`""
        $action = New-ScheduledTaskAction -Execute $gatewayExe -Argument $agentArguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $sid
        $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName 'DynamicAnalysisMcpGatewayUserAgent' -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
        & $serviceExe start
        if ($LASTEXITCODE -ne 0) { throw 'Gateway service start failed.' }
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
