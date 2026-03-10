#!/usr/bin/env bash
set -euo pipefail

containr_bin="${CONTAINR_BIN:-target/debug/containr}"
containrctl_bin="${CONTAINRCTL_BIN:-target/debug/containrctl}"
postgres_client_image="${POSTGRES_CLIENT_IMAGE:-postgres:16}"

need_bin() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "missing binary: $1" >&2
        exit 1
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

count_running_containers_named() {
    local name="$1"

    docker ps --format '{{.Names}}' | \
        awk -v expected="$name" \
            '$0 == expected { count++ } END { print count + 0 }'
}

psql_query() {
    local network="$1"
    local host="$2"
    local port="$3"
    local user="$4"
    local password="$5"
    local database="$6"
    local sql="$7"

    docker run --rm \
        --network "$network" \
        -e "PGPASSWORD=${password}" \
        "$postgres_client_image" \
        psql \
        -v ON_ERROR_STOP=1 \
        -h "$host" \
        -p "$port" \
        -U "$user" \
        -d "$database" \
        -tAc "$sql"
}

wait_for_psql_value() {
    local network="$1"
    local host="$2"
    local port="$3"
    local user="$4"
    local password="$5"
    local database="$6"
    local sql="$7"
    local expected="$8"
    local attempts=60
    local i
    local output
    local status

    for i in $(seq 1 "$attempts"); do
        set +e
        output="$(
            psql_query \
                "$network" \
                "$host" \
                "$port" \
                "$user" \
                "$password" \
                "$database" \
                "$sql" 2>/dev/null
        )"
        status="$?"
        set -e

        if [ "$status" = "0" ] && [ "$output" = "$expected" ]; then
            return 0
        fi

        sleep 2
    done

    fail "postgres query did not return expected value"
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

wait_for_deployment_running() {
    local project_id="$1"
    local attempts=90
    local i
    local status

    for i in $(seq 1 "$attempts"); do
        ctl projects deployments "$project_id" > "$tmpdir/deployments.json"
        status="$(json "$tmpdir/deployments.json" '.[0].status')"
        if [ "$status" = "running" ]; then
            return 0
        fi
        if [ "$status" = "failed" ]; then
            cat "$tmpdir/deployments.json" >&2
            fail "deployment failed"
        fi
        sleep 2
    done

    cat "$tmpdir/deployments.json" >&2
    fail "deployment did not reach running state"
}

