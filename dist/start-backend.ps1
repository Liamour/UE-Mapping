<#
.SYNOPSIS
    Launch AICartographer backend — Redis (background) + uvicorn (foreground).

.DESCRIPTION
    Starts Memurai/Redis in a minimized background process, then runs uvicorn
    in the current console. When you press Ctrl+C uvicorn stops AND this
    script terminates the Redis process it spawned.

    Run dist\setup-backend.ps1 first if you haven't (it creates the venv and
    installs dependencies).

.NOTES
    If PowerShell refuses to run the script, enable user-scope script
    execution once:
        Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$BackendDir = Join-Path $RepoRoot 'backend'
$VenvDir = Join-Path $BackendDir '.venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'

function Write-Info($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Err($msg)  { Write-Host $msg -ForegroundColor Red }

# ─────────────────────────────────────────────────────────────────────────────
# 1. Verify venv
# ─────────────────────────────────────────────────────────────────────────────
if (-not (Test-Path $VenvPython)) {
    Write-Err "venv missing at $VenvPython"
    Write-Host ''
    Write-Host 'Run this first:' -ForegroundColor Yellow
    Write-Host '    .\dist\setup-backend.ps1' -ForegroundColor Yellow
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 2. Locate Redis
# ─────────────────────────────────────────────────────────────────────────────
$redisExe = $null
$candidates = @(
    'C:\Program Files\Memurai\memurai.exe',
    'C:\Program Files (x86)\Memurai\memurai.exe',
    (Join-Path $RepoRoot 'Redis-x64-3.0.504\redis-server.exe')
)
foreach ($c in $candidates) {
    if (Test-Path $c) { $redisExe = $c; break }
}
if (-not $redisExe) {
    $cmd = Get-Command redis-server -ErrorAction SilentlyContinue
    if ($cmd) { $redisExe = $cmd.Source }
}

if (-not $redisExe) {
    Write-Err 'Redis not found.'
    Write-Host ''
    Write-Host 'Install Memurai from https://www.memurai.com/get-memurai' -ForegroundColor Yellow
    Write-Host 'then re-run this script.' -ForegroundColor Yellow
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 3. Start Redis (background, minimized)
# ─────────────────────────────────────────────────────────────────────────────
Write-Info "Starting Redis: $redisExe"
$redisProc = $null
try {
    $redisProc = Start-Process -FilePath $redisExe -PassThru -WindowStyle Minimized
} catch {
    Write-Err "Failed to start Redis: $_"
    exit 1
}
Start-Sleep -Milliseconds 500
if ($redisProc.HasExited) {
    Write-Err "Redis exited immediately (port 6379 already in use?)"
    Write-Host '    Check with: netstat -ano | Select-String ":6379\s"' -ForegroundColor Yellow
    exit 1
}
Write-Info "Redis PID: $($redisProc.Id)"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Start uvicorn (foreground)
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ''
Write-Info '=================================================='
Write-Info ' AICartographer backend starting on port 8000'
Write-Info ' Press Ctrl+C to stop. Redis will be terminated.'
Write-Info '=================================================='
Write-Host ''

try {
    Push-Location $BackendDir
    & $VenvPython -m uvicorn main:app --reload --port 8000
} finally {
    Pop-Location
    if ($redisProc -and -not $redisProc.HasExited) {
        Write-Host ''
        Write-Info "Stopping Redis (PID $($redisProc.Id))..."
        Stop-Process -Id $redisProc.Id -Force -ErrorAction SilentlyContinue
    }
    Write-Info 'Backend shut down.'
}
