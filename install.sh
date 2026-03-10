#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH="${1:-containr.toml}"

if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to generate secrets." >&2
    exit 1
fi

if [[ -f "$CONFIG_PATH" && "${FORCE:-0}" != "1" ]]; then
    echo "$CONFIG_PATH already exists. Set FORCE=1 to overwrite." >&2
    exit 0
fi

JWT_SECRET="$(openssl rand -hex 32)"
ENC_KEY="$(openssl rand -hex 32)"
WEBHOOK_SECRET="$(openssl rand -hex 32)"

cat > "$CONFIG_PATH" <<EOF
# containr configuration file

[server]
host = "0.0.0.0"
port = 2077

[database]
path = "./data/containr.sqlite3"

[cache]
path = "./data/cache"

[logging]
dir = "./data/logs"
retention_days = 14

[proxy]
http_port = 80
https_port = 443
base_domain = "svk77.com"
public_ip = ""
load_balance = "round_robin"

[github]
client_id = ""
client_secret = ""
webhook_secret = "$WEBHOOK_SECRET"

[auth]
jwt_secret = "$JWT_SECRET"
jwt_expiry_hours = 24

[security]
encryption_key = "$ENC_KEY"

[acme]
email = ""
certs_dir = "./data/certs"
staging = true

[storage]
data_dir = "/data/containr"
max_volume_size_gb = 10
backup_enabled = false
rustfs_endpoint = "http://localhost:9000"
rustfs_access_key = ""
rustfs_secret_key = ""
EOF

mkdir -p ./data/certs
mkdir -p ./data/cache
mkdir -p ./data/logs

echo "Wrote $CONFIG_PATH and created ./data/{certs,cache,logs}."
