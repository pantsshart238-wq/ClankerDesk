# Builds the plug-and-play bundle: public\download\clankerdesk.zip
# Run after changing the agent or the viewer page:  powershell -File make-download.ps1
# (then publish it with:  npx.cmd wrangler deploy)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$stage = Join-Path $env:TEMP "clankerdesk-bundle"
$outDir = Join-Path $root "public\download"
$outZip = Join-Path $outDir "clankerdesk.zip"

# UTF-8 WITHOUT BOM for the JSON files. Windows PowerShell's
# Set-Content -Encoding UTF8 writes a BOM, and JSON.parse rejects that
# ("Unexpected token ''") -- the agent strips BOMs now too, but ship clean.
$utf8nb = New-Object System.Text.UTF8Encoding($false)

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage, (Join-Path $stage "agent"), (Join-Path $stage "public"), $outDir -Force | Out-Null

# --- the actual program ------------------------------------------------------
Copy-Item (Join-Path $root "Setup.bat")            $stage
Copy-Item (Join-Path $root "Start-Agent.bat")      $stage
Copy-Item (Join-Path $root "agent\agent.js")       (Join-Path $stage "agent")
Copy-Item (Join-Path $root "agent\selfhost-deploy.js") (Join-Path $stage "agent")
Copy-Item (Join-Path $root "agent\input-helper.ps1") (Join-Path $stage "agent")
Copy-Item (Join-Path $root "agent\audio-helper.ps1") (Join-Path $stage "agent")
Copy-Item (Join-Path $root "agent\host-window.ps1") (Join-Path $stage "agent")
Copy-Item (Join-Path $root "public\index.html")    (Join-Path $stage "public")
Copy-Item (Join-Path $root "public\theme.css")     (Join-Path $stage "public")
Copy-Item (Join-Path $root "public\app.js")        (Join-Path $stage "public")

# Worker source + wrangler config, so agent\selfhost-deploy.js can upload a
# private copy for one user without GitHub. config.json is NOT copied -- the
# clean template is written below instead, so no key ever ships in the zip.
New-Item -ItemType Directory -Path (Join-Path $stage "src") -Force | Out-Null
Copy-Item (Join-Path $root "src\index.js")         (Join-Path $stage "src")
Copy-Item (Join-Path $root "wrangler.jsonc")       $stage

# --- bundled dependency: ws --------------------------------------------------
# The agent's ONLY external dependency. It is pure JavaScript (no build
# step, no sub-dependencies), so ship it inside the zip: the agent finds it
# at agent\node_modules\ws with zero npm, zero internet, zero first-run
# surprises. (node-interception is optional and lazily loaded; the manual
# games-input install covers it.)
$wsSrc = Join-Path $root "node_modules\ws"
if (-not (Test-Path (Join-Path $wsSrc "package.json"))) {
  throw "node_modules\ws is missing from the project -- run 'npm install' in the project root first"
}
New-Item -ItemType Directory -Path (Join-Path $stage "agent\node_modules") -Force | Out-Null
Copy-Item $wsSrc (Join-Path $stage "agent\node_modules\ws") -Recurse

# Safety net only: if someone ever deletes the bundled copy, 'npm install'
# at the zip root now has a package.json to install from (previously it
# crashed with ENOENT and the agent died on 'Cannot find module "ws"').
@'
{
  "name": "clankerdesk-bundle",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "ws": "^8.18.0"
  }
}
'@ | ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $stage "package.json"), $_, $utf8nb) }

