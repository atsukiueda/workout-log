@echo off
rem Workout app launcher: starts the local server and opens the app in the browser.
rem Usage: double-click, or "start.bat [port]" (default 8080).
setlocal
cd /d "%~dp0"
set "PORT=8080"
if not "%~1"=="" set "PORT=%~1"
set "URL=http://localhost:%PORT%/"

rem If the server is already running, just open the browser.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%URL%' | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo The app is already running. Opening %URL%
  if not "%NO_BROWSER%"=="1" start "" "%URL%"
  exit /b 0
)

echo Starting the workout app at %URL%
echo Keep this window open while using the app. Close it (or press Ctrl+C) to stop.
echo.

rem Open the browser shortly after the server starts.
if not "%NO_BROWSER%"=="1" start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 1; Start-Process '%URL%'"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port %PORT%

echo.
echo The server has stopped. If it failed to start, port %PORT% may be in use: try "start.bat 8081".
pause