cleanup() {
    if [ -n "${server_pid:-}" ] && kill -0 "$server_pid" >/dev/null 2>&1; then
        kill "$server_pid" >/dev/null 2>&1 || true
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
server_pid=""
trap cleanup EXIT

mkdir -p "$data_dir"
cp containr.example.toml "$config"

sed -i \
    "s|path = \"./data/containr.sqlite3\"|path = \"$data_dir/containr.sqlite3\"|" \
    "$config"
sed -i "s|http_port = 80|http_port = 18080|" "$config"
sed -i "s|https_port = 443|https_port = 18443|" "$config"
sed -i \
    's|base_domain = "example.com"|base_domain = "containr.local"|' \
    "$config"
sed -i 's|public_ip = ""|public_ip = "127.0.0.1"|' "$config"
sed -i \
    's|jwt_secret = ".*"|jwt_secret = "test-jwt-secret"|' \
    "$config"
sed -i \
    's|encryption_key = ".*"|encryption_key = "test-encryption-secret"|' \
    "$config"
sed -i 's|email = ".*"|email = "admin@containr.local"|' "$config"
sed -i \
    "s|certs_dir = \"./data/certs\"|certs_dir = \"$data_dir/certs\"|" \
    "$config"
sed -i "s|data_dir = \"/data/containr\"|data_dir = \"$data_dir\"|" \
    "$config"

"$containr_bin" server \
    --config "$config" \
    --data-dir "$data_dir" \
    --api-port 2077 \
    --http-port 18080 \
    --https-port 18443 >"$tmpdir/server.log" 2>&1 &
server_pid="$!"

wait_for_health "http://127.0.0.1:2077/health"

ctl init \
    --url http://127.0.0.1:2077 \
    --instance-id local \
    --timeout-secs 180 >/dev/null
ctl config show > "$tmpdir/config-show.json"
expect_eq "$(json "$tmpdir/config-show.json" '.config.active_instance')" \
    "default"
ctl register \
    --email e2e@example.com \
    --password testpass123 >/dev/null
ctl login \
    --email e2e@example.com \
    --password testpass123 >/dev/null

stored_token="$(extract_client_secret token)"
[ -n "$stored_token" ] || fail "missing stored token in client config"

ctl init \
    --name alt \
    --url http://127.0.0.1:2077 \
    --instance-id alt-local \
    --timeout-secs 180 >/dev/null
ctl config use alt >/dev/null
ctl config set-url http://127.0.0.1:2077 >/dev/null
ctl config set-instance-id alt-instance >/dev/null
ctl config set-token "$stored_token" >/dev/null
ctl health > "$tmpdir/health.json"
expect_eq "$(json "$tmpdir/health.json" '.status')" "ok"
ctl config clear-auth >/dev/null
set +e
authless_output="$(ctl projects list 2>&1)"
authless_status="$?"
set -e
expect_eq "$authless_status" "1"
expect_contains "$authless_output" "missing a token or api_key"
ctl config set-api-key "$stored_token" >/dev/null
ctl projects list > "$tmpdir/projects-empty.json"
expect_eq "$(jq 'length' "$tmpdir/projects-empty.json")" "0"
ctl config use default >/dev/null

cat > "$tmpdir/project.toml" <<'EOF'
name = "svcgroup"
source_url = ""

[[services]]
name = "web"
image = "hashicorp/http-echo:1.0.0"
service_type = "web_service"
port = 5678
expose_http = true
command = ["-text=web"]

[[services]]
name = "worker"
image = "busybox:1.36"
service_type = "background_worker"
port = 0
command = ["sh", "-c", "while true; do echo worker-ok; sleep 5; done"]

[[services]]
name = "cron"
image = "busybox:1.36"
service_type = "cron_job"
port = 0
schedule = "*/5 * * * *"
command = ["sh", "-c", "echo cron-ran"]
EOF

ctl projects apply --file "$tmpdir/project.toml" --no-deploy \
    > "$tmpdir/apply.json"
project_id="$(json "$tmpdir/apply.json" '.project.id')"
ctl projects list > "$tmpdir/projects.json"
expect_eq "$(jq 'length' "$tmpdir/projects.json")" "1"
ctl projects get "$project_id" > "$tmpdir/project-get.json"
expect_eq "$(json "$tmpdir/project-get.json" '.id')" "$project_id"
ctl projects deploy --id "$project_id" >/dev/null
wait_for_deployment_running "$project_id"
ctl projects metrics "$project_id" > "$tmpdir/project-metrics.json"
ctl projects deployments "$project_id" > "$tmpdir/project-deployments.json"
deployment_id="$(json "$tmpdir/project-deployments.json" '.[0].id')"
deployment_logs="$(ctl projects deployment-logs \
    --project-id "$project_id" \
    --deployment-id "$deployment_id" \
    --limit 50)"
expect_nonempty "$deployment_logs"

ctl services list --group-id "$project_id" > "$tmpdir/services.json"
web_id="$(jq -r '.[] | select(.name=="web") | .id' "$tmpdir/services.json")"
worker_id="$(jq -r '.[] | select(.name=="worker") | .id' "$tmpdir/services.json")"
cron_id="$(jq -r '.[] | select(.name=="cron") | .id' "$tmpdir/services.json")"

expect_eq \
    "$(jq -r '.[] | select(.name=="web") | .status' "$tmpdir/services.json")" \
    "running"
expect_eq \
    "$(jq -r '.[] | select(.name=="worker") | .status' "$tmpdir/services.json")" \
    "running"
expect_eq \
    "$(jq -r '.[] | select(.name=="cron") | .status' "$tmpdir/services.json")" \
    "stopped"

ctl services get "$worker_id" > "$tmpdir/worker-service.json"
expect_eq "$(json "$tmpdir/worker-service.json" '.id')" "$worker_id"

worker_logs="$(
    ctl services logs --id "$worker_id" --tail 20
)"
expect_contains "$worker_logs" "worker-ok"