# --- settings template (comments are fine; the agent ignores them) -----------
@'
{
  // ClankerDesk settings. Edit with Notepad, save, restart ClankerDesk.
  // The agent registers this PC in the dashboard automatically.

  // The ClankerDesk relay (permanent address, do not change):
  "relayUrl": "wss://clankerdesk.remote-me-braeden.workers.dev/ws",

  // YOUR private key from signing up on the website (Sign up -> copy key).
  // It links this PC to YOUR account -- only your login sees it in Devices.
  // Not signed up yet? Open the website, click Sign up, then paste the key here.
  "relayToken": "PASTE-YOUR-PRIVATE-KEY-HERE",
  "useRelay": true,

  // Name shown in the dashboard. Leave empty to use your Windows name.
  "deviceName": "",

  // Optional extra "anyone with this link" access that bypasses the PIN
  // (links rotate every time the agent restarts). Off by default.
  "publicLink": false,

  // Local page on this PC (http://localhost:8000):
  "viewerPort": 8000,
  // true = the ClankerDesk window (built-in UI) opens on start:
  "openViewer": true,
  "allowEmbed": true,

  // Leave empty to listen to whatever this PC plays (recommended -- no
  // audio cable needed). Set a capture device name like
  // "CABLE Output (VB-Audio Virtual Cable)" to capture that device instead.
  "audioDevice": "",

  // Optional: force the cable the VIEWER'S MIC plays into (e.g. "CABLE-B"
  // or "Voicemeeter Input") so viewers can talk AND hear host sound at the
  // same time. Leave empty: the agent auto-detects a second cable (free
  // Voicemeeter or the VB-CABLE A+B pack).
  "micDevice": "",

  // Default stream quality: "1080p60", "720p60" or "1080p30".
  // Viewers can switch any time with the quality button in the viewer.
  "quality": "1080p60"
}
'@ | ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $stage "config.json"), $_, $utf8nb) }

# --- tiny readme -------------------------------------------------------------
@'
ClankerDesk - quick start
=========================

1. Run Setup.bat once. It installs what's needed and starts ClankerDesk.
   (Portable version: run Start-Agent.bat directly — needs Node.js.)

2. Sign up on the website (the Sign up button — free). Copy your PRIVATE KEY.

3. Open config.json in Notepad, paste the key into "relayToken", save,
   restart ClankerDesk. This PC now shows up under YOUR account in Devices —
   only your login can see it.

4. Give the PIN (shown in the ClankerDesk window) to the people you want to
   let in. They open the website, click your PC, type the PIN. Done.

Hearing the PC's sound
=====================
Viewers hear whatever this PC plays -- games, music, calls. Nothing to
install: the agent listens to the Windows sound directly (no audio cable
needed). A VB-CABLE is optional and only useful for the viewer mic below.

Talking (mic)
=============
Viewers' mics play into this PC automatically -- set your game/Discord
mic input to "CABLE Output (VB-Audio Virtual Cable)" and they're in.
Your sound pauses while a viewer talks so their own voice never comes
back at them. (A second cable -- free Voicemeeter or the VB-CABLE A+B
pack -- is auto-detected and gives the mic its own cable.)

Stream quality
==============
The viewer has a quality button: 1080p60 (default), 720p60 or 1080p30.
Pick 720p60 if a viewer's device struggles -- smooth beats sharp.

All settings live in config.json (open it with Notepad).
'@ | Set-Content (Join-Path $stage "HOW-TO.txt") -Encoding UTF8

# --- zip it up: full setup + portable variant, versioned ----------------------
$Version = "1.0"
$vFull = Join-Path $outDir "clankerdesk-v$Version.zip"
$vPort = Join-Path $outDir "clankerdesk-v$Version-portable.zip"
$vPortLatest = Join-Path $outDir "clankerdesk-portable.zip"

foreach ($f in @($outZip, $vFull, $vPort, $vPortLatest)) {
  if (Test-Path $f) { Remove-Item $f -Force }
}

# 1) full setup (includes Setup.bat) -> versioned file + "latest" alias
Compress-Archive -Path "$stage\*" -DestinationPath $vFull
Copy-Item $vFull $outZip

# 2) portable (no Setup.bat; Start-Agent.bat installs npm deps itself)
Remove-Item (Join-Path $stage "Setup.bat") -Force
Compress-Archive -Path "$stage\*" -DestinationPath $vPort
Copy-Item $vPort $vPortLatest

foreach ($f in @($vFull, $vPort, $outZip)) {
  $kb = [math]::Round((Get-Item $f).Length / 1KB)
  Write-Host ("Built " + (Split-Path $f -Leaf) + " ($kb KB)")
}
Write-Host "Publish it with:  npx.cmd wrangler deploy"
