@echo off
REM Double-clickable starter for the microSAMPLER editor on Windows.
REM
REM Windows support is EXPERIMENTAL and untested. Before this works you must:
REM   1. Install Python 3 (https://python.org) and add it to PATH.
REM   2. pip install pyusb   and have a libusb-1.0 DLL available.
REM   3. Switch the microSAMPLER's USB driver to WinUSB using Zadig
REM      (https://zadig.akeo.ie/) so libusb can open the device.
REM See the documentation for details.

setlocal
title microSAMPLER Editor / Librarian
echo == microSAMPLER Editor / Librarian ==
echo.

cd /d "%~dp0native-tools"
if not exist bridge.py (
  echo ERROR: native-tools\bridge.py was not found next to this launcher.
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

REM open the editor now; the app keeps retrying until the bridge is ready
echo Opening http://localhost:8765 in your browser...
start "" "http://localhost:8765"

echo.
echo Starting the bridge. Close this window or press Ctrl+C to stop it.
echo ----------------------------------------------------------------
%PY% bridge.py
echo ----------------------------------------------------------------
echo Bridge exited (code %errorlevel%).
pause
endlocal
