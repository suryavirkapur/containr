#!/usr/bin/env bash
set -euo pipefail

containr_bin="${CONTAINR_BIN:-target/debug/containr}"
containrctl_bin="${CONTAINRCTL_BIN:-target/debug/containrctl}"

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

ctl() {
    "$containrctl_bin" --config-path "$client_config" "$@"
}

json() {
    jq -r "$2" "$1"
}

fail() {
    echo "error: $*" >&2
    exit 1
}

expect_eq() {
    if [ "$1" != "$2" ]; then
        fail "expected '$2' but got '$1'"
    fi
}

expect_contains() {
    if ! printf '%s' "$1" | rg -q "$2"; then
        fail "expected output to match '$2'"
    fi
}

expect_nonempty() {
    if [ -z "$1" ]; then
        fail "expected non-empty output"
    fi
}

extract_client_secret() {
    local key="$1"

    rg -o "${key} = \"([^\"]+)\"" "$client_config" -r '$1' | head -n 1
}

wait_for_health() {
    local url="$1"
    local attempts=60
    local i

    for i in $(seq 1 "$attempts"); do
        if curl -sf "$url" >/dev/null; then
            return 0
        fi
        sleep 1
    done

    echo "server log:" >&2
    cat "$tmpdir/server.log" >&2
    fail "server did not become healthy"
}

wait_for_service_status() {
    local service_id="$1"
    local expected_status="$2"
    local attempts=90
    local i
    local current_status

    for i in $(seq 1 "$attempts"); do
        ctl services get "$service_id" > "$tmpdir/service-status.json"
        current_status="$(json "$tmpdir/service-status.json" '.status')"
        if [ "$current_status" = "$expected_status" ]; then
            return 0
        fi
        if [ "$current_status" = "failed" ]; then
            cat "$tmpdir/service-status.json" >&2
            fail "service entered failed state"
        fi
        sleep 2
    done

    cat "$tmpdir/service-status.json" >&2
    fail "service did not reach expected status '$expected_status'"
}

