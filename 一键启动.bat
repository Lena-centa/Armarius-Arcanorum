@echo off
rem ============================================================
rem Armarius Arcanorum one-click launcher (Windows only).
rem   Dependency check (auto-setup on failure) -> start gateway
rem   -> open the tool page in a STANDALONE app window provided
rem   by the system default browser:
rem     Edge/Chrome = chromeless --app window (no tabs/address bar)
rem     Firefox     = new window (no app mode support)
rem Closing this console window (or Ctrl+C) stops the gateway.
rem Re-running while the gateway is up only reopens the tool page.
rem ============================================================
title Armarius Arcanorum
cd /d "%~dp0"
set "ARMARIUS_OPEN_MODE=app"
set "WORKFLOW_DB_OPEN_MODE=app"
rem Immediate feedback line: PowerShell cold start leaves ~1-2s of black window
echo Starting Armarius Arcanorum ... (first paint may take a few seconds)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" start
if errorlevel 1 pause
