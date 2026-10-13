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
# Installs ffmpeg when winget is unavailable, unpacking it into tools\ffmpeg
# inside the ClankerDesk folder. agent\binaries.js looks there first, so the
# result survives a PATH reset, a restart, or a different Windows user.
Copy-Item (Join-Path $root "setup-ffmpeg.ps1")     $stage
Copy-Item (Join-Path $root "agent\agent.js")       (Join-Path $stage "agent")
# The platform layer. agent.js requires "./platform" near the top, so leaving
# these out of the zip produced a download that died instantly with
# "Cannot find module './platform'" -- while the copy in the repo worked
# perfectly, so testing the repo never caught it.
#
# All the platform files plus BOTH input helpers go into EVERY bundle, even
# though a machine only ever runs one. platform.js selects the implementation
# with a conditional require, so the unused files are dead weight (a few KB) --
# but shipping them all means no bundle can be missing the piece its own
# dispatcher needs, and unzipping the wrong zip on the wrong OS still works.
New-Item -ItemType Directory -Path (Join-Path $stage "agent\helpers") -Force | Out-Null
foreach ($pf in @("platform.js", "platform-util.js", "platform-windows.js",
                  "platform-linux.js", "platform-macos.js", "host-panel.js",
                  "binaries.js")) {
  Copy-Item (Join-Path $root "agent\$pf") (Join-Path $stage "agent")
}
foreach ($hf in @("input-linux.js", "input-macos.js")) {
  Copy-Item (Join-Path $root "agent\helpers\$hf") (Join-Path $stage "agent\helpers")
}
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

# ===========================================================================
#  macOS and Linux bundles
# ===========================================================================
# Same agent.js and same viewer; only the platform layer and the launcher
# differ. These get their own stage so the Windows-only pieces (the three
# PowerShell helpers and the two .bat files) are not shipped to a Mac or a
# Linux box, where they would be dead weight. `ws` is bundled here too, so a
# normal first run still needs no internet.