wait_for_http_request_log() {
    local service_id="$1"
    local domain="$2"
    local path="$3"
    local attempts=120
    local i

    for i in $(seq 1 "$attempts"); do
        ctl services http-logs --id "$service_id" --limit 20 \
            > "$tmpdir/http-logs.json"

        if [ "$(
            jq \
                --arg domain "$domain" \
                --arg path "$path" \
                '[.[] | select(.domain == $domain and .path == $path)] | length' \
                "$tmpdir/http-logs.json"
        )" -ge 1 ]; then
            return 0
        fi

        sleep 1
    done

    cat "$tmpdir/http-logs.json" >&2
    fail "http request log did not appear"
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
need_bin jq
need_bin rg

if [ ! -x "$containr_bin" ]; then
    fail "containr binary not found at $containr_bin"
fi

if [ ! -x "$containrctl_bin" ]; then
    fail "containrctl binary not found at $containrctl_bin"
fi

tmpdir="$(mktemp -d /tmp/containr-e2e-services-XXXXXX)"
client_config="$tmpdir/client.toml"
config="$tmpdir/containr.toml"
data_dir="$tmpdir/data"
auth_email="e2e-$(date +%s)-$$@example.com"
port_seed="$(( $$ % 1000 ))"
api_port="$(( 20770 + port_seed ))"
http_port="$(( 21770 + port_seed ))"
https_port="$(( 22770 + port_seed ))"
api_url="http://127.0.0.1:${api_port}"
proxy_url="http://127.0.0.1:${http_port}"
server_pid=""
trap cleanup EXIT

mkdir -p "$data_dir"
cp containr.example.toml "$config"

sedi \
    "s|path = \"./data/containr.sqlite3\"|path = \"$data_dir/containr.sqlite3\"|" \
    "$config"
sedi "s|port = 2077|port = ${api_port}|" "$config"
sedi "s|http_port = 80|http_port = ${http_port}|" "$config"
sedi "s|https_port = 443|https_port = ${https_port}|" "$config"
sedi \
    's|base_domain = "example.com"|base_domain = "containr.local"|' \
    "$config"
sedi 's|public_ip = ""|public_ip = "127.0.0.1"|' "$config"
sedi \
    's|jwt_secret = ".*"|jwt_secret = "test-jwt-secret"|' \
    "$config"
sedi \
    's|encryption_key = ".*"|encryption_key = "test-encryption-secret"|' \
    "$config"
sedi 's|email = ".*"|email = "admin@containr.local"|' "$config"
sedi \
    "s|certs_dir = \"./data/certs\"|certs_dir = \"$data_dir/certs\"|" \
    "$config"
sedi "s|data_dir = \"/data/containr\"|data_dir = \"$data_dir\"|" \
    "$config"

"$containr_bin" server \
    --config "$config" \
    --data-dir "$data_dir" \
    --api-port "$api_port" \
    --http-port "$http_port" \
    --https-port "$https_port" >"$tmpdir/server.log" 2>&1 &
server_pid="$!"

wait_for_health "${api_url}/health"

ctl init \
    --url "$api_url" \
    --instance-id local \
    --timeout-secs 180 >/dev/null
ctl config show > "$tmpdir/config-show.json"
expect_eq "$(json "$tmpdir/config-show.json" '.config.active_instance')" \
    "default"
ctl register \
    --email "$auth_email" \
    --password testpass123 >/dev/null
ctl login \
    --email "$auth_email" \
    --password testpass123 >/dev/null

stored_token="$(extract_client_secret token)"
[ -n "$stored_token" ] || fail "missing stored token in client config"

ctl init \
    --name alt \
    --url "$api_url" \
    --instance-id alt-local \
    --timeout-secs 180 >/dev/null
ctl config use alt >/dev/null
ctl config set-url "$api_url" >/dev/null
ctl config set-instance-id alt-instance >/dev/null
ctl config set-token "$stored_token" >/dev/null
ctl health > "$tmpdir/health.json"
expect_eq "$(json "$tmpdir/health.json" '.status')" "ok"
ctl config clear-auth >/dev/null
set +e
authless_output="$(ctl services list 2>&1)"
authless_status="$?"
set -e
expect_eq "$authless_status" "1"
expect_contains "$authless_output" "missing a token or api_key"
ctl config set-api-key "$stored_token" >/dev/null
ctl services list > "$tmpdir/services-empty.json"
expect_eq "$(jq 'length' "$tmpdir/services-empty.json")" "0"
ctl config use default >/dev/null

cat > "$tmpdir/repository-service.toml" <<'EOF_SERVICE'
source = "git_repository"
name = "svcgroup"
github_url = "https://github.com/example/repo.git"
branch = "main"

[[env_vars]]
key = "GLOBAL_MODE"
value = "true"

[service]
name = "web"
image = "nginx:1.27-alpine"
service_type = "web_service"
port = 80
expose_http = true
EOF_SERVICE

ctl services create --file "$tmpdir/repository-service.toml" \
    > "$tmpdir/web-create.json"
web_id="$(json "$tmpdir/web-create.json" '.id')"
wait_for_service_status "$web_id" "running"

cat > "$tmpdir/template-service.toml" <<'EOF_TEMPLATE'
source = "template"
name = "cache"
template = "redis"
EOF_TEMPLATE

ctl services create --file "$tmpdir/template-service.toml" \
    > "$tmpdir/redis-create.json"
redis_id="$(json "$tmpdir/redis-create.json" '.id')"
wait_for_service_status "$redis_id" "running"

ctl services list > "$tmpdir/services.json"
expect_eq "$(jq 'length' "$tmpdir/services.json")" "2"
expect_eq \
    "$(jq -r --arg id "$web_id" '.[] | select(.id == $id) | .project_name' "$tmpdir/services.json")" \
    "svcgroup"
expect_eq \
    "$(jq -r --arg id "$redis_id" '.[] | select(.id == $id) | .name' "$tmpdir/services.json")" \
    "cache"

ctl services get "$web_id" > "$tmpdir/web-service.json"
expect_eq "$(json "$tmpdir/web-service.json" '.id')" "$web_id"
expect_eq "$(json "$tmpdir/web-service.json" '.name')" "web"
web_host="$(
    jq -r '.default_urls[0]' "$tmpdir/web-service.json" | \
        sed -E 's#^https?://##; s#/.*$##'
)"
expect_nonempty "$web_host"

