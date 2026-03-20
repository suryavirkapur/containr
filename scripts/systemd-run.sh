#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

exec "$PROJECT_DIR/target/release/containr" \
    server \
    --config "$PROJECT_DIR/containr.toml" \
    --log-level info