function New-UnixBundle {
  param([string]$Flavour)   # "linux" or "macos"

  $u = Join-Path $env:TEMP "clankerdesk-$Flavour"
  if (Test-Path $u) { Remove-Item $u -Recurse -Force }
  New-Item -ItemType Directory -Path $u, (Join-Path $u "agent"),
                                      (Join-Path $u "agent\helpers"),
                                      (Join-Path $u "src") -Force | Out-Null

  Copy-Item (Join-Path $root "Setup.sh")                $u
  Copy-Item (Join-Path $root "Start-Agent.sh")          $u
  Copy-Item (Join-Path $root "ClankerDesk.svg")         $u
  Copy-Item (Join-Path $root "agent\agent.js")          (Join-Path $u "agent")
  # Every platform file and both input helpers, exactly like the Windows
  # bundle -- platform.js conditionally requires its implementation, so the
  # complete set is what keeps each bundle self-contained.
  foreach ($pf in @("platform.js", "platform-util.js", "platform-windows.js",
                    "platform-linux.js", "platform-macos.js", "host-panel.js",
                    "binaries.js")) {
    Copy-Item (Join-Path $root "agent\$pf") (Join-Path $u "agent")
  }
  foreach ($hf in @("input-linux.js", "input-macos.js")) {
    Copy-Item (Join-Path $root "agent\helpers\$hf") (Join-Path $u "agent\helpers")
  }
  Copy-Item (Join-Path $root "agent\selfhost-deploy.js") (Join-Path $u "agent")
  Copy-Item (Join-Path $root "src\index.js")            (Join-Path $u "src")
  Copy-Item (Join-Path $root "wrangler.jsonc")          $u
  New-Item -ItemType Directory -Path (Join-Path $u "agent\node_modules") -Force | Out-Null
  Copy-Item $wsSrc (Join-Path $u "agent\node_modules\ws") -Recurse

  # Same package.json safety net as the Windows bundle.
  @'
{
  "name": "clankerdesk-bundle",
  "version": "1.0",
  "private": true,
  "dependencies": {
    "ws": "^8.18.0"
  }
}
'@ | ForEach-Object { [System.IO.File]::WriteAllText((Join-Path $u "package.json"), $_, $utf8nb) }

  # Settings template. Identical JSON keys -- the agent reads the same config
  # everywhere -- but the comments name the right editor and drop the
  # Windows-only audio-cable advice, which would only confuse a Mac or a
  # Linux user.
  $AudioComment = if ($Flavour -eq "macos") {
@'
  // macOS cannot capture system audio by itself. To let remote viewers HEAR
  // this Mac, install a virtual device:   brew install blackhole-2ch
  // then put the device name here (find it with:
  // ffmpeg -f avfoundation -list_devices true -i ""). Leave empty for
  // video-only with no sound -- everything else still works.
'@
  } else {
@'
  // Leave empty to listen to whatever this machine plays through
  // PulseAudio/PipeWire (no audio cable needed). Set a source name like
  // "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor" to capture that
  // one device instead.
'@
  }

  $config = @"
{
  // ClankerDesk settings. Edit with any text editor, save, restart ClankerDesk.
  // The agent registers this PC in the dashboard automatically.

  // The ClankerDesk relay (permanent address, do not change):
  "relayUrl": "wss://clankerdesk.remote-me-braeden.workers.dev/ws",

  // YOUR private key from signing up on the website (Sign up -> copy key).
  // It links this PC to YOUR account -- only your login sees it in Devices.
  "relayToken": "PASTE-YOUR-PRIVATE-KEY-HERE",
  "useRelay": true,

  // Name shown in the dashboard. Leave empty to use this machine's name.
  "deviceName": "",

  // Optional extra "anyone with this link" access that bypasses the PIN
  // (links rotate every time the agent restarts). Off by default.
  "publicLink": false,

  // Local page on this machine (http://localhost:8000):
  "viewerPort": 8000,
  "openViewer": false,
  "allowEmbed": true,

$AudioComment
  "audioDevice": "",

  // Windows-only: force the cable the VIEWER'S MIC plays into, for the
  // two-cable setup. Ignored on macOS and Linux.
  "micDevice": "",

  // Default stream quality: "1080p60", "720p60" or "1080p30".
  // Viewers can switch any time with the quality button in the viewer.
  "quality": "1080p60"
}
"@
  [System.IO.File]::WriteAllText((Join-Path $u "config.json"), $config, $utf8nb)

  $howTo = if ($Flavour -eq "macos") { @"
ClankerDesk on macOS - quick start
==================================

1. Unzip, then open Terminal in that folder and run:

       chmod +x Setup.sh Start-Agent.sh
       ./Setup.sh

   That installs ffmpeg and cliclick and starts ClankerDesk.

2. IMPORTANT - macOS permissions. Open System Settings > Privacy & Security
   and turn on BOTH:

       Screen Recording
       Accessibility

   In each one, click + and add your terminal app (Terminal, iTerm, VS Code).
   Then QUIT that app completely, open it again, and start ClankerDesk once
   more. Without this you get a black screen and a mouse that does nothing.

3. Sign up on the website (free). Copy your PRIVATE KEY. Put it on the
   "relayToken" line in config.json, save, and restart ClankerDesk.
   This Mac now shows up under YOUR account in Devices.

4. Give the PIN (printed in the terminal) to anyone who should connect.

Sound
=====
macOS has no built-in way to capture what the machine is playing. To let
remote viewers HEAR this Mac:

       brew install blackhole-2ch

then set "audioDevice" in config.json to the device that lists. Without it
viewers see the picture but hear nothing -- everything else still works.

Notes
=====
* Video, mouse and keyboard all work with no sound device installed.
* Apple Silicon and Intel are both handled: it uses the built-in
  VideoToolbox hardware encoder, so there is nothing extra to set up.
* Games with anti-cheat may ignore synthetic mouse movement. That is a
  limitation of every remote desktop tool, not a fault in this one.
"@ } else { @"
ClankerDesk on Linux - quick start
==================================

1. Unzip, then open a terminal in that folder and run:

       chmod +x Setup.sh Start-Agent.sh
       ./Setup.sh

   That installs ffmpeg, xdotool and pactl, then starts ClankerDesk.

2. If you are on WAYLAND (GNOME 42+, KDE Plasma 6, Wayland-only sessions):
   xdotool cannot move the mouse. EITHER log in to an X11 session instead
   (at the login screen pick "Ubuntu on Xorg"), OR install ydotool:

       sudo apt install ydotool
       sudo ydotoald

   Screen capture under Wayland goes through XWayland, so some pop-up
   windows may not show up in the stream. An X11 session avoids that.

3. Sign up on the website (free). Copy your PRIVATE KEY. Put it on the
   "relayToken" line in config.json, save, and restart ClankerDesk.
   This machine now shows up under YOUR account in Devices.

4. Give the PIN (printed in the terminal) to anyone who should connect.

Sound
=====
Nothing to install -- it listens to the PulseAudio/PipeWire monitor source,
the same idea as "what you hear". No audio cable needed.

Notes
=====
* An NVIDIA GPU is used automatically for hardware encoding. Without one it
  falls back to x264 software encoding: a little more CPU, the same quality
  settings, perfectly usable.
* Games with anti-cheat may ignore synthetic mouse movement. That is a
  limitation of every remote desktop tool, not a fault in this one.
"@ }

  [System.IO.File]::WriteAllText((Join-Path $u "HOW-TO.txt"), $howTo, $utf8nb)
  return $u
}

# --- zip it up: full setup + portable + linux + macos -------------------------
$Version = "1.0"
$vFull = Join-Path $outDir "clankerdesk-v$Version.zip"
$vPort = Join-Path $outDir "clankerdesk-v$Version-portable.zip"
$vPortLatest = Join-Path $outDir "clankerdesk-portable.zip"
$vLinux = Join-Path $outDir "clankerdesk-v$Version-linux.zip"
$vMac = Join-Path $outDir "clankerdesk-v$Version-macos.zip"

foreach ($f in @($outZip, $vFull, $vPort, $vPortLatest, $vLinux, $vMac)) {
  if (Test-Path $f) { Remove-Item $f -Force }
}

# 1) full setup (includes Setup.bat) -> versioned file + "latest" alias
Compress-Archive -Path "$stage\*" -DestinationPath $vFull
Copy-Item $vFull $outZip

# 2) portable (no Setup.bat; Start-Agent.bat installs npm deps itself)
Remove-Item (Join-Path $stage "Setup.bat") -Force
Compress-Archive -Path "$stage\*" -DestinationPath $vPort
Copy-Item $vPort $vPortLatest

# 3) Linux and macOS
$unixLinux = New-UnixBundle -Flavour "linux"
Compress-Archive -Path "$unixLinux\*" -DestinationPath $vLinux
$unixMac = New-UnixBundle -Flavour "macos"
Compress-Archive -Path "$unixMac\*" -DestinationPath $vMac

foreach ($f in @($vFull, $vPort, $outZip, $vLinux, $vMac)) {
  $kb = [math]::Round((Get-Item $f).Length / 1KB)
  Write-Host ("Built " + (Split-Path $f -Leaf) + " ($kb KB)")
}
Write-Host "Publish it with:  npx.cmd wrangler deploy"