ctl services settings "$web_id" > "$tmpdir/web-settings.json"
expect_eq "$(json "$tmpdir/web-settings.json" '.service_id')" "$web_id"
expect_eq "$(json "$tmpdir/web-settings.json" '.auto_deploy.enabled')" \
    "true"
initial_webhook_token="$(
    json "$tmpdir/web-settings.json" '.auto_deploy.webhook_token'
)"
expect_nonempty "$initial_webhook_token"

cat > "$tmpdir/service-update.toml" <<'EOF_UPDATE'
branch = "release"
rollout_strategy = "start_first"

[[env_vars]]
key = "LOG_LEVEL"
value = "debug"

[auto_deploy]
enabled = false
watch_paths = ["web/**", "Dockerfile"]
cleanup_stale_deployments = false
regenerate_webhook_token = true
EOF_UPDATE

ctl services update \
    --id "$web_id" \
    --file "$tmpdir/service-update.toml" > "$tmpdir/service-update.json"
expect_eq "$(json "$tmpdir/service-update.json" '.id')" "$web_id"

ctl services settings "$web_id" > "$tmpdir/web-settings-updated.json"
expect_eq "$(json "$tmpdir/web-settings-updated.json" '.branch')" \
    "release"
expect_eq "$(json "$tmpdir/web-settings-updated.json" '.rollout_strategy')" \
    "start_first"
expect_eq \
    "$(json "$tmpdir/web-settings-updated.json" '.auto_deploy.enabled')" \
    "false"
expect_eq \
    "$(json "$tmpdir/web-settings-updated.json" '.auto_deploy.cleanup_stale_deployments')" \
    "false"
expect_eq \
    "$(json "$tmpdir/web-settings-updated.json" '.auto_deploy.watch_paths | join(",")')" \
    "web/**,Dockerfile"
expect_eq "$(json "$tmpdir/web-settings-updated.json" '.env_vars[0].key')" \
    "LOG_LEVEL"
expect_eq \
    "$(json "$tmpdir/web-settings-updated.json" '.env_vars[0].value')" \
    "debug"
updated_webhook_token="$(
    json "$tmpdir/web-settings-updated.json" '.auto_deploy.webhook_token'
)"
[ "$updated_webhook_token" != "$initial_webhook_token" ] || \
    fail "deploy webhook token did not change"

curl \
    -sS \
    -o "$tmpdir/http-response.txt" \
    -w '%{http_code}' \
    -H "Host: $web_host" \
    "$proxy_url" > "$tmpdir/http-status.txt" &
http_request_pid="$!"
wait_for_http_request_log "$web_id" "$web_host" "/"
wait "$http_request_pid" >/dev/null 2>&1 || true

http_logs_output="$(ctl services http-logs --id "$web_id" --limit 10)"
expect_contains "$http_logs_output" "$web_host"
expect_contains "$http_logs_output" '"path": "/"'

service_logs="$(ctl services logs --id "$redis_id" --tail 50)"
expect_contains "$service_logs" 'Ready to accept connections tcp|Server initialized'

ctl services stop "$redis_id" > "$tmpdir/redis-stop.json"
expect_eq "$(json "$tmpdir/redis-stop.json" '.status')" "stopped"
wait_for_service_status "$redis_id" "stopped"

ctl services delete "$redis_id" >/dev/null
ctl services delete "$web_id" >/dev/null
ctl services list > "$tmpdir/services-after-delete.json"
expect_eq "$(jq 'length' "$tmpdir/services-after-delete.json")" "0"

echo "e2e services cli flow completed"
