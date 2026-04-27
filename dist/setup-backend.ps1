<#
.SYNOPSIS
    AICartographer backend setup — Python venv + dependencies + Redis check.

.DESCRIPTION
    Idempotent. Safe to re-run. Will:
      1. Verify Python 3.11+ is installed and on PATH (or via the `py` launcher)
      2. Create a virtualenv at backend/.venv if missing
      3. pip install -r backend/requirements.txt into that venv
      4. Probe for Redis (Memurai / bundled Redis-x64 / PATH redis-server)

.NOTES
    Run from any directory. The script resolves paths relative to its own
    location, so colleagues who unzip the release zip can just right-click
    -> "Run with PowerShell" without cd-ing first.
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$BackendDir = Join-Path $RepoRoot 'backend'
$VenvDir = Join-Path $BackendDir '.venv'
$VenvPip = Join-Path $VenvDir 'Scripts\pip.exe'
$Requirements = Join-Path $BackendDir 'requirements.txt'

function Write-Step($n, $msg) {
    Write-Host ""
    Write-Host "[$n] $msg" -ForegroundColor Yellow
}

function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    $msg" -ForegroundColor Red }

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host " AICartographer backend setup" -ForegroundColor Cyan
Write-Host " Repo: $RepoRoot" -ForegroundColor DarkGray
Write-Host "==================================================" -ForegroundColor Cyan

# ─────────────────────────────────────────────────────────────────────────────
# 1. Python check
# ─────────────────────────────────────────────────────────────────────────────
Write-Step '1/4' 'Checking Python 3.11+...'

$pyExe = $null
$pyArgsBase = @()
foreach ($candidate in @(
    @{ Cmd = 'python'; Extra = @() },
    @{ Cmd = 'py';     Extra = @('-3') }
)) {
    $found = Get-Command $candidate.Cmd -ErrorAction SilentlyContinue
    if (-not $found) { continue }

    $allArgs = $candidate.Extra + @('--version')
    try {
        $verStr = (& $candidate.Cmd @allArgs 2>&1 | Select-Object -First 1).ToString()
    } catch { continue }

    if ($verStr -match 'Python\s+(\d+)\.(\d+)') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        if ($major -gt 3 -or ($major -eq 3 -and $minor -ge 11)) {
            $pyExe = $candidate.Cmd
            $pyArgsBase = $candidate.Extra
            Write-Ok "Found: $verStr  ($pyExe $($candidate.Extra -join ' '))"
            break
        } else {
            Write-Warn "Skipping $verStr — too old (need 3.11+)"
        }
    }
}

if (-not $pyExe) {
    Write-Err 'Python 3.11+ not found.'
    Write-Host ''
    Write-Host 'Install from https://www.python.org/downloads/' -ForegroundColor Yellow
    Write-Host '  (check "Add Python to PATH" during installation)' -ForegroundColor Yellow
    Write-Host 'Then re-run this script.' -ForegroundColor Yellow
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Create venv
# ─────────────────────────────────────────────────────────────────────────────
Write-Step '2/4' "Creating venv at $VenvDir..."

if (Test-Path (Join-Path $VenvDir 'Scripts\python.exe')) {
    Write-Ok 'venv already exists — keeping it'
} else {
    if (Test-Path $VenvDir) {
        Write-Warn "$VenvDir exists but has no python.exe — removing and recreating"
        Remove-Item -Recurse -Force $VenvDir
    }
    $venvCmdArgs = $pyArgsBase + @('-m', 'venv', $VenvDir)
    & $pyExe @venvCmdArgs
    if (-not $? -or -not (Test-Path (Join-Path $VenvDir 'Scripts\python.exe'))) {
        Write-Err 'venv creation failed'
        exit 1
    }
    Write-Ok 'venv created'
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. pip install
# ─────────────────────────────────────────────────────────────────────────────
Write-Step '3/4' 'Installing requirements...'

if (-not (Test-Path $VenvPip)) {
    Write-Err "pip not found at $VenvPip"
    exit 1
}
if (-not (Test-Path $Requirements)) {
    Write-Err "requirements.txt not found at $Requirements"
    exit 1
}

& $VenvPip install --upgrade pip --quiet
if (-not $?) { Write-Err 'pip self-upgrade failed'; exit 1 }

& $VenvPip install -r $Requirements
if (-not $?) { Write-Err 'pip install failed'; exit 1 }

Write-Ok 'Dependencies installed'

# ─────────────────────────────────────────────────────────────────────────────
# 4. Redis probe
# ─────────────────────────────────────────────────────────────────────────────
Write-Step '4/4' 'Looking for Redis (Memurai / Redis-x64)...'

$redisFound = $null
$redisCandidates = @(
    'C:\Program Files\Memurai\memurai.exe',
    'C:\Program Files (x86)\Memurai\memurai.exe',
    (Join-Path $RepoRoot 'Redis-x64-3.0.504\redis-server.exe')
)
foreach ($c in $redisCandidates) {
    if (Test-Path $c) { $redisFound = $c; break }
}
if (-not $redisFound) {
    $cmd = Get-Command redis-server -ErrorAction SilentlyContinue
    if ($cmd) { $redisFound = $cmd.Source }
}

if ($redisFound) {
    Write-Ok "Found: $redisFound"
} else {
    Write-Warn 'Not found.'
    Write-Host ''
    Write-Host '    Recommended: Memurai (Redis-compatible, free Developer edition)' -ForegroundColor Yellow
    Write-Host '      https://www.memurai.com/get-memurai' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '    Install it, then run dist\start-backend.ps1 (it will find Memurai automatically).' -ForegroundColor Yellow
}

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host ' Setup complete' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan
if ($redisFound) {
    Write-Host ' Next: .\dist\start-backend.ps1' -ForegroundColor Cyan
} else {
    Write-Host ' Next: install Memurai, then .\dist\start-backend.ps1' -ForegroundColor Cyan
}
Write-Host ''
