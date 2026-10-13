@echo off
title Remote Desktop Agent
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  Start-Agent.bat -- double-click to run the agent.
rem  Settings live in config.json (edit it with Notepad).
rem  Ctrl+C in this window stops everything.
rem ---------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  Node.js is required but was not found on this PC.
    echo  Install it, then double-click this file again:
    echo      winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
)

if not exist "agent\node_modules\ws" (
    echo.
    echo  First run: installing dependencies, this can take a minute...
    echo.
    call npm.cmd install
    if errorlevel 1 (
        echo.
        echo  npm install failed. The download may be incomplete -
        echo  re-download ClankerDesk and try again.
        pause
        exit /b 1
    )
)

rem ---------------------------------------------------------------
rem  ffmpeg is what captures and encodes the picture. Without it the
rem  agent starts happily and then streams nothing, reporting errors
rem  that never name ffmpeg -- so check here, where the fix can be
rem  printed in one place.
rem ---------------------------------------------------------------
where ffmpeg >nul 2>nul
if errorlevel 1 (
    echo.
    echo  ==========================================================
    echo   ffmpeg is not installed - this PC's screen cannot be shown.
    echo  ==========================================================
    echo.
    echo  Install it with:
    echo      winget install --id Gyan.FFmpeg
    echo.
    echo  Or run Setup.bat in this folder, which does it for you.
    echo.
    echo  Then start ClankerDesk again.
    echo.
    pause
    exit /b 1
)

node agent\agent.js
if errorlevel 1 (
    echo.
    echo  The agent stopped unexpectedly. Press any key to close.
    pause >nul
)
