# verify-cascade.ps1
# Read-only self-check of the cascading-teams patch, its gate, and the composed profile.
#
# Answers one question: will the *current* build behave as a cascading team tree?
# Nothing is modified.
#
# Usage:  & .\verify-cascade.ps1

[CmdletBinding()]
param(
    [string]$PackageDir,
    [string]$Profile = $env:DSH_PROFILE,
    [string]$DshBin = 'D:\DSH_desktop\deepseek_harness_desktop\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh\lib\bin.js'
)

$ErrorActionPreference = 'Continue'
$BaselineHash = '7E8122ED7AE6723DC5152AF32CC62B592F5C39A36A88DC71F280FD332C815419'
$pkg = $PackageDir
if (-not $pkg) {
    if ($env:DSH_AGENT_TEAM_PKG) { $pkg = $env:DSH_AGENT_TEAM_PKG }
    elseif (Test-Path 'D:\DSH_desktop\deepseek_harness_desktop\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh-experimental-agent-team') {
        $pkg = 'D:\DSH_desktop\deepseek_harness_desktop\DSH Desktop\resources\app.asar.unpacked\node_modules\@deepseek-ai\dsh-experimental-agent-team'
    }
}
if (-not $pkg -or -not (Test-Path -LiteralPath $pkg)) { throw "Cannot locate the agent-team package. Pass -PackageDir." }

$entry = Join-Path $pkg 'lib\index.js'
$text = [System.IO.File]::ReadAllText($entry, [System.Text.Encoding]::UTF8)
$hash = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
# `apply-cascade.ps1` records the hash it produced, so this check cannot go stale when the
# patch grows: a hardcoded expected hash reported a false negative after P5 was added.
$sidecar = Join-Path $PSScriptRoot 'patched.sha256'
$recorded = if (Test-Path -LiteralPath $sidecar) { (Get-Content -LiteralPath $sidecar -Raw).Trim() } else { $null }

Write-Host '=== 1. patch presence (on-disk file) ==='
$markerCount = ([regex]::Matches($text, [regex]::Escape('/* dsh-cascade-patch v1 */'))).Count
Write-Host ("  cascade marker      : {0} occurrence(s)  {1}" -f $markerCount, $(if ($markerCount -eq 1) { '[ok]' } else { '[FAIL]' }))
# One marker per change point: P0 helper, P1..P5.
$needles = @(
    'function cascadeEnabled()',
    'function resolveLeadSelf(root)',
    'id: resolveLeadSelf(root)',
    'request.target.trim() === "lead"',
    'routedTarget === void 0 ? resolveActiveMember',
    'senderName: state.members.find((member) => member.id === caller.id)?.name',
    'root.id !== caller.id'
)
foreach ($needle in $needles) {
    $n = ([regex]::Matches($text, [regex]::Escape($needle))).Count
    Write-Host ("  {0,-62} {1}  {2}" -f $needle, $n, $(if ($n -eq 1) { '[ok]' } else { '[FAIL]' }))
}
$presenceOk = ($markerCount -eq 1) -and (($needles | Where-Object { ([regex]::Matches($text, [regex]::Escape($_))).Count -ne 1 }).Count -eq 0)
Write-Host ("  sha256              : {0}" -f $hash)
if ($hash -eq $BaselineHash) { Write-Host '  -> PRISTINE build: the cascade patch is NOT applied' -ForegroundColor Yellow }
elseif ($recorded -and $hash -eq $recorded) { Write-Host '  -> matches the hash apply-cascade.ps1 recorded' -ForegroundColor Green }
elseif ($presenceOk) { Write-Host '  -> every change point is present; the recorded hash is stale (re-run apply-cascade.ps1 to refresh it)' -ForegroundColor DarkYellow }
else { Write-Host '  -> unknown build' -ForegroundColor Yellow }