ctl services stop "$worker_id" > "$tmpdir/worker-stop.json"
expect_eq "$(json "$tmpdir/worker-stop.json" '.status')" "stopped"

ctl services start "$worker_id" > "$tmpdir/worker-start.json"
expect_eq "$(json "$tmpdir/worker-start.json" '.status')" "running"

ctl services restart "$worker_id" > "$tmpdir/worker-restart.json"
expect_eq "$(json "$tmpdir/worker-restart.json" '.status')" "running"

expect_contains \
    "$(curl -s -H 'Host: svcgroup.containr.local' http://127.0.0.1:18080)" \
    "^web$"
expect_contains \
    "$(curl -s -H 'Host: web.svcgroup.containr.local' http://127.0.0.1:18080)" \
    "^web$"

set +e
cron_start_output="$(ctl services start "$cron_id" 2>&1)"
cron_start_status="$?"
set -e
expect_eq "$cron_start_status" "1"
expect_contains "$cron_start_output" "cannot be started manually"

ctl services delete "$cron_id" >/dev/null
ctl services list --group-id "$project_id" > "$tmpdir/services.json"
expect_eq "$(jq 'length' "$tmpdir/services.json")" "2"

cat > "$tmpdir/project-v2.toml" <<'EOF'
name = "svcgroup"
source_url = ""

[[services]]
name = "web"
image = "hashicorp/http-echo:1.0.0"
service_type = "web_service"
port = 5678
expose_http = true
command = ["-text=web-v2"]

[[services]]
name = "worker"
image = "busybox:1.36"
service_type = "background_worker"
port = 0
command = ["sh", "-c", "while true; do echo worker-v2; sleep 5; done"]
EOF

ctl projects apply --file "$tmpdir/project-v2.toml" --id "$project_id" \
    > "$tmpdir/project-update.json"
wait_for_deployment_running "$project_id"
expect_contains \
    "$(curl -s -H 'Host: svcgroup.containr.local' http://127.0.0.1:18080)" \
    "^web-v2$"
ctl projects deployments "$project_id" > "$tmpdir/project-deployments.json"
latest_deployment_id="$(json "$tmpdir/project-deployments.json" '.[0].id')"
previous_deployment_id="$(json "$tmpdir/project-deployments.json" '.[1].id')"
ctl projects rollback \
    --project-id "$project_id" \
    --deployment-id "$previous_deployment_id" >/dev/null
wait_for_deployment_running "$project_id"
expect_contains \
    "$(curl -s -H 'Host: svcgroup.containr.local' http://127.0.0.1:18080)" \
    "^web$"
ctl projects deployments "$project_id" > "$tmpdir/project-deployments.json"
current_deployment_id="$(json "$tmpdir/project-deployments.json" '.[0].id')"
[ "$current_deployment_id" != "$latest_deployment_id" ] || \
    fail "rollback did not create a new deployment"

ctl databases create \
    --name shared-cache \
    --db-type redis \
    --group-id "$project_id" > "$tmpdir/redis.json"
ctl databases create \
    --name ledger \
    --db-type postgres \
    --group-id "$project_id" > "$tmpdir/postgres.json"
ctl databases create \
    --name vector \
    --db-type qdrant > "$tmpdir/qdrant.json"
ctl queues create \
    --name events \
    --queue-type rabbitmq > "$tmpdir/rabbitmq.json"
