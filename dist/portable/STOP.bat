@echo off
rem Stop any AICartographer services started by START.bat.
rem Safe to run anytime — does nothing if nothing is running.
setlocal
cd /d "%~dp0"

set "STOPPER=%~dp0tools\stop.py"

if exist "%~dp0runtime\python-venv\Scripts\python.exe" (
    "%~dp0runtime\python-venv\Scripts\python.exe" "%STOPPER%"
    goto :end
)

where python >nul 2>nul
if %errorlevel%==0 (
    python "%STOPPER%"
    goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
    py -3 "%STOPPER%"
    goto :end
)

echo [ERROR] Python not found — cannot run stop.py.
echo If processes are stuck, open Task Manager and end:
echo   redis-server.exe (or memurai.exe) and python.exe (uvicorn).
pause
exit /b 1

:end
echo.
pause
endlocal
