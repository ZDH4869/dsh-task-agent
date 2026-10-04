# apply-cascade.ps1
# Applies the minimal "cascading teams" patch to @deepseek-ai/dsh-experimental-agent-team.
#
# Anchor-safe and idempotent:
#   * every patch point is located by unique first/last anchor lines, never by the
#     surrounding line endings (PowerShell here-strings do not preserve them);
#   * the file is spliced line by line, so no replacement can be joined to the
#     following original line;
#   * the package version and the pristine file hash are verified before writing;
#   * a timestamped .bak-* is written first, and restore-cascade.ps1 reverts.
#
# Usage:  & .\apply-cascade.ps1
#         & .\apply-cascade.ps1 -PackageDir "<path to the package>" -Force

[CmdletBinding()]
param(
    [string]$PackageDir,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$BaselineHash = '7E8122ED7AE6723DC5152AF32CC62B592F5C39A36A88DC71F280FD332C815419'
$ExpectedVersion = '0.1.7-rc.2'
$VersionMarker = '/* dsh-cascade-patch v1 */'

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

# Replace one contiguous line range with $Replacement. Both the anchor block and the
# replacement are matched as line sequences, so the file's own line endings survive
# while PowerShell here-string line endings no longer matter.
function Set-LineRange {
    param(
        [string[]]$Lines,
        [string]$AnchorBlock,
        [string[]]$Replacement,
        [string]$Name
    )
    $target = [string[]]($AnchorBlock -split "`r?`n")
    while ($target.Count -gt 0 -and $target[$target.Count - 1] -eq '') {
        $target = [string[]]$target[0..($target.Count - 2)]
    }
    if ($target.Count -eq 0) { throw "[$Name] empty anchor block." }

    $hit = -1
    for ($i = 0; $i -le $Lines.Count - $target.Count; $i++) {
        $same = $true
        for ($j = 0; $j -lt $target.Count; $j++) {
            if ($Lines[$i + $j].Trim() -ne $target[$j].Trim()) { $same = $false; break }
        }
        if ($same) {
            if ($hit -ge 0) { throw "[$Name] anchor block matched more than once (at lines $($hit + 1) and $($i + 1))." }
            $hit = $i
        }
    }
    if ($hit -lt 0) { throw "[$Name] anchor block not found ($($target.Count) lines)." }

    $kept = New-Object System.Collections.Generic.List[string]
    if ($hit -gt 0) { $kept.AddRange([string[]]$Lines[0..($hit - 1)]) }
    $kept.AddRange([string[]]$Replacement)
    $tailStart = $hit + $target.Count
    if ($tailStart -lt $Lines.Count) { $kept.AddRange([string[]]$Lines[$tailStart..($Lines.Count - 1)]) }
    Write-Host ("  ok  {0}  (lines {1}-{2} -> {3})" -f $Name, ($hit + 1), ($hit + $target.Count), $Replacement.Count)
    return $kept.ToArray()
}

$pkg = Find-PackageDir -Explicit $PackageDir
$entry = Join-Path $pkg 'lib\index.js'
if (-not (Test-Path -LiteralPath $entry)) { throw "Entry not found: $entry" }

$pkgVersion = (Get-Content -LiteralPath (Join-Path $pkg 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "Package : $pkg"
Write-Host "Version : $pkgVersion"
Write-Host "Entry   : $entry"

$raw = [System.IO.File]::ReadAllText($entry, [System.Text.Encoding]::UTF8)
if ($raw.Contains($VersionMarker)) {
    Write-Host "Already patched ($VersionMarker). Nothing to do." -ForegroundColor Yellow
    exit 0
}
if ($pkgVersion -ne $ExpectedVersion -and -not $Force) {
    throw "Version mismatch: expected $ExpectedVersion, found $pkgVersion. Re-derive the patch, then use -Force."
}
$actualHash = (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash
if ($actualHash -ne $BaselineHash -and -not $Force) {
    Write-Host "WARNING: entry hash differs from the recorded baseline." -ForegroundColor Yellow
    Write-Host "  expected: $BaselineHash" -ForegroundColor Yellow
    Write-Host "  actual  : $actualHash" -ForegroundColor Yellow
    throw "Refusing to patch a file whose content drifted. Re-derive anchors, then use -Force."
}
Write-Host "Hash    : $actualHash (baseline OK)"

$nl = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }
$lines = [string[]]($raw -split "`r?`n")

# ------------------------------------------------------------------ P0 helper

$helper = [string[]]@(
    '/* dsh-cascade-patch v1 */',
    '/**',
    ' * Cascading teams switch.',
    ' *',
    ' * Default ON: this build ships the cascade patch, so the patched behaviour is what',
    ' * the deployment asked for. Opting out needs DSH_AGENT_TEAM_CASCADE to be explicitly',
    ' * falsy ("0"/"false"/"no"/"off") in the process environment — which on Windows means',
    ' * the Host must be LAUNCHED with it, because a running app keeps the environment block',
    ' * it started with. The dependable off-switch is restore-cascade.ps1, which reverts the',
    ' * file itself and needs no environment at all.',
    ' */',
    'function cascadeEnabled() {',
    '	const value = String(globalThis.process?.env?.DSH_AGENT_TEAM_CASCADE ?? "").trim().toLowerCase();',
    '	return !(value === "0" || value === "false" || value === "no" || value === "off");',
    '}',
    '// Deliberate test surface: the cascade resolver is pure and its behaviour is',
    '// otherwise unreachable without a live team, so smoke tests call it directly.',
    'globalThis.__dshCascadeProbe = { cascadeEnabled, resolveLeadSelf };',
    '/**',
    ' * Resolve the model-facing "lead" pseudo-row for one team root.',
    ' * In cascade mode a nested member''s "lead" is its direct parent, so it can report',
    ' * upward; a top-level root''s "lead" is itself.',
    ' * @param root - exact live team root.',
    ' * @returns the lead-side session identity.',
    ' */',
    'function resolveLeadSelf(root) {',
    '	if (cascadeEnabled()) {',
    '		const parentId = root.session.header.parentSession;',
    '		if (parentId !== void 0 && parentId !== root.id) return String(parentId);',
    '	}',
    '	return root.id;',
    '}'
)

# ------------------------------------------------------------------ P1

$p1 = [string[]]@(
    '					if (member?.phase === "active" || member?.phase === "provisioning") {',
    '						if (cascadeEnabled()) return {',
    '							root: agent,',
    '							id: TeamId(agent.id),',
    '							role: "lead",',
    '							name: "lead"',
    '						};',
    '						return {',
    '							root,',
    '							id: TeamId(root.id),',
    '							role: "teammate",',
    '							name: member.name',
    '						};',
    '					}'
)

# ------------------------------------------------------------------ P2

$p2 = [string[]]@(
    '	const name = rawName.trim();',
    '	if (name === "lead") return {',
    '		id: resolveLeadSelf(root),',
    '		name',
    '	};'
)

# ------------------------------------------------------------------ P3

$p3 = [string[]]@(
    '	/** Queue and dispatch one mailbox item admitted before the disposal cutoff. */',
    '	async sendAdmitted(caller, request) {',
    '		const membership = this.roster.membership(caller);',
    '		request.signal.throwIfAborted();',
    '		let root = membership.root;',
    '		// Cascading teams: a message whose addressee lives in a DIFFERENT team log must be',
    '		// journaled in the RECEIVER''s own log, or the receiver''s recovery sweep never sees it.',
    '		// All cross-team shapes are resolved through the direct parent:',
    '		//   * "lead" -> my direct parent''s log. The parent is ALSO the addressee: resolving',
    '		//     "lead" inside the parent''s own roster would walk one level further up',
    '		//     (see resolveLeadSelf) and mis-address the report to the grandparent.',
    '		//   * a name absent from my own roster but present in the parent''s roster -> that',
    '		//     SIBLING''s own log. After P1 every member is the Lead of its own team, so a',
    '		//     member''s inbox is targetId === its own id; the sibling''s sweep will claim it.',
    '		//   * anything else -> unchanged single-team resolution below.',
    '		let routedTarget;',
    '		if (cascadeEnabled()) {',
    '			const parentId = caller.session.header.parentSession;',
    '			const parent = parentId !== void 0 && parentId !== caller.id ? this.ctx.agents.get(parentId) : void 0;',
    '			if (request.target.trim() === "lead") {',
    '				if (parent !== void 0) {',
    '					root = parent;',
    '					routedTarget = { id: parent.id, name: "lead" };',
    '					membership.root = parent;',
    '					membership.id = TeamId(parent.id);',
    '					membership.role = "lead";',
    '					membership.name = "lead";',
    '				}',
    '			} else if (parent !== void 0) {',
    '				const mine = this.journal.state(membership.root);',
    '				if (mine.members.find((candidate) => candidate.name === request.target.trim()) === void 0) {',
    '					const siblings = this.journal.state(parent);',
    '					const sibling = siblings.members.find((candidate) => candidate.name === request.target.trim() && candidate.phase === "active");',
    '					const receiver = sibling === void 0 ? void 0 : this.ctx.agents.get(sibling.id);',
    '					if (sibling !== void 0 && receiver !== void 0) {',
    '						root = receiver;',
    '						routedTarget = { id: sibling.id, name: sibling.name };',
    '						membership.root = receiver;',
    '						membership.id = TeamId(receiver.id);',
    '						membership.role = "lead";',
    '						// The receiver''s roster does not contain me (siblings are separate teams),',
    '						// so P5''s lookup falls back to this name: carry the TRUE sender name, or',
    '						// the message would arrive signed "lead".',
    '						membership.name = siblings.members.find((candidate) => candidate.id === caller.id)?.name ?? membership.name;',
    '					}',
    '				}',
    '			}',
    '		}',
    '		const content = structuredClone(request.content);',
    '		const queued = await this.journal.transact(root.id, async () => {',
    '			request.signal.throwIfAborted();',
    '			const state = this.journal.state(root);',
    '			const target = routedTarget === void 0 ? resolveActiveMember(root, state, request.target) : routedTarget;'
)
# ------------------------------------------------------------------ P4

$p4 = [string[]]@(
    '	/** Perform one creation admitted before the Team runtime disposal cutoff. */',
    '	async spawnAdmitted(caller, request) {',
    '		const membership = this.membership(caller);',
    '		if (membership.role !== "lead") throw new TeamError("only the Team Lead can create teammates", "TEAM_LEAD_REQUIRED");',
    '		const signal = AbortSignal.any([request.signal, this.lifecycle.signal]);',
    '		signal.throwIfAborted();',
    '		const root = membership.root;',
    '		// Cascading teams: a caller always provisions children under itself, so a',
    '		// mismatched parent would mean a cross-level spawn attempt.',
    '		if (cascadeEnabled() && root.id !== caller.id) throw new TeamError(`agent "${caller.id}" may only create teammates under itself`, "TEAM_LEAD_REQUIRED");',
    '		const name = this.memberName(request.name);'
)

# ------------------------------------------------------------------ anchor blocks (exact original text, trimmed per line)

$a1 = @'
					if (member?.phase === "active" || member?.phase === "provisioning") return {
						root,
						id: TeamId(root.id),
						role: "teammate",
						name: member.name
					};
'@

$a2 = @'
	const name = rawName.trim();
	if (name === "lead") return {
		id: root.id,
		name
	};
'@

$a3 = @'
	async sendAdmitted(caller, request) {
		const membership = this.roster.membership(caller);
		request.signal.throwIfAborted();
		const root = membership.root;
		const content = structuredClone(request.content);
		const queued = await this.journal.transact(root.id, async () => {
			request.signal.throwIfAborted();
			const state = this.journal.state(root);
			const target = resolveActiveMember(root, state, request.target);
'@

$a4 = @'
	/** Perform one creation admitted before the Team runtime disposal cutoff. */
	async spawnAdmitted(caller, request) {
		const membership = this.membership(caller);
		if (membership.role !== "lead") throw new TeamError("only the Team Lead can create teammates", "TEAM_LEAD_REQUIRED");
		const signal = AbortSignal.any([request.signal, this.lifecycle.signal]);
		signal.throwIfAborted();
		const root = membership.root;
		const name = this.memberName(request.name);
'@

$a0 = @'
/** Owns Team identities and the lifecycle of rostered continuable children. */
var TeamRoster = class {
'@

$p0 = [string[]]$helper + [string[]]@(
    '/** Owns Team identities and the lifecycle of rostered continuable children. */',
    'var TeamRoster = class {'
)

$a5 = @'
				senderId: caller.id,
				senderName: membership.name,
'@

$p5 = [string[]]@(
    '				senderId: caller.id,',
    '				// Cascading teams: an upward report rewrites the caller''s membership view so',
    '				// the dispatch is permitted, which would otherwise sign the message with the',
    '				// RECEIVING PARENT''s own lead name and hide which child is asking. The',
    '				// parent''s roster knows the child, so it supplies the true sender name.',
    '				senderName: state.members.find((member) => member.id === caller.id)?.name ?? membership.name,'
)

# ------------------------------------------------------------------ apply

$jobs = @(
    @{ Name = 'P1 roster.tryMembership (member becomes its root)';    Anchor = $a1; Body = $p1 },
    @{ Name = 'P2 resolveActiveMember (lead = direct parent)';        Anchor = $a2; Body = $p2 },
    @{ Name = 'P3+P6 mailbox.sendAdmitted (upward + sibling routing)';     Anchor = $a3; Body = $p3 },
    @{ Name = 'P4 spawnAdmitted (direct-parent ownership)';           Anchor = $a4; Body = $p4 },
    @{ Name = 'P5 message sender name (true child name upward)';      Anchor = $a5; Body = $p5 },
    @{ Name = 'P0 helper injection (cascadeEnabled / resolveLeadSelf)'; Anchor = $a0; Body = $p0 }
)

foreach ($job in $jobs) {
    $lines = Set-LineRange -Lines $lines -AnchorBlock $job.Anchor -Replacement $job.Body -Name $job.Name
}

# ------------------------------------------------------------------ joins guard

for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match ';\s+const\s' -or $lines[$i] -match '`;\s+\w' -or $lines[$i] -match '\}\s+const\s') {
        throw "Join guard tripped at line $($i + 1): replacement was appended to an original line."
    }
}

$out = ($lines -join $nl)
if (-not $out.EndsWith($nl)) { $out += $nl }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $pkg ("lib\index.js.bak-{0}-{1}" -f $ExpectedVersion, $stamp)
[System.IO.File]::Copy($entry, $backup, $true)
Write-Host "Backup  : $backup"

[System.IO.File]::WriteAllText($entry, $out, (New-Object System.Text.UTF8Encoding($false)))
# Record what this run produced so verify-cascade.ps1 never compares against a stale hash.
$sidecar = Join-Path $PSScriptRoot 'patched.sha256'
[System.IO.File]::WriteAllText($sidecar, (Get-FileHash -LiteralPath $entry -Algorithm SHA256).Hash, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Hash    : $((Get-Content -LiteralPath $sidecar -Raw).Trim())  (recorded for verify-cascade.ps1)"
Write-Host "Patched : $entry" -ForegroundColor Green
Write-Host ""
Write-Host "Cascade is ON by default after this patch. Restart the app to load it."
Write-Host "Opt out at runtime : DSH_AGENT_TEAM_CASCADE=0 in the Host's launch environment (needs a relaunch)."
Write-Host "Opt out reliably   : & .\restore-cascade.ps1   (reverts the file; no environment needed)"