Write-Host ''
Write-Host '=== 2. gate ==='
# The gate is opt-OUT: `cascadeEnabled()` returns true unless the variable is 0/false.
$gate = $env:DSH_AGENT_TEAM_CASCADE
$closed = ($gate -eq '0' -or $gate -eq 'false')
Write-Host ("  DSH_AGENT_TEAM_CASCADE (this shell) = '{0}'  -> gate {1}" -f $gate, $(if ($closed) { 'CLOSED' } else { 'OPEN (default)' }))
$userGate = [Environment]::GetEnvironmentVariable('DSH_AGENT_TEAM_CASCADE', 'User')
$procGate = [Environment]::GetEnvironmentVariable('DSH_AGENT_TEAM_CASCADE', 'Process')
Write-Host ("  User-scope = '{0}'   Process-scope = '{1}'" -f $userGate, $procGate)
if ($closed -or $userGate -eq '0' -or $userGate -eq 'false') {
    Write-Host '  -> the Host may see the gate closed; the dependable off-switch is restore-cascade.ps1.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== 3. module actually loaded by the running Host ==='
$started = ((Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue) | Sort-Object StartTime | Select-Object -First 1).StartTime
Write-Host ("  DSH Desktop started at: {0}" -f $started)
Write-Host ("  lib\index.js mtime    : {0}" -f (Get-Item -LiteralPath $entry).LastWriteTime)
if ($started -and ((Get-Item -LiteralPath $entry).LastWriteTime -lt $started)) {
    Write-Host '  -> the running process loaded this file [ok]' -ForegroundColor Green
} else {
    Write-Host '  -> the app started BEFORE this file was last written; a restart is required.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== 4. composed profile (the outcome that matters) ==='
# The teams rows may be carried by ANY installed bundle. What must hold is the composed
# result: the legacy subagent rows disabled and the three team rows present. Reading the
# composition is stronger than checking one possible carrier, and `--dump-config` fails on
# duplicate row ids, so this also catches a carrier that would break startup.
$composed = $null
if ((Test-Path -LiteralPath $DshBin) -and $Profile) {
    $composed = & node $DshBin --profile $Profile --dump-config 2>&1
}
if ($composed -eq $null) {
    Write-Host '  could not compose the profile (pass -DshBin / -Profile)' -ForegroundColor Yellow
} else {
    $lines = $composed -split "`n"
    foreach ($id in @('agent-team', 'tool-agent-team', 'ui-agent-team')) {
        $present = ($lines | Where-Object { $_ -match "^- id: $([regex]::Escape($id))\s*$" }).Count -gt 0
        Write-Host ("  row {0,-18} {1}" -f $id, $(if ($present) { 'present [ok]' } else { 'ABSENT [FAIL]' }))
    }
    foreach ($id in @('tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents')) {
        # The composed entry carries `disabled: true` after its `name` and
        # `__dshPluginOwner` block, so the flag is looked for inside a window rather than
        # on the very next line (checking one line reported a false negative).
        $block = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^- id: $([regex]::Escape($id))\s*$") {
                $window = $lines[($i + 1)..([Math]::Min($i + 12, $lines.Count - 1))]
                if (($window | Where-Object { $_ -match '^\s+disabled:\s*true\s*$' }).Count -gt 0) { $block = $true }
            }
        }
        Write-Host ("  legacy {0,-28} {1}" -f $id, $(if ($block) { 'disabled [ok]' } else { 'STILL ENABLED [FAIL]' }))
    }
}

Write-Host ''
Write-Host '=== verdict ==='
$composeOk = ($composed -ne $null) -and (($composed -split "`n" | Where-Object { $_ -match '^- id: (agent-team|tool-agent-team|ui-agent-team)\s*$' }).Count -ge 3)
if ($presenceOk -and $composeOk) {
    Write-Host '  READY: every change point is in the file and the composed profile carries the teams rows.' -ForegroundColor Green
    if ($started -and ((Get-Item -LiteralPath $entry).LastWriteTime -ge $started)) {
        Write-Host '  NOTE: the running app predates the file; restart it to load the patch.' -ForegroundColor Yellow
    }
} elseif ($presenceOk) {
    Write-Host '  PATCHED BUT NOT COMPOSED: the rows are missing from the profile; check the carrier bundle.' -ForegroundColor Red
} else {
    Write-Host '  NOT READY: the patched build is not in place. Run apply-cascade.ps1.' -ForegroundColor Red
}
