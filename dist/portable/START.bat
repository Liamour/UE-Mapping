@echo off
rem ---------------------------------------------------------------------
rem  AICartographer - one-click backend launcher.
rem  Double-click this file. It bootstraps a venv on first run, then
rem  starts Redis + the FastAPI backend.
rem  Press Ctrl+C in this window to stop.
rem ---------------------------------------------------------------------
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "LAUNCHER=%~dp0tools\launcher.py"

rem 1. Prefer venv python if it already exists (fast path)
if exist "%~dp0runtime\python-venv\Scripts\python.exe" (
    "%~dp0runtime\python-venv\Scripts\python.exe" "%LAUNCHER%" %*
    goto :end
)

rem 2. Try `python` on PATH
where python >nul 2>nul
if %errorlevel%==0 (
    python "%LAUNCHER%" %*
    goto :end
)

rem 3. Try the `py` launcher (Python.org installer adds this)
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 "%LAUNCHER%" %*
    goto :end
)

echo.
echo [ERROR] Python 3.11 or newer was not found on this computer.
echo.
echo   Install it from https://www.python.org/downloads/
echo   IMPORTANT: tick "Add Python to PATH" during installation.
echo.
echo   Then double-click START.bat again.
echo.
pause
exit /b 1

:end
echo.
echo (Window stays open after exit so you can read any final messages.)
pause
endlocal
