#!/usr/bin/env bash
# ---------------------------------------------------------------------------
#  Start-Agent.sh -- run the ClankerDesk agent on macOS or Linux.
#
#  Settings live in config.json (edit it with any text editor).
#  Ctrl+C in this terminal stops everything.
#
#  First time on this machine? Run ./Setup.sh once -- it installs the few
#  packages this needs. After that, just run this file.
# ---------------------------------------------------------------------------
set -u

cd "$(dirname "$0")"

# ---- Is Node.js here? -------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is required but was not found on this machine."
  echo
  if [ "$(uname -s)" = "Darwin" ]; then
    echo "  Install it with:  brew install node"
    echo "  (or from https://nodejs.org -- pick the LTS build)"
  else
    echo "  Install it with:  sudo apt install nodejs npm"
    echo "  (Fedora: sudo dnf install nodejs   Arch: sudo pacman -S nodejs npm)"
  fi
  echo
  echo "  Then run this file again."
  echo
  exit 1
fi

# ---- The one bundled dependency --------------------------------------------
# ws ships inside the download, so a normal first run needs no internet.
if [ ! -d "agent/node_modules/ws" ]; then
  echo
  echo "  First run: installing dependencies, this can take a minute..."
  echo
  if ! npm install --no-audit --no-fund; then
    echo
    echo "  npm install failed. The download may be incomplete --"
    echo "  re-download ClankerDesk and try again."
    echo
    exit 1
  fi
fi

# ---- Sanity check: is ffmpeg here? -----------------------------------------
# Not fatal on its own (the agent reports it properly), but catching it here
# saves a confusing failure later.
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo
  echo "  NOTE: ffmpeg is not installed, so there will be no picture."
  echo "        Run ./Setup.sh to install it."
  echo
fi

# ---- Open the control panel -------------------------------------------------
# The Linux/macOS equivalent of the ClankerDesk window on Windows: a page with
# this PC's PIN, its connection status and a Stop button. The agent serves it on
# its own port, so wait a moment for that port to answer before asking the
# browser to load it, and never fail the launch if it cannot.
PORT="${VIEWER_PORT:-8000}"
if [ "${CLANKERDESK_NO_PANEL:-0}" != "1" ]; then
  (
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      sleep 1
      if command -v curl >/dev/null 2>&1; then
        curl -sf -o /dev/null "http://127.0.0.1:$PORT/host" && break
      else
        break
      fi
    done
    URL="http://127.0.0.1:$PORT/host"
    if   command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 &
    elif command -v gio >/dev/null 2>&1;       then gio open "$URL" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1;      then open "$URL" >/dev/null 2>&1 &
    fi
  ) &
fi

exec node agent/agent.js
