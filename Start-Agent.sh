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

exec node agent/agent.js
