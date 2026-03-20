#!/usr/bin/env bash
# Rapid development script for containr
# Starts both backend and frontend in dev mode
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[containr]${NC} $1"; }
warn() { echo -e "${YELLOW}[containr]${NC} $1"; }
err() { echo -e "${RED}[containr]${NC} $1"; }

cleanup() {
    log "Shutting down..."
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    wait $BACKEND_PID $FRONTEND_PID 2>/dev/null || true
    log "Done."
}

trap cleanup EXIT INT TERM

# Check if binary exists
if [ ! -f "$PROJECT_DIR/target/release/containr" ]; then
    err "Backend not built. Run: cargo build --release"
    exit 1
fi

log "Starting containr backend..."
cd "$PROJECT_DIR"
./target/release/containr server &
BACKEND_PID=$!
sleep 2

if ! kill -0 $BACKEND_PID 2>/dev/null; then
    err "Backend failed to start"
    exit 1
fi
log "Backend started (PID: $BACKEND_PID)"

log "Starting frontend dev server..."
cd "$PROJECT_DIR/web"
CONTAINR_API_PROXY_URL="http://127.0.0.1:2077" pnpm dev &
FRONTEND_PID=$!
sleep 3

if ! kill -0 $FRONTEND_PID 2>/dev/null; then
    err "Frontend failed to start"
    exit 1
fi
log "Frontend started (PID: $FRONTEND_PID)"

log ""
log "=========================================="
log "  containr development environment ready"
log "=========================================="
log ""
log "  API:      http://127.0.0.1:2077"
log "  Frontend: http://127.0.0.1:3001"
log "  Proxy:    http://127.0.0.1:80"
log "  Domain:   https://adm.svk77.com"
log ""
log "  Press Ctrl+C to stop"
log ""

wait
