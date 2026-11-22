@echo off
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0collect.ps1"
if errorlevel 1 pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0triage.ps1"
echo.
echo Done. Open the newest folder in reports\
pause
