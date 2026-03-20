#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

export PATH="/root/.cargo/bin:/root/.local/share/mise/installs/node/24.14.0/bin:/root/.local/share/mise/installs/pnpm/10.30.3:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo is required for systemd builds" >&2
    exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm is required for systemd builds" >&2
    exit 1
fi

cd "$PROJECT_DIR/web"
pnpm build

cd "$PROJECT_DIR"
cargo build --release -p containr
