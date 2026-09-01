[CmdletBinding()]
param([string]$PackageRoot)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($PackageRoot)) { $PackageRoot = Join-Path $PSScriptRoot '..\dist\package' }
$root = (Resolve-Path -LiteralPath $PackageRoot).Path
$manifestPath = Join-Path $root 'manifest.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.Count -lt 8) { throw 'Package manifest is incomplete.' }
$listed = @{}
foreach ($entry in $manifest) {
    if ($entry.path -notmatch '^[A-Za-z0-9._/-]+$' -or $listed.ContainsKey($entry.path)) { throw 'Package manifest path is invalid.' }
    $path = Join-Path $root ($entry.path.Replace('/','\'))
    if (!(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Manifest file is missing: $($entry.path)" }
    $item = Get-Item -LiteralPath $path
    if ($item.Length -ne $entry.bytes -or (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() -cne $entry.sha256) {
        throw "Manifest verification failed: $($entry.path)"
    }
    $listed[$entry.path] = $true
}
$actualFiles = @(Get-ChildItem -LiteralPath $root -File -Recurse | Where-Object Name -ne 'manifest.json')
if ($actualFiles.Count -ne $manifest.Count) { throw 'Package contains unlisted files.' }
$winsw = Join-Path $root 'service\WinSW-x64.exe'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $winsw).Hash -cne 'B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F') { throw 'Packaged WinSW checksum mismatch.' }
& (Join-Path $root 'dynamic-analysis-mcp-gateway.exe') --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Packaged Gateway executable did not start.' }
Write-Output 'package verification passed'
