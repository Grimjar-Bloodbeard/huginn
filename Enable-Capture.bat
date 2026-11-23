@echo off
REM Turns on Huginn's live packet view by installing Npcap (the capture driver).
REM Needs administrator, and on a managed PC, IT approval. See enable-capture.ps1 for details.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "kit\enable-capture.ps1" %*
pause
