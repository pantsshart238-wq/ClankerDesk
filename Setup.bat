@echo off
title ClankerDesk Setup
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem  ClankerDesk setup -- double-click once, then ClankerDesk runs.
rem  1. Installs Node.js if this PC doesn't have it (one-time)
rem  2. Installs the little pieces ClankerDesk needs (one-time)
rem  3. Starts ClankerDesk (this window stays open -- that's normal)
rem
rem  Your device PIN (what friends use to connect to THIS pc) is
rem  printed in this window once it's running.
rem ------------------------------------------------------------------

echo.
echo  ============================================
echo     ClankerDesk setup
echo  ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo  [1/2] Node.js not found on this PC - installing it now...
    echo        (Windows may ask for permission -- click Yes)
    echo.
    winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    rem winget installs to Program Files\nodejs; the current window may not
    rem know about it yet, so add it to PATH by hand before continuing.
    set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
)

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo  Node.js could not be installed automatically.
    echo  Install it from https://nodejs.org, then run Setup.bat again.
    echo.
    pause
    exit /b 1
)

if exist "agent\node_modules\ws" (
    echo  [2/2] Everything ClankerDesk needs is already bundled in this download.
) else (
    echo  [2/2] Installing ClankerDesk pieces (one-time, needs internet)...
    echo.
    call npm.cmd install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo  npm install failed. Check your internet connection and run Setup.bat again.
        echo.
        pause
        exit /b 1
    )
)

echo.
echo  Setup complete! Starting ClankerDesk...
echo.
timeout /t 2 >nul

rem Start-Agent.bat launches the agent (it skips setup since we just did it).
start "ClankerDesk" cmd /k call "%~dp0Start-Agent.bat"
exit /b 0
