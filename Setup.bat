@echo off
title ClankerDesk Setup
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem  ClankerDesk setup -- double-click once, then ClankerDesk runs.
rem  1. Installs Node.js if this PC doesn't have it (one-time)
rem  2. Installs ffmpeg if this PC doesn't have it (one-time)
rem  3. Installs the little pieces ClankerDesk needs (one-time)
rem  Then it starts ClankerDesk (this window stays open -- that's normal)
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
    echo  [1/3] Node.js not found on this PC - installing it now...
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

rem ------------------------------------------------------------------
rem  ffmpeg -- the thing that captures and encodes the picture.
rem  This used to be assumed present, which meant a machine without it
rem  installed "successfully" and then streamed nothing, with errors that
rem  never mentioned ffmpeg at all.
rem
rem  setup-ffmpeg.ps1 does the work. It is a separate file because
rem  getting this right needs three fallbacks -- already installed,
rem  winget, then a plain download into this folder -- and that is too
rem  much logic to survive inside a batch file. Winget on its own is
rem  NOT enough: it is missing on some Windows installs and can refuse
rem  to run unattended, which is exactly how the previous attempt
rem  failed for people.
rem ------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-ffmpeg.ps1"
if errorlevel 1 (
    echo.
    echo  ==========================================================
    echo   ffmpeg could not be installed automatically.
    echo  ==========================================================
    echo.
    echo  ClankerDesk cannot show this PC's screen without it.
    echo.
    echo  The download may have been blocked, or this PC may not
    echo  have internet access right now.
    echo.
    echo  When you have internet, either:
    echo    - run Setup.bat again, or
    echo    - download ffmpeg from https://ffmpeg.org/download.html,
    echo      unzip it, and put the folder containing ffmpeg.exe into
    echo      this folder as:  tools\ffmpeg\bin
    echo.
    pause
    exit /b 1
)

if exist "agent\node_modules\ws" (
    echo  [3/3] Everything ClankerDesk needs is already bundled in this download.
) else (
    echo  [3/3] Installing ClankerDesk pieces (one-time, needs internet)...
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
