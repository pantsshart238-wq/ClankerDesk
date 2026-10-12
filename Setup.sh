#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  ClankerDesk setup for macOS and Linux -- run this ONCE, in a terminal:
#      cd /path/to/ClankerDesk
#      chmod +x Setup.sh Start-Agent.sh
#      ./Setup.sh
#
#  It installs the few packages the agent needs, then starts it.
#
#  Nothing here is ClankerDesk-specific: these are the ordinary packages any
#  screen-sharing tool needs on that OS.
# ---------------------------------------------------------------------------
set -u

cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
say()  { printf '  %s\n' "$1"; }
warn() { printf '  \033[33m%s\033[0m\n' "$1"; }

OS="$(uname -s)"
bold ""
bold "  ============================================"
bold "    ClankerDesk setup ($OS)"
bold "  ============================================"
bold ""

# ===========================================================================
#  macOS
# ===========================================================================
if [ "$OS" = "Darwin" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    warn "Homebrew is not installed, so this script cannot install anything."
    say  "Install it first from https://brew.sh, then run this again:"
    say  "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    say  ""
    say  "Or install these by hand: ffmpeg, cliclick, node"
    exit 1
  fi

  bold "  [1/2] Installing ffmpeg (screen capture + encoding)..."
  say "      this is the big one; it can take several minutes"
  brew install ffmpeg || warn "ffmpeg install failed -- try again, or: brew install ffmpeg"

  bold "  [2/2] Installing cliclick (mouse + keyboard control)..."
  brew install cliclick || warn "cliclick install failed -- try: brew install cliclick"

  bold ""
  warn "  macOS also needs two permissions. Without them you will get a black"
  warn "  screen and a mouse that does nothing -- this is the most common"
  warn "  reason for \"it just doesn't work\":"
  say  ""
  say  "    System Settings > Privacy & Security > Screen Recording"
  say  "    System Settings > Privacy & Security > Accessibility"
  say  ""
  say  "In each, click + and add your terminal (Terminal, iTerm, VS Code...)."
  say  "Then fully quit and re-open it, and start ClankerDesk again."
  say  ""
  say  "For sound, macOS has no built-in system-audio capture, so install the"
  say  "virtual audio device if you want to HEAR this Mac remotely:"
  say  "    brew install blackhole-2ch"
  say  "Without it the remote side sees this Mac silently. Video, mouse and"
  say  "keyboard all still work."

# ===========================================================================
#  Linux
# ===========================================================================
elif [ "$OS" = "Linux" ]; then
  # Pick whichever package manager this distro actually has.
  PKGS="ffmpeg xdotool"
  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

  if command -v apt-get >/dev/null 2>&1; then
    bold "  [1/2] Installing ffmpeg, xdotool and pactl (Debian/Ubuntu)..."
    $SUDO apt-get update -qq
    $SUDO apt-get install -y $PKGS pulseaudio-utils || warn "apt install failed"
  elif command -v dnf >/dev/null 2>&1; then
    bold "  [1/2] Installing ffmpeg, xdotool and pactl (Fedora)..."
    $SUDO dnf install -y ffmpeg xdotool pulseaudio-utils || warn "dnf install failed"
  elif command -v pacman >/dev/null 2>&1; then
    bold "  [1/2] Installing ffmpeg, xdotool and pactl (Arch)..."
    $SUDO pacman -S --needed --noconfirm ffmpeg xdotool pulseaudio-utils || warn "pacman install failed"
  elif command -v zypper >/dev/null 2>&1; then
    bold "  [1/2] Installing ffmpeg, xdotool and pactl (openSUSE)..."
    $SUDO zypper install -y ffmpeg xdotool pulseaudio-utils || warn "zypper install failed"
  else
    warn "Unrecognised Linux distro -- no package manager found."
    say  "Install these by hand and run this script again:"
    say  "    ffmpeg   xdotool   pulseaudio-utils"
  fi

  bold "  [2/2] Checking your display server..."
  SESSION="${XDG_SESSION_TYPE:-unknown}"
  if [ "$SESSION" = "wayland" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; then
    bold ""
    warn "  You are on WAYLAND. Two things worth knowing:"
    say  ""
    say  "  * The picture comes from XWayland, so some pop-up windows and"
    say  "    screens may be missing or stale."
    say  "  * xdotool CANNOT move your mouse under Wayland. Either log in to an"
    say  "    X11 session instead (GNOME: choose 'Ubuntu on Xorg' at the login"
    say  "    screen), or install ydotool for mouse control:"
    say  "        sudo apt install ydotool && sudo ydotoald"
    say  ""
    warn "  For a first test, an X11 session is the reliable choice."
  else
    say "  X11 session -- this is the well-trodden path, good."
  fi
else
  warn "Unsupported operating system: $OS"
  exit 1
fi

# ===========================================================================
#  Node.js
# ===========================================================================
bold ""
if command -v node >/dev/null 2>&1; then
  say "  Node.js is installed ($(node --version))."
else
  warn "  Node.js was NOT found."
  say  "    macOS:  brew install node"
  say  "    Debian: sudo apt install nodejs npm"
  say  "    Fedora: sudo dnf install nodejs"
  say  "    Arch:   sudo pacman -S nodejs npm"
  say  ""
  say  "  Install it, then run ./Start-Agent.sh"
  exit 1
fi

# The one bundled dependency.
if [ -d "agent/node_modules/ws" ]; then
  say "  ws is bundled in this download -- nothing else to install."
else
  say "  Installing ws..."
  npm install --no-audit --no-fund || warn "npm install failed"
fi

chmod +x Start-Agent.sh 2>/dev/null

bold ""
bold "  ============================================"
bold "    Setup complete"
bold "  ============================================"
bold ""
say "Starting ClankerDesk in a moment."
say "Your device PIN -- what friends use to connect to THIS machine --"
say "is printed below, and also in PUBLIC-LINK.txt."
say ""
say "Press Ctrl+C any time to stop."
bold ""
sleep 2
exec ./Start-Agent.sh
