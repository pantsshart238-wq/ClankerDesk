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

# ===========================================================================
#  App launcher
# ===========================================================================
# From here on it should be one click, like Windows: a ClankerDesk icon in the
# app menu that starts the agent and opens the control panel (which shows the
# PIN). Installed to the user's own menu -- no root, nothing system-wide.
APPS="$HOME/.local/share/applications"
BIN="$HOME/.local/bin"
mkdir -p "$APPS" "$BIN"
ICON_SRC="$PWD/ClankerDesk.svg"
ICON_DST="$HOME/.local/share/icons/hicolor/scalable/apps/ClankerDesk.svg"

if [ -f "$ICON_SRC" ]; then
  mkdir -p "$(dirname "$ICON_DST")" 2>/dev/null
  cp "$ICON_SRC" "$ICON_DST" 2>/dev/null
fi

# The real work goes in a small script rather than inline in the .desktop Exec
# line: the desktop-entry spec has no quoting rules for single quotes, so a
# quoted `bash -c '...'` there silently passes the quotes through as literal
# characters and the launcher never runs. A script file has no such problem,
# and it lets the launcher be smart about a second click.
AGENT_DIR="$PWD"
cat > "$BIN/clankerdesk" <<LAUNCHER
#!/usr/bin/env bash
# ClankerDesk launcher (created by Setup.sh).
cd "$AGENT_DIR" || exit 1

PORT="\${VIEWER_PORT:-8000}"
PANEL="http://127.0.0.1:\$PORT/host"

# Already running? Then do NOT start a second agent competing for the relay
# and the capture device -- just bring the panel back up, which is what you
# expect when you click an app icon twice.
if command -v curl >/dev/null 2>&1 && curl -sf -o /dev/null "\$PANEL" 2>/dev/null; then
  if   command -v xdg-open >/dev/null 2>&1; then xdg-open "\$PANEL" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1;       then gio open "\$PANEL" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1;      then open "\$PANEL" >/dev/null 2>&1 &
  fi
  exit 0
fi

./Start-Agent.sh
LAUNCHER
chmod +x "$BIN/clankerdesk" 2>/dev/null

cat > "$APPS/clankerdesk.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=ClankerDesk
GenericName=Remote Desktop
Comment=Share this PC's screen, mouse and keyboard
Exec="$BIN/clankerdesk"
Icon=ClankerDesk
Terminal=true
Categories=Utility;RemoteAccess;
Keywords=remote desktop;screen share;clankerdesk;
StartupNotify=false
DESKTOP
chmod +x "$APPS/clankerdesk.desktop" 2>/dev/null

# Also drop it on the Desktop. GNOME/KDE will not run a .desktop straight from
# the Desktop until it is trusted, so say so rather than leaving them clicking
# a dead icon.
DESKTOP_DIR="$HOME/Desktop"
DESKTOP_MADE=0
if [ -d "$DESKTOP_DIR" ] && [ -w "$DESKTOP_DIR" ]; then
  cp "$APPS/clankerdesk.desktop" "$DESKTOP_DIR/ClankerDesk.desktop" 2>/dev/null && chmod +x "$DESKTOP_DIR/ClankerDesk.desktop" 2>/dev/null && DESKTOP_MADE=1
fi

bold ""
bold "  ============================"
bold "    Launcher installed"
bold "  ============================"
bold ""
say "ClankerDesk is now in your app menu -- press the Super key and type"
say "\"ClankerDesk\". That is the one-click way from now on: it starts the"
say "agent and opens a page showing this PC's PIN."
if [ "$DESKTOP_MADE" = "1" ]; then
  say ""
  say "There is also an icon on your Desktop. If double-clicking it does"
  say "nothing, right-click it and choose \"Allow Launching\" -- that is a"
  say "security feature of GNOME and KDE, not a broken download."
fi
say ""
say "This panel shows your PIN, so it only ever opens on this PC."
say "To share it with someone on the internet, use the public link instead"
say "(it rotates every time you start the agent)."

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
