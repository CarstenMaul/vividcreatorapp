#!/usr/bin/env bash
#
# Local start script for VCA (bash / macOS / Linux / WSL).
#
# Usage:
#   ./start.sh            Start the dev server (tsx watch, auto-reload)
#   ./start.sh --prod     Start in production mode (npm start)
#   ./start.sh --no-install   Skip the dependency install step
#
# It will:
#   1. Verify Node.js / npm are available
#   2. Load .env (creating it from .env.example on first run)
#   3. Default WORKSPACES_ROOT to ./.vca-data and create it
#   4. Install dependencies if node_modules is missing
#   5. Launch the server
#
set -euo pipefail

# Always operate from the repo root (this script's directory).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE="dev"
RUN_INSTALL=1
for arg in "$@"; do
  case "$arg" in
    --prod) MODE="prod" ;;
    --no-install) RUN_INSTALL=0 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# --- 1. Toolchain check -----------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed or not on PATH. Install Node 24 (LTS) — the version Electron bundles internally." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed or not on PATH." >&2
  exit 1
fi
echo "Node $(node --version) / npm $(npm --version)"

# --- 2. Load .env -----------------------------------------------------------
if [ ! -f .env ] && [ -f .env.example ]; then
  echo "No .env found — creating one from .env.example."
  cp .env.example .env
fi
if [ -f .env ]; then
  echo "Loading environment from .env"
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# --- 3. WORKSPACES_ROOT -----------------------------------------------------
: "${WORKSPACES_ROOT:=./.vca-data}"
export WORKSPACES_ROOT
mkdir -p "$WORKSPACES_ROOT"
echo "WORKSPACES_ROOT=$WORKSPACES_ROOT"

# Accept self-signed / intercepted certs (corporate TLS proxies). Applies to
# this server's outbound calls; spawned preview processes set it themselves.
export NODE_TLS_REJECT_UNAUTHORIZED=0
echo "PORT=${PORT:-3000}"

# --- 4. Dependencies --------------------------------------------------------
if [ "$RUN_INSTALL" -eq 1 ] && [ ! -d node_modules ]; then
  echo "Installing dependencies (npm install)..."
  npm install
fi

# --- 5. Launch --------------------------------------------------------------
if [ "$MODE" = "prod" ]; then
  echo "Starting VCA (production mode)..."
  exec npm start
else
  echo "Starting VCA (dev mode, auto-reload). Open http://localhost:${PORT:-3000}"
  exec npm run dev
fi
