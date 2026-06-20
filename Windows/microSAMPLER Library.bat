@echo off
REM Double-clickable LIBRARY-mode starter for Windows — browse, play and export
REM the samples in microSAMPLER bank backups (original Korg ".msmpl_bank" files,
REM or this app's ".zip" backups) with NO hardware connected. Library mode never
REM touches USB, so no WinUSB/Zadig driver setup is needed — just Python 3.

setlocal
title microSAMPLER Library
echo == microSAMPLER Library ==
echo.

cd /d "%~dp0..\native-tools"
if not exist bridge.py (
  echo ERROR: native-tools\bridge.py was not found next to the app.
  pause
  exit /b 1
)

REM find Python (the "py" launcher first, then "python")
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )
if not defined PY (
  echo ERROR: Python 3 was not found in PATH. Install it from https://python.org/
  pause
  exit /b 1
)

REM library mode has its own port (8766) so it never clashes with a device bridge
echo Opening http://localhost:8766 in your browser...
start "" "http://localhost:8766"

echo.
echo Starting LIBRARY mode (no device). Close this window or press Ctrl+C to stop.
echo ----------------------------------------------------------------
%PY% bridge.py --library --port 8766
echo ----------------------------------------------------------------
echo Bridge exited (code %errorlevel%).
pause
endlocal
