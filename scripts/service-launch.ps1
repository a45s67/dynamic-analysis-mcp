[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$GatewayExe,
    [Parameter(Mandatory)][string]$ConfigFile,
    [Parameter(Mandatory)][string]$DataRoot
)
$ErrorActionPreference = 'Stop'

function Read-OneLineSecret([string]$Path, [string]$Label) {
    $item = Get-Item -LiteralPath $Path -Force
    if (!$item -or $item.PSIsContainer -or $item.Length -gt 4096) { throw "$Label secret file is invalid." }
    $value = [IO.File]::ReadAllText($item.FullName).TrimEnd("`r", "`n")
    if ($value.Length -lt 32 -or $value.Length -gt 512 -or $value -match '[^\x21-\x7e]') {
        throw "$Label secret is invalid."
    }
    $value
}

$env:DYNAMIC_ANALYSIS_MCP_TOKEN = Read-OneLineSecret (Join-Path $DataRoot 'gateway.token') 'Gateway'
$env:DYNAMIC_ANALYSIS_AGENT_TOKEN = Read-OneLineSecret (Join-Path $DataRoot 'agent.token') 'Agent'
$env:X64DBG_MCP_TOKEN = Read-OneLineSecret (Join-Path $DataRoot 'x64dbg.token') 'x64dbg'
$env:CE_MCP_TOKEN = Read-OneLineSecret (Join-Path $DataRoot 'ce.token') 'CE'
try {
    & $GatewayExe --config $ConfigFile
    exit $LASTEXITCODE
} finally {
    $env:DYNAMIC_ANALYSIS_MCP_TOKEN = $null
    $env:DYNAMIC_ANALYSIS_AGENT_TOKEN = $null
    $env:X64DBG_MCP_TOKEN = $null
    $env:CE_MCP_TOKEN = $null
}
