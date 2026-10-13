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
rem
rem  "where ffmpeg" is NOT enough on its own: ffmpeg is often installed
rem  but off PATH (winget buries it four folders deep), and Setup.bat
rem  may have unpacked it into this folder instead. So ask the agent's
rem  own resolver -- the same one the agent itself uses -- otherwise
rem  this would refuse to start on a machine that works fine.
rem ---------------------------------------------------------------
for /f "usebackq delims=" %%i in (`node -e "try{process.stdout.write(require('./agent/binaries').findBinary('ffmpeg')?'yes':'no')}catch(e){process.stdout.write('no')}" 2^>nul`) do set "HAS_FFMPEG=%%i"
if not "%HAS_FFMPEG%"=="yes" (
    echo.
    echo  ==========================================================
    echo   ffmpeg is not available - this PC's screen cannot be shown.
    echo  ==========================================================
    echo.
    echo  Run Setup.bat in this folder. It installs ffmpeg for you,
    echo  and it does not need winget or admin rights.
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
