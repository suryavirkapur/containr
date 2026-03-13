#!/usr/bin/env bash
set -euo pipefail

containr_bin="${CONTAINR_BIN:-target/debug/containr}"

need_bin() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "missing binary: $1" >&2
        exit 1
    fi
}

sedi() {
    if sed --version >/dev/null 2>&1; then
        sed -i "$@"
    else
        sed -i '' "$@"
    fi
}

wait_for_http() {
    local url="$1"
    local attempts="${2:-90}"
    local i

    for i in $(seq 1 "$attempts"); do
        if curl -sf "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done

    return 1
}

cleanup() {
    if [ -n "${server_pid:-}" ] && kill -0 "$server_pid" >/dev/null 2>&1; then
        kill "$server_pid" >/dev/null 2>&1 || true
        sleep 1
        if kill -0 "$server_pid" >/dev/null 2>&1; then
            kill -9 "$server_pid" >/dev/null 2>&1 || true
        fi
        wait "$server_pid" >/dev/null 2>&1 || true
    fi
    rm -rf "$tmpdir"
}

need_bin docker
need_bin curl
need_bin pnpm

pnpm --dir web build >/dev/null
cargo build -q --bin containr

tmpdir="$(mktemp -d /tmp/containr-e2e-ui-XXXXXX)"
config="$tmpdir/containr.toml"
data_dir="$tmpdir/data"
port_seed="$(( $$ % 1000 ))"
api_port="$(( 23000 + port_seed ))"
http_port="$(( 24000 + port_seed ))"
https_port="$(( 25000 + port_seed ))"
api_url="http://127.0.0.1:${api_port}"
base_url="$api_url"
server_pid=""
trap cleanup EXIT

mkdir -p "$data_dir"
cp containr.example.toml "$config"

sedi "s|path = \"./data/containr.sqlite3\"|path = \"$data_dir/containr.sqlite3\"|" "$config"
sedi "s|port = 2077|port = ${api_port}|" "$config"
sedi "s|http_port = 80|http_port = ${http_port}|" "$config"
sedi "s|https_port = 443|https_port = ${https_port}|" "$config"
sedi 's|base_domain = "example.com"|base_domain = "containr.local"|' "$config"
sedi 's|public_ip = ""|public_ip = "127.0.0.1"|' "$config"
sedi 's|jwt_secret = ".*"|jwt_secret = "ui-smoke-jwt-secret"|' "$config"
sedi 's|encryption_key = ".*"|encryption_key = "ui-smoke-encryption-secret"|' "$config"
sedi 's|email = ".*"|email = "admin@containr.local"|' "$config"
sedi "s|certs_dir = \"./data/certs\"|certs_dir = \"$data_dir/certs\"|" "$config"
sedi "s|data_dir = \"/data/containr\"|data_dir = \"$data_dir\"|" "$config"

"$containr_bin" server \
    --config "$config" \
    --data-dir "$data_dir" \
    --api-port "$api_port" \
    --http-port "$http_port" \
    --https-port "$https_port" >"$tmpdir/server.log" 2>&1 &
server_pid="$!"

wait_for_http "${api_url}/health" || {
    cat "$tmpdir/server.log" >&2
    echo "api failed to start" >&2
    exit 1
}

wait_for_http "${base_url}/login" || {
    echo "web ui failed to start" >&2
    exit 1
}

CONTAINR_SMOKE_BASE_URL="$base_url" pnpm --dir web run smoke:ui

echo "e2e ui smoke completed"
