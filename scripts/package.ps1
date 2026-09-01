[CmdletBinding()]
param(
    [string]$OutputRoot,
    [string]$WinSWPath
)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($OutputRoot)) { $OutputRoot = Join-Path $workspace 'dist\package' }
$distRoot = [IO.Path]::GetFullPath((Join-Path $workspace 'dist')).TrimEnd('\')
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (!$OutputRoot.StartsWith($distRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'OutputRoot must be below the workspace dist directory.' }
$expected = 'B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F'
if ([string]::IsNullOrWhiteSpace($WinSWPath)) {
    $WinSWPath = Join-Path $workspace '.tools\WinSW-NET461-2.12.0.exe'
    if (!(Test-Path -LiteralPath $WinSWPath)) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $WinSWPath) | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe' -OutFile $WinSWPath
    }
}
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $WinSWPath).Hash
if ($actual -cne $expected) { throw 'WinSW 2.12.0 checksum mismatch.' }
$exe = Join-Path $workspace 'dist\dynamic-analysis-mcp-gateway.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Build the Gateway EXE before packaging.' }
if (Test-Path -LiteralPath $OutputRoot) { Remove-Item -LiteralPath $OutputRoot -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutputRoot,(Join-Path $OutputRoot 'service'),(Join-Path $OutputRoot 'config'),(Join-Path $OutputRoot 'scripts'),(Join-Path $OutputRoot 'docs') | Out-Null
Copy-Item -LiteralPath $exe -Destination $OutputRoot
Copy-Item -LiteralPath $WinSWPath -Destination (Join-Path $OutputRoot 'service\WinSW-x64.exe')
Copy-Item -LiteralPath (Join-Path $workspace 'config\gateway.example.toml') -Destination (Join-Path $OutputRoot 'config')
Copy-Item -LiteralPath (Join-Path $workspace 'scripts\install.ps1'),(Join-Path $workspace 'scripts\uninstall.ps1'),(Join-Path $workspace 'scripts\service-launch.ps1'),(Join-Path $workspace 'scripts\verify-package.ps1') -Destination (Join-Path $OutputRoot 'scripts')
Copy-Item -LiteralPath (Join-Path $workspace 'scripts\install.ps1'),(Join-Path $workspace 'scripts\uninstall.ps1') -Destination $OutputRoot
Copy-Item -LiteralPath (Join-Path $workspace 'third_party\WinSW-LICENSE.txt') -Destination (Join-Path $OutputRoot 'service')
Copy-Item -LiteralPath (Join-Path $workspace 'README.md') -Destination $OutputRoot
Copy-Item -LiteralPath (Join-Path $workspace 'docs\service-with-user-agent.md'),(Join-Path $workspace 'docs\configuration.md') -Destination (Join-Path $OutputRoot 'docs')
$manifest = Get-ChildItem -LiteralPath $OutputRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{ path = $_.FullName.Substring($OutputRoot.TrimEnd('\').Length + 1).Replace('\','/'); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(); bytes = $_.Length }
}
[IO.File]::WriteAllText((Join-Path $OutputRoot 'manifest.json'), ($manifest | ConvertTo-Json -Depth 4))
& (Join-Path $workspace 'scripts\verify-package.ps1') -PackageRoot $OutputRoot
Compress-Archive -Path (Join-Path $OutputRoot '*') -DestinationPath (Join-Path (Split-Path -Parent $OutputRoot) 'dynamic-analysis-mcp-gateway-windows-x64.zip') -Force