ctl queues create \
    --name jobs \
    --queue-type rabbitmq > "$tmpdir/rabbitmq-jobs.json"

redis_id="$(json "$tmpdir/redis.json" '.id')"
redis_host="$(json "$tmpdir/redis.json" '.internal_host')"
redis_pass="$(json "$tmpdir/redis.json" '.password')"
postgres_id="$(json "$tmpdir/postgres.json" '.id')"
postgres_host="$(json "$tmpdir/postgres.json" '.internal_host')"
postgres_port="$(json "$tmpdir/postgres.json" '.port')"
postgres_user="$(json "$tmpdir/postgres.json" '.username')"
postgres_pass="$(json "$tmpdir/postgres.json" '.password')"
postgres_db="$(json "$tmpdir/postgres.json" '.database_name')"
qdrant_id="$(json "$tmpdir/qdrant.json" '.id')"
rabbit_id="$(json "$tmpdir/rabbitmq.json" '.id')"
jobs_queue_id="$(json "$tmpdir/rabbitmq-jobs.json" '.id')"

ctl databases list --group-id "$project_id" > "$tmpdir/databases-group.json"
expect_eq "$(jq 'length' "$tmpdir/databases-group.json")" "2"
ctl databases list > "$tmpdir/databases-all.json"
expect_eq "$(jq 'length' "$tmpdir/databases-all.json")" "3"
ctl databases get "$postgres_id" > "$tmpdir/postgres-get.json"
expect_eq "$(json "$tmpdir/postgres-get.json" '.id')" "$postgres_id"
expect_contains "$(ctl databases logs --id "$postgres_id" --tail 50)" \
    "database system"

ctl databases pitr --id "$postgres_id" --enabled > "$tmpdir/postgres-pitr.json"
expect_eq "$(json "$tmpdir/postgres-pitr.json" '.pitr_enabled')" "true"

ctl databases proxy --id "$postgres_id" --enabled > "$tmpdir/postgres-proxy.json"
expect_eq "$(json "$tmpdir/postgres-proxy.json" '.proxy_enabled')" "true"
expect_eq "$(json "$tmpdir/postgres-proxy.json" '.proxy_port')" "6432"

expect_eq \
    "$(count_running_containers_named "containr-db-proxy-${postgres_id}")" \
    "1"

wait_for_psql_value \
    "containr-${project_id}" \
    "$postgres_host" \
    "$postgres_port" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "select current_database();" \
    "$postgres_db"
wait_for_psql_value \
    "containr-${project_id}" \
    "${postgres_host}-proxy" \
    "6432" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "select 1;" \
    "1"

psql_query \
    "containr-${project_id}" \
    "$postgres_host" \
    "$postgres_port" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "drop table if exists containr_pitr_check;"
psql_query \
    "containr-${project_id}" \
    "$postgres_host" \
    "$postgres_port" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "create table containr_pitr_check(value text not null);"
psql_query \
    "containr-${project_id}" \
    "$postgres_host" \
    "$postgres_port" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "insert into containr_pitr_check values ('before');"

ctl databases base-backup \
    --id "$postgres_id" \
    --label baseline > "$tmpdir/postgres-base-backup.json"
expect_eq \
    "$(json "$tmpdir/postgres-base-backup.json" '.label')" \
    "baseline"

ctl databases restore-point \
    --id "$postgres_id" \
    --restore-point stable > "$tmpdir/postgres-restore-point.json"
expect_eq \
    "$(json "$tmpdir/postgres-restore-point.json" '.restore_point')" \
    "stable"

psql_query \
    "containr-${project_id}" \
    "$postgres_host" \
    "$postgres_port" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "insert into containr_pitr_check values ('after');"
expect_eq \
    "$(
        psql_query \
            "containr-${project_id}" \
            "$postgres_host" \
            "$postgres_port" \
            "$postgres_user" \
            "$postgres_pass" \
            "$postgres_db" \
            "select count(*) from containr_pitr_check;"
    )" \
    "2"

