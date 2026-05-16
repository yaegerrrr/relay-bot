# Memory + journal sync between this laptop and the relay-bot VPS.
#
# Memory is owned by the laptop (Claude Code writes to ~/.claude/...).
# Journal is owned by the VPS (TARS appends there). This script:
#   1. Pushes the local memory dir up to /srv/relay-bot/shared/memory/
#   2. Optionally appends a new journal entry (atomic, via SSH)
#   3. Pulls the canonical journal.md back down for local reading
#
# Run on demand (or schedule via Task Scheduler if you want auto-sync).
# Requires the laptop's SSH key to be authorized for the `relay` user
# on the VPS.

param(
    [string]$Append,      # optional: journal entry to append (one short paragraph)
    [string]$From = "Claude (VS Code)"  # author label for the appended entry
)

$ErrorActionPreference = "Stop"

$VpsHost      = "78.141.245.225"
$RemoteUser   = "relay"
$LocalMemDir  = "$env:USERPROFILE\.claude\projects\c--dev\memory"
$LocalJournal = "$env:USERPROFILE\.claude\projects\c--dev\journal.md"
$RemoteShared = "/srv/relay-bot/shared"

# 1. Push memory (laptop is authoritative; mirror every .md file).
# PowerShell doesn't expand wildcards before passing to scp the way bash
# does — `scp $dir\*` sends the literal string `*`. So enumerate files
# ourselves and splat them as separate args.
Write-Host "[1/3] pushing memory to VPS..." -ForegroundColor Cyan
if (-not (Test-Path $LocalMemDir)) {
    Write-Host "  (no local memory dir at $LocalMemDir — skipping push)" -ForegroundColor DarkYellow
} else {
    $memFiles = @(Get-ChildItem -Path $LocalMemDir -File -Recurse | ForEach-Object { $_.FullName })
    if ($memFiles.Count -eq 0) {
        Write-Host "  (memory dir empty — skipping push)" -ForegroundColor DarkYellow
    } else {
        & scp -q @memFiles "${RemoteUser}@${VpsHost}:${RemoteShared}/memory/"
        if ($LASTEXITCODE -ne 0) { throw "scp push failed (exit $LASTEXITCODE)" }
    }
}

# 2. Append journal entry if one was provided
if ($Append) {
    Write-Host "[2/3] appending journal entry..." -ForegroundColor Cyan
    $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm")
    $entry = "`n## $ts UTC - $From`n$Append`n"
    # Pipe via SSH so the append is one atomic operation on the VPS side.
    $entry | ssh "${RemoteUser}@${VpsHost}" "cat >> ${RemoteShared}/journal.md"
    if ($LASTEXITCODE -ne 0) { throw "journal append failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "[2/3] no -Append provided, skipping journal write" -ForegroundColor DarkGray
}

# 3. Pull journal back (read-only copy for local reading)
Write-Host "[3/3] pulling journal from VPS..." -ForegroundColor Cyan
scp -q "${RemoteUser}@${VpsHost}:${RemoteShared}/journal.md" $LocalJournal
if ($LASTEXITCODE -ne 0) { throw "journal pull failed (exit $LASTEXITCODE)" }

Write-Host "DONE." -ForegroundColor Green
if ($Append) { Write-Host "  appended: $($Append.Substring(0, [Math]::Min(80, $Append.Length)))..." }
