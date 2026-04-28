@echo off
rem ─────────────────────────────────────────────────────────────────────────
rem  Copy AICartographer plugin into one of your UE projects.
rem  Run this once per UE project you want to use AICartographer in.
rem ─────────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

set "INSTALLER=%~dp0tools\install_plugin.py"

if exist "%~dp0runtime\python-venv\Scripts\python.exe" (
    "%~dp0runtime\python-venv\Scripts\python.exe" "%INSTALLER%"
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    python "%INSTALLER%"
    goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 "%INSTALLER%"
    goto :end
)

echo.
echo [ERROR] Python 3.11+ not found.
echo.
echo   This script needs Python only to walk you through choosing a UE project.
echo   Install Python from https://www.python.org/downloads/ first
echo   (tick "Add Python to PATH" during installation).
echo.
pause
exit /b 1

:end
echo.
pause
endlocal