ctl databases recover \
    --id "$postgres_id" \
    --restore-point stable > "$tmpdir/postgres-recover.json"
expect_eq "$(json "$tmpdir/postgres-recover.json" '.recovered')" "true"

wait_for_psql_value \
    "containr-${project_id}" \
    "$postgres_host" \
    "$postgres_port" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "select string_agg(value, ',' order by value) from containr_pitr_check;" \
    "before"
wait_for_psql_value \
    "containr-${project_id}" \
    "${postgres_host}-proxy" \
    "6432" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "select count(*) from containr_pitr_check;" \
    "1"

ctl databases expose --id "$postgres_id" --enabled \
    > "$tmpdir/postgres-expose.json"
postgres_public_port="$(json "$tmpdir/postgres-expose.json" '.external_port')"
wait_for_psql_value \
    "host" \
    "127.0.0.1" \
    "$postgres_public_port" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "select current_database();" \
    "$postgres_db"

ctl databases stop "$postgres_id" > "$tmpdir/postgres-stop.json"
expect_eq "$(json "$tmpdir/postgres-stop.json" '.status')" "stopped"
ctl databases start "$postgres_id" > "$tmpdir/postgres-start.json"
expect_eq "$(json "$tmpdir/postgres-start.json" '.status')" "running"
ctl databases restart "$postgres_id" > "$tmpdir/postgres-restart.json"
expect_eq "$(json "$tmpdir/postgres-restart.json" '.status')" "running"
ctl services restart "$postgres_id" > "$tmpdir/postgres-service-restart.json"
expect_eq \
    "$(json "$tmpdir/postgres-service-restart.json" '.status')" \
    "running"
expect_eq \
    "$(count_running_containers_named "containr-db-proxy-${postgres_id}")" \
    "1"
wait_for_psql_value \
    "containr-${project_id}" \
    "${postgres_host}-proxy" \
    "6432" \
    "$postgres_user" \
    "$postgres_pass" \
    "$postgres_db" \
    "select count(*) from containr_pitr_check;" \
    "1"

ctl services list > "$tmpdir/all-services.json"
expect_contains \
    "$(jq -r '.[] | [.resource_kind,.service_type,.name] | @tsv' "$tmpdir/all-services.json")" \
    "managed_database\tredis\tshared-cache"
expect_contains \
    "$(jq -r '.[] | [.resource_kind,.service_type,.name] | @tsv' "$tmpdir/all-services.json")" \
    "managed_database\tpostgres\tledger"
expect_contains \
    "$(jq -r '.[] | [.resource_kind,.service_type,.name] | @tsv' "$tmpdir/all-services.json")" \
    "managed_database\tqdrant\tvector"
expect_contains \
    "$(jq -r '.[] | [.resource_kind,.service_type,.name] | @tsv' "$tmpdir/all-services.json")" \
    "managed_queue\trabbitmq\tevents"

expect_contains \
    "$(ctl services logs --id "$qdrant_id" --tail 20)" \
    "qdrant"
expect_contains \
    "$(ctl services logs --id "$rabbit_id" --tail 20)" \
    "RabbitMQ"

ctl services restart "$qdrant_id" > "$tmpdir/qdrant-restart.json"
expect_eq "$(json "$tmpdir/qdrant-restart.json" '.status')" "running"

ctl services restart "$rabbit_id" > "$tmpdir/rabbit-restart.json"
expect_eq "$(json "$tmpdir/rabbit-restart.json" '.status')" "running"

