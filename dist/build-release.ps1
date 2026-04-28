<#
.SYNOPSIS
    Assemble release/AICartographer-Portable-<version>/ + zip from current
    repo state. No source modifications - copies only.

.DESCRIPTION
    Output layout:

        release/AICartographer-Portable-<version>/
            START.bat
            STOP.bat
            INSTALL-PLUGIN.bat
            README-FIRST.txt
            backend/                     <- copy of repo/backend
            plugin/AICartographer/       <- copy of repo/Plugins/AICartographer (no Binaries/Intermediate)
            runtime/redis/               <- copy of repo/Redis-x64-3.0.504
            tools/                       <- copy of dist/portable/tools

    Then optionally zips it.

.PARAMETER Version
    Version string used for the folder/zip name. Default: today (yyyyMMdd).

.PARAMETER NoZip
    Skip the final zip step. Useful for local smoke testing.

.NOTES
    Run from anywhere: paths resolve from the script's own location.
#>

[CmdletBinding()]
param(
    [string]$Version = (Get-Date -Format 'yyyyMMdd'),
    [switch]$NoZip
)

$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = (Resolve-Path (Join-Path $ScriptDir '..')).Path
$PortableSrc = Join-Path $ScriptDir 'portable'
$ReleaseRoot = Join-Path $RepoRoot 'release'
$PkgName     = "AICartographer-Portable-$Version"
$PkgRoot     = Join-Path $ReleaseRoot $PkgName

function Write-Step($n, $msg) { Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    WARN  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    ERR   $msg" -ForegroundColor Red }

$Bar = '=' * 67

Write-Host ''
Write-Host $Bar -ForegroundColor Cyan
Write-Host " Building $PkgName" -ForegroundColor Cyan
Write-Host $Bar -ForegroundColor Cyan

# --- 1. Sanity check sources ------------------------------------------------
Write-Step '1/6' 'Verifying sources'

$required = @{
    'backend'      = Join-Path $RepoRoot 'backend'
    'plugin src'   = Join-Path $RepoRoot 'Plugins\AICartographer'
    'redis bundle' = Join-Path $RepoRoot 'Redis-x64-3.0.504'
    'WebUI bundle' = Join-Path $RepoRoot 'Plugins\AICartographer\Resources\WebUI\index.html'
    'portable'     = $PortableSrc
}
foreach ($key in $required.Keys) {
    $p = $required[$key]
    if (-not (Test-Path $p)) {
        Write-Err "$key not found at $p"
        exit 1
    }
    Write-Ok "$key -> $p"
}

# --- 2. Reset destination ---------------------------------------------------
Write-Step '2/6' "Preparing $PkgRoot"
if (Test-Path $PkgRoot) {
    Write-Warn 'Existing package dir - removing'
    Remove-Item -Recurse -Force $PkgRoot
}
New-Item -ItemType Directory -Path $PkgRoot | Out-Null

# --- 3. Copy portable scaffolding (.bat + tools/) ---------------------------
Write-Step '3/6' 'Copying portable launcher'
Copy-Item (Join-Path $PortableSrc 'START.bat')          $PkgRoot
Copy-Item (Join-Path $PortableSrc 'STOP.bat')           $PkgRoot
Copy-Item (Join-Path $PortableSrc 'INSTALL-PLUGIN.bat') $PkgRoot
Copy-Item (Join-Path $PortableSrc 'README-FIRST.txt')   $PkgRoot
$toolsDest = Join-Path $PkgRoot 'tools'
robocopy (Join-Path $PortableSrc 'tools') $toolsDest /E /NFL /NDL /NJH /NJS /NP /XD '__pycache__' | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Err "robocopy tools failed: $LASTEXITCODE"; exit 1 }
$global:LASTEXITCODE = 0
Write-Ok 'launcher / installer / stop scripts copied'

# --- 4. Copy backend (excluding caches and demo vault) ----------------------
Write-Step '4/6' 'Copying backend source'
$backendDest = Join-Path $PkgRoot 'backend'
$exclude = @('__pycache__', '.venv', '__demo_vault', '.pytest_cache')
$src = $required['backend']
robocopy $src $backendDest /MIR /NFL /NDL /NJH /NJS /NP /XD @exclude | Out-Null
# robocopy returns 0..7 for success; 8+ for real failure
if ($LASTEXITCODE -ge 8) { Write-Err "robocopy backend failed: $LASTEXITCODE"; exit 1 }
$global:LASTEXITCODE = 0
Write-Ok "backend -> $backendDest"

# --- 5. Copy plugin (excluding build artifacts) -----------------------------
Write-Step '5/6' 'Copying plugin'
$pluginDest = Join-Path $PkgRoot 'plugin\AICartographer'
New-Item -ItemType Directory -Path (Split-Path $pluginDest -Parent) -Force | Out-Null
$exclude = @('Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', '.vs')
robocopy $required['plugin src'] $pluginDest /MIR /NFL /NDL /NJH /NJS /NP /XD @exclude | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Err "robocopy plugin failed: $LASTEXITCODE"; exit 1 }
$global:LASTEXITCODE = 0
$webui = Join-Path $pluginDest 'Resources\WebUI\index.html'
if (-not (Test-Path $webui)) {
    Write-Err 'WebUI bundle missing in copied plugin - did the React build run?'
    Write-Host '    Run: cd UE_mapping_plugin && npm run build  (writes index.html into plugin Resources)' -ForegroundColor Yellow
    exit 1
}
$webuiSize = (Get-Item $webui).Length
Write-Ok ("plugin -> $pluginDest  (WebUI bundle: {0} KB)" -f [int]($webuiSize / 1024))

# --- 6. Copy bundled Redis --------------------------------------------------
Write-Step '6/6' 'Copying portable Redis'
$redisDest = Join-Path $PkgRoot 'runtime\redis'
New-Item -ItemType Directory -Path $redisDest -Force | Out-Null
robocopy $required['redis bundle'] $redisDest /E /NFL /NDL /NJH /NJS /NP /XF '*.docx' '*.pdb' | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Err "robocopy redis failed: $LASTEXITCODE"; exit 1 }
$global:LASTEXITCODE = 0
Write-Ok "redis -> $redisDest"

# --- Footer: zip ------------------------------------------------------------
$zipPath = Join-Path $ReleaseRoot "$PkgName.zip"
if ($NoZip) {
    Write-Host ''
    Write-Host "Skipping zip (-NoZip). Folder: $PkgRoot" -ForegroundColor Yellow
} else {
    Write-Host ''
    Write-Host "Zipping -> $zipPath" -ForegroundColor Cyan
    if (Test-Path $zipPath) { Remove-Item $zipPath }
    Compress-Archive -Path "$PkgRoot\*" -DestinationPath $zipPath -CompressionLevel Optimal
    $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Ok "Zip created - $zipMb MB"
}

# --- Summary ----------------------------------------------------------------
Write-Host ''
Write-Host $Bar -ForegroundColor Green
Write-Host ' Release built' -ForegroundColor Green
Write-Host $Bar -ForegroundColor Green
Write-Host " Folder:  $PkgRoot"
if (-not $NoZip) { Write-Host " Zip:     $zipPath" }
Write-Host ''
Write-Host " Smoke test:  cd `"$PkgRoot`"; .\START.bat"
Write-Host ' Ship:        send the .zip to colleagues. They unzip + double-click START.bat.'
Write-Host ''
exit 0
