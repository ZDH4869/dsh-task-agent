# restore-cascade.ps1
# Restores the pre-patch lib/index.js of @deepseek-ai/dsh-experimental-agent-team.
# Prefers the newest .bak-* produced by apply-cascade.ps1; falls back to the
# recorded baseline copy shipped beside this script.
#
# Usage:  pwsh -File restore-cascade.ps1
#         pwsh -File restore-cascade.ps1 -FromBaseline

[CmdletBinding()]
param(
    [string]$PackageDir,
    [switch]$FromBaseline
)

$ErrorActionPreference = 'Stop'
$BaselineHash = '7E8122ED7AE6723DC5152AF32CC62B592F5C39A36A88DC71F280FD332C815419'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BaselineCopy = Join-Path $ScriptDir 'index.js.orig-0.1.7-rc.2'

function Find-PackageDir {
    param([string]$Explicit)
    if ($Explicit) {
        if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
        throw "PackageDir not found: $Explicit"
    }
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($env:DSH_AGENT_TEAM_PKG) { $candidates.Add($env:DSH_AGENT_TEAM_PKG) }
    if ($env:DSH_PROFILE_DIR) {
        $candidates.Add((Join-Path $env:DSH_PROFILE_DIR 'node_modules\@deepseek-ai\dsh-experimental-agent-team'))
    }
    $candidates.Add('D:\DSH_desktop\deepseek_harness_desktop\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh-experimental-agent-team')
    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) { return (Resolve-Path -LiteralPath $c).Path }
    }
    throw "Cannot locate @deepseek-ai/dsh-experimental-agent-team. Pass -PackageDir."
}

$pkg = Find-PackageDir -Explicit $PackageDir
$entry = Join-Path $pkg 'lib\index.js'
Write-Host "Package : $pkg"

$source = $null
if (-not $FromBaseline) {
    $backups = Get-ChildItem -LiteralPath (Join-Path $pkg 'lib') -Filter 'index.js.bak-*' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
    if ($backups.Count -gt 0) { $source = $backups[0].FullName }
}
if (-not $source) {
    if (-not (Test-Path -LiteralPath $BaselineCopy)) { throw "No backup found and baseline copy missing: $BaselineCopy" }
    $source = $BaselineCopy
}

Write-Host "Restoring from: $source"
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
if ($hash -ne $BaselineHash) {
    Write-Host "WARNING: source hash $hash differs from recorded baseline $BaselineHash" -ForegroundColor Yellow
}

[System.IO.File]::Copy($source, $entry, $true)
$final = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
Write-Host "Restored: $entry"
Write-Host "Hash    : $final"
if ($final -eq $BaselineHash) { Write-Host "Matches the recorded pre-patch baseline." -ForegroundColor Green }