ctl databases expose --id "$qdrant_id" --enabled > "$tmpdir/qdrant-expose.json"
ctl queues expose --id "$rabbit_id" --enabled > "$tmpdir/rabbit-expose.json"
ctl queues list > "$tmpdir/queues-all.json"
expect_eq "$(jq 'length' "$tmpdir/queues-all.json")" "2"
ctl queues get "$rabbit_id" > "$tmpdir/rabbit-get.json"
expect_eq "$(json "$tmpdir/rabbit-get.json" '.id')" "$rabbit_id"
ctl queues stop "$rabbit_id" > "$tmpdir/rabbit-stop.json"
expect_eq "$(json "$tmpdir/rabbit-stop.json" '.status')" "stopped"
ctl queues start "$rabbit_id" > "$tmpdir/rabbit-start.json"
expect_eq "$(json "$tmpdir/rabbit-start.json" '.status')" "running"

qdrant_port="$(json "$tmpdir/qdrant-expose.json" '.external_port')"
rabbit_port="$(json "$tmpdir/rabbit-expose.json" '.external_port')"

expect_contains \
    "$(curl -s "http://127.0.0.1:${qdrant_port}/")" \
    "qdrant"
bash -lc "cat < /dev/null > /dev/tcp/127.0.0.1/${rabbit_port}"

ctl services get "$qdrant_id" > "$tmpdir/qdrant-service.json"
ctl services get "$rabbit_id" > "$tmpdir/rabbit-service.json"
expect_eq "$(json "$tmpdir/qdrant-service.json" '.external_port')" \
    "$qdrant_port"
expect_eq "$(json "$tmpdir/rabbit-service.json" '.external_port')" \
    "$rabbit_port"

ctl containers list > "$tmpdir/containers.json"
worker_container_id="$(
    jq -r --arg rid "$project_id" \
        '.[] | select(
            .resource_type == "app" and
            .resource_id == $rid and
            (.name | contains("(worker)"))
        ) | .id' "$tmpdir/containers.json" | \
        head -n 1
)"
[ -n "$worker_container_id" ] || fail "missing worker container id"
expect_contains \
    "$(ctl containers logs --id "$worker_container_id" --tail 20)" \
    "worker"

ctl system stats > "$tmpdir/system-stats.json"
cpu_percent="$(json "$tmpdir/system-stats.json" '.cpu_percent')"
[ "$cpu_percent" != "null" ] || fail "missing cpu_percent in system stats"

same_group="$(
    docker run --rm \
        --network "containr-${project_id}" \
        valkey/valkey:8 \
        valkey-cli -h "$redis_host" -a "$redis_pass" ping
)"
expect_contains "$same_group" "PONG"

set +e
other_group_output="$(
    docker run --rm \
        --network "containr-svc-${qdrant_id}" \
        valkey/valkey:8 \
        valkey-cli -h "$redis_host" -a "$redis_pass" ping 2>&1
)"
other_group_status="$?"
set -e
expect_eq "$other_group_status" "1"
expect_contains "$other_group_output" "Temporary failure in name resolution"

ctl services delete "$qdrant_id" >/dev/null
ctl services delete "$rabbit_id" >/dev/null
ctl queues delete "$jobs_queue_id" >/dev/null
ctl databases delete "$redis_id" >/dev/null
ctl services list --group-id "$project_id" > "$tmpdir/services-after-db-delete.json"
if jq -e --arg id "$redis_id" '.[] | select(.id == $id)' \
    "$tmpdir/services-after-db-delete.json" >/dev/null; then
    fail "redis service still present after delete"
fi
ctl projects delete "$project_id" >/dev/null

ctl services list > "$tmpdir/final-services.json"
expect_eq "$(jq 'length' "$tmpdir/final-services.json")" "0"

if docker ps -a --format '{{.Names}}' | rg -q "$project_id"; then
    fail "project containers still exist after delete"
fi

if docker ps -a --format '{{.Names}}' | rg -q "$redis_id"; then
    fail "grouped redis container still exists after delete"
fi

if docker ps -a --format '{{.Names}}' | rg -q "$postgres_id"; then
    fail "grouped postgres container still exists after delete"
fi

if docker network ls --format '{{.Name}}' | \
    rg -q "containr-${project_id}"; then
    fail "project network still exists after delete"
fi

echo "e2e services ok"
