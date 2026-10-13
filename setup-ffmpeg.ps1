# ---------------------------------------------------------------------------
# setup-ffmpeg.ps1 -- get a working ffmpeg onto this PC, however necessary.
# ---------------------------------------------------------------------------
# Why this exists
#
# Setup.bat originally installed Node.js and then ASSUMED ffmpeg was already
# there. It happened to be, on the machine it was developed on. Every other
# machine installed "successfully" and then streamed nothing, reporting
# "spawn ffmpeg ENOENT", "spawn ffplay ENOENT" and a watchdog insisting that
# capture had stalled -- none of which name the real problem.
#
# Then Setup.bat tried to fix it with winget, and winget failed on real
# machines too: it is missing on some Windows installs, refuses to run
# non-interactively, and the App Installer can be removed. So winget alone is
# not a plan.
#
# This tries, in order, and stops at the first that works:
#   1. Nothing -- is ffmpeg already reachable (PATH or a known folder)?
#   2. winget, several package ids, non-interactive, re-checked each time
#   3. A plain HTTPS download of the official Windows build, unpacked into
#      THIS FOLDER (tools\ffmpeg). No installer, no admin, no winget.
#
# Step 3 is the one that always works, and because the copy lives inside the
# ClankerDesk folder, the agent finds it there (agent\binaries.js) with no PATH
# changes at all -- so it cannot be lost by a later restart or a new user.
# ---------------------------------------------------------------------------

param(
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$appRoot   = Split-Path -Parent $MyInvocation.MyCommand.Path
$toolsDir  = Join-Path $appRoot "tools"
$localBin  = Join-Path $toolsDir "ffmpeg"

function Say($msg) {
    if (-not $Quiet) { Write-Host $msg }
}

# --- 1. Is ffmpeg already reachable? ---------------------------------------
# Deliberately mirrors agent\binaries.js, including the app-local tools folder,
# so the two never disagree about whether ffmpeg exists.
function Find-Ffmpeg {
    $cmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $candidates = @(
        (Join-Path $localBin "ffmpeg.exe")
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\ffmpeg.exe")
        "C:\ffmpeg\bin\ffmpeg.exe"
        "C:\Program Files\ffmpeg\bin\ffmpeg.exe"
        (Join-Path $env:ProgramData "chocolatey\bin\ffmpeg.exe")
        (Join-Path $env:USERPROFILE "scoop\shims\ffmpeg.exe")
    )
    # winget's real layout: Packages\<pkg>\ffmpeg-<ver>-<variant>\bin\ffmpeg.exe
    $pkgRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    if (Test-Path $pkgRoot) {
        foreach ($d in (Get-ChildItem $pkgRoot -Directory -ErrorAction SilentlyContinue)) {
            if ($d.Name -like "Gyan.FFmpeg*") {
                $candidates += (Get-ChildItem $d.FullName -Filter "ffmpeg.exe" -Recurse `
                                   -ErrorAction SilentlyContinue |
                               Select-Object -First 1 -ExpandProperty FullName)
            }
        }
    }

    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return $c }
    }
    return $null
}

$existing = Find-Ffmpeg
if ($existing) {
    Say "  ffmpeg is already installed: $existing"
    exit 0
}

# --- 2. winget, with several ids --------------------------------------------
Say "  Installing ffmpeg (the screen capture and encoder)..."
Say ""

if (Get-Command winget -ErrorAction SilentlyContinue) {
    foreach ($id in @("Gyan.FFmpeg", "Gyan.FFmpeg.Essentials", "BtbN.FFmpeg.GPL")) {
        Say "  Trying winget: $id"
        # winget's own exit code is not trustworthy -- it reports failure in
        # situations where the package did install -- so always re-check with
        # Find-Ffmpeg instead of trusting it.
        & winget install --id $id --accept-source-agreements --accept-package-agreements `
              --disable-interactivity --silent 2>&1 | Out-Null

        $found = Find-Ffmpeg
        if ($found) {
            Say "  Installed: $found"
            exit 0
        }
        Say "  ...winget did not result in a usable ffmpeg. Trying the next option."
        Say ""
    }
    Say "  winget could not do it on this PC. Downloading it directly instead..."
    Say ""
} else {
    Say "  winget is not available on this PC. Downloading ffmpeg directly instead..."
    Say ""
}

# --- 3. direct download ------------------------------------------------------
# "ffmpeg-release-essentials.zip" is a stable, version-independent name that
# always points at the current official release, so this link cannot rot.
$url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
$zip = Join-Path $env:TEMP "clankerdesk-ffmpeg.zip"
$scratch = Join-Path $env:TEMP "clankerdesk-ffmpeg"

Say "  Downloading ffmpeg (~110 MB, one-time). This needs internet."

try {
    $ProgressPreference = "SilentlyContinue"   # without this it is agonisingly slow
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 900

    if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $scratch -Force

    $exe = Get-ChildItem $scratch -Filter "ffmpeg.exe" -Recurse -ErrorAction SilentlyContinue |
           Select-Object -First 1
    if (-not $exe) { throw "the download unpacked but contained no ffmpeg.exe" }

    if (Test-Path $localBin) { Remove-Item $localBin -Recurse -Force }
    New-Item -ItemType Directory -Path $toolsDir -Force | Out-Null
    # Copy the whole bin folder, not just ffmpeg.exe: ffplay and ffprobe sit
    # next to it and the agent needs ffplay for viewer microphones.
    Copy-Item $exe.Directory.FullName $localBin -Recurse -Force

    $check = Find-Ffmpeg
    if (-not $check) { throw "ffmpeg.exe was copied but could not be found afterwards" }

    Say ""
    Say "  Installed ffmpeg into this folder: $check"
    Say "  No system changes were made, and nothing needs adding to PATH."
    exit 0
}
catch {
    Say ""
    Say "  That did not work: $($_.Exception.Message)"
    exit 1
}
finally {
    if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
    if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force -ErrorAction SilentlyContinue }
}