@echo off
REM Ravens kit: starts Odin's Watch and Huginn from this folder and opens Huginn in the browser.
REM Uses the kit's own Node (runtime\node) if it's here, otherwise this PC's Node.
title Ravens kit
cd /d "%~dp0"
if exist "runtime\node\node.exe" (
  "runtime\node\node.exe" "kit\start.js"
) else (
  where node >nul 2>nul || (echo Node.js isn't on this PC and the kit's runtime folder is missing. & pause & exit /b 1)
  node "kit\start.js"
)
pause
