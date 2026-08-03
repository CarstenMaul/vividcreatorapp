#!/usr/bin/env bash
#
# Build and run VCA in Docker (bash / macOS / Linux / WSL).
#
# Usage:
#   ./start-docker.sh              Build (cached layers reused) and run in foreground
#   ./start-docker.sh --rebuild    Cache-bypassing `docker build --no-cache`
#   ./start-docker.sh --no-build   Skip docker build; require image to exist
#   ./start-docker.sh --detach     Run container in background (-d)
#   ./start-docker.sh --port 8080  Override host port (default: PORT from .env, else 3000)
#
# Defaults:
#   image:      vca:local
#   container:  vca
#   data dir:   ./.vca-data-docker  (mounted at /mnt/storage)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REBUILD=0
NO_BUILD=0
DETACH=0
PORT_OVERRIDE=""
IMAGE_NAME="vca:local"
CONTAINER_NAME="vca"
DATA_DIR="./.vca-data-docker"

while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild)        REBUILD=1; shift ;;
    --no-build)       NO_BUILD=1; shift ;;
    --detach|-d)      DETACH=1; shift ;;
    --port)           PORT_OVERRIDE="${2:-}"; shift 2 ;;
    --image)          IMAGE_NAME="${2:-}"; shift 2 ;;
    --container)      CONTAINER_NAME="${2:-}"; shift 2 ;;
    --data-dir)       DATA_DIR="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# --- 1. Docker check --------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or not on PATH. Install Docker and retry." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not reachable. Start Docker and retry." >&2
  exit 1
fi

# --- 2. Ensure .env ---------------------------------------------------------
if [ ! -f .env ] && [ -f .env.example ]; then
  echo "No .env found — creating one from .env.example."
  cp .env.example .env
fi
if [ ! -f .env ]; then
  echo "ERROR: .env is required. Copy .env.example to .env and retry." >&2
  exit 1
fi

# --- 3. Resolve port (CLI flag > .env > 3000) -------------------------------
if [ -n "$PORT_OVERRIDE" ]; then
  PORT="$PORT_OVERRIDE"
else
  PORT="$(grep -E '^[[:space:]]*PORT[[:space:]]*=' .env | head -1 | sed -E 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*([0-9]+).*/\1/' || true)"
  PORT="${PORT:-3000}"
fi

# --- 4. Resolve data dir to an absolute host path ---------------------------
mkdir -p "$DATA_DIR"
ABS_DATA_DIR="$(cd "$DATA_DIR" && pwd)"
echo "Image:      $IMAGE_NAME"
echo "Container:  $CONTAINER_NAME"
echo "Host port:  $PORT"
echo "Data mount: $ABS_DATA_DIR -> /mnt/storage"

# --- 5. Build image ---------------------------------------------------------
# Always build unless --no-build is passed. Docker's layer cache makes a
# no-change build nearly free, and rebuilding by default means a `git pull`
# is enough to pick up source changes — no stale-image footgun.
if [ "$NO_BUILD" -eq 1 ]; then
  if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    echo "ERROR: Image $IMAGE_NAME does not exist and --no-build was passed." >&2
    exit 1
  fi
  echo "Skipping build; using existing $IMAGE_NAME."
elif [ "$REBUILD" -eq 1 ]; then
  echo "Building image $IMAGE_NAME (--no-cache)..."
  docker build --no-cache -t "$IMAGE_NAME" .
else
  echo "Building image $IMAGE_NAME (cached layers reused)..."
  docker build -t "$IMAGE_NAME" .
fi

# --- 6. Stop any existing container with the same name ---------------------
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# --- 7. Run -----------------------------------------------------------------
RUN_ARGS=(
  run --rm
  --name "$CONTAINER_NAME"
  -p "${PORT}:3000"
  -v "${ABS_DATA_DIR}:/mnt/storage"
  --env-file .env
  -e WORKSPACES_ROOT=/mnt/storage
  -e PORT=3000
  -e NODE_TLS_REJECT_UNAUTHORIZED=0
)

echo "/mnt/storage is mounted from local folder: $ABS_DATA_DIR"
if [ "$DETACH" -eq 1 ]; then
  echo "Starting container in detached mode..."
  docker "${RUN_ARGS[@]}" -d "$IMAGE_NAME"
  echo "Container running. Open http://localhost:$PORT"
  echo "Follow logs:  docker logs -f $CONTAINER_NAME"
  echo "Stop:         docker stop $CONTAINER_NAME"
else
  echo "Starting container. Open http://localhost:$PORT (Ctrl+C to stop)"
  exec docker "${RUN_ARGS[@]}" -it "$IMAGE_NAME"
fi
