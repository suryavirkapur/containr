#!/usr/bin/env bash

set -euo pipefail

usage() {
    cat <<'EOF'
usage: deploy-prod.sh [--wipe-state] [--build-mode auto|native|docker] [commit]

builds a linux/amd64 containr binary, uploads it to production, and restarts the service.

options:
  --wipe-state              remove containr runtime state on the remote host before restart
  --build-mode MODE         override build strategy (default: auto)
  -h, --help                show this help
EOF
}

require_cmd() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "missing required command: $1" >&2
        exit 1
    fi
}

normalize_arch() {
    case "$1" in
        x86_64|amd64) echo "amd64" ;;
        aarch64|arm64) echo "arm64" ;;
        *)
            echo "$1"
            ;;
    esac
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_target="${DEPLOY_TARGET:-root@100.109.217.118}"
deploy_service="${DEPLOY_SERVICE:-containr}"
deploy_binary_path="${DEPLOY_BINARY_PATH:-/usr/local/bin/containr}"
deploy_remote_tmp_path="${DEPLOY_REMOTE_TMP_PATH:-/root/containr.new}"
deploy_verify_url="${DEPLOY_VERIFY_URL:-https://adm.svk77.com/}"
deploy_favicon_url="${DEPLOY_FAVICON_URL:-https://adm.svk77.com/favicon.svg}"
deploy_service_health_url="${DEPLOY_SERVICE_HEALTH_URL:-http://127.0.0.1:3000/health}"
deploy_rustfs_container="${DEPLOY_RUSTFS_CONTAINER:-rustfs}"
deploy_docker_platform="${DEPLOY_DOCKER_PLATFORM:-linux/amd64}"
worktree_dir="${DEPLOY_WORKTREE_DIR:-/tmp/containr-release}"
artifact_dir="$worktree_dir/.deploy-artifacts"
binary_path="$artifact_dir/containr"
build_mode="${DEPLOY_BUILD_MODE:-auto}"
wipe_state=0
commit=""

while [ $# -gt 0 ]; do
    case "$1" in
        --wipe-state)
            wipe_state=1
            ;;
        --build-mode)
            shift
            if [ $# -eq 0 ]; then
                echo "--build-mode requires a value" >&2
                exit 1
            fi
            build_mode="$1"
            ;;
        --build-mode=*)
            build_mode="${1#*=}"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        --*)
            echo "unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
        *)
            if [ -n "$commit" ]; then
                echo "commit already set to $commit" >&2
                exit 1
            fi
            commit="$1"
            ;;
    esac
    shift
done

commit="${commit:-$(git -C "$repo_root" rev-parse HEAD)}"

host_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
host_arch="$(normalize_arch "$(uname -m)")"

case "$build_mode" in
    auto)
        if [ "$host_os" = "linux" ] && [ "$host_arch" = "amd64" ]; then
            build_mode="native"
        else
            build_mode="docker"
        fi
        ;;
    native|docker)
        ;;
    *)
        echo "invalid build mode: $build_mode" >&2
        exit 1
        ;;
esac

cleanup() {
    if git -C "$repo_root" worktree list --porcelain | grep -Fq "worktree $worktree_dir"; then
        git -C "$repo_root" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
    fi

    if [ -d "$worktree_dir" ]; then
        rm -rf "$worktree_dir"
    fi
}

build_native() {
    require_cmd cargo

    if command -v mise >/dev/null 2>&1; then
        mise trust "$worktree_dir/mise.toml" >/dev/null
        (
            cd "$worktree_dir"
            mise install >/dev/null
            mise exec -- cargo build --release -p containr
        )
    else
        (
            cd "$worktree_dir"
            cargo build --release -p containr
        )
    fi

    mkdir -p "$artifact_dir"
    cp "$worktree_dir/target/release/containr" "$binary_path"
}

build_docker() {
    require_cmd docker
    docker buildx version >/dev/null

    mkdir -p "$artifact_dir"

    cat >"$worktree_dir/.deploy-linux.Dockerfile" <<EOF
FROM --platform=$deploy_docker_platform rust:bookworm AS build
RUN apt-get update \\
 && apt-get install -y --no-install-recommends curl ca-certificates git pkg-config libssl-dev build-essential cmake \\
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \\
 && apt-get update \\
 && apt-get install -y --no-install-recommends nodejs \\
 && npm install -g pnpm@10.30.3 \\
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cd web && pnpm install --frozen-lockfile
RUN cd web && pnpm build
RUN cargo build --release -p containr --features containr-api/skip-web-build
RUN install -D target/release/containr /out/containr
FROM scratch AS export
COPY --from=build /out/containr /containr
EOF

    docker buildx build \
        --platform "$deploy_docker_platform" \
        -f "$worktree_dir/.deploy-linux.Dockerfile" \
        --output "type=local,dest=$artifact_dir" \
        "$worktree_dir" >/dev/null
}

trap cleanup EXIT

git -C "$repo_root" rev-parse --verify "${commit}^{commit}" >/dev/null

if git -C "$repo_root" worktree list --porcelain | grep -Fq "worktree $worktree_dir"; then
    git -C "$repo_root" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
fi

if [ -e "$worktree_dir" ]; then
    rm -rf "$worktree_dir"
fi

echo "deploying commit $commit to $deploy_target (build mode: $build_mode)"

git -C "$repo_root" worktree add --detach "$worktree_dir" "$commit" >/dev/null

case "$build_mode" in
    native)
        build_native
        ;;
    docker)
        build_docker
        ;;
esac

scp "$binary_path" "$deploy_target:$deploy_remote_tmp_path"

ssh "$deploy_target" bash -s -- \
    "$deploy_service" \
    "$deploy_binary_path" \
    "$deploy_remote_tmp_path" \
    "$wipe_state" \
    "$deploy_rustfs_container" \
    "$deploy_service_health_url" <<'EOF'
set -euo pipefail

deploy_service="$1"
deploy_binary_path="$2"
deploy_remote_tmp_path="$3"
wipe_state="$4"
deploy_rustfs_container="$5"
deploy_service_health_url="$6"

if [ "$wipe_state" = "1" ]; then
    systemctl stop "$deploy_service" || true

    containr_ids="$(docker ps -aq --filter name=containr- || true)"
    if [ -n "${containr_ids:-}" ]; then
        docker rm -f $containr_ids
    fi

    if docker ps -a --format '{{.Names}}' | grep -Fxq "$deploy_rustfs_container"; then
        docker stop "$deploy_rustfs_container" || true
    fi

    containr_networks="$(docker network ls -q --filter name=^containr- || true)"
    if [ -n "${containr_networks:-}" ]; then
        docker network rm $containr_networks || true
    fi

    containr_volumes="$(docker volume ls -q --filter name=^containr- || true)"
    if [ -n "${containr_volumes:-}" ]; then
        docker volume rm -f $containr_volumes || true
    fi

    for dir in /var/lib/containr /var/lib/rustfs; do
        mkdir -p "$dir"
        find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    done

    mkdir -p /var/lib/rustfs/data /var/lib/rustfs/logs

    if docker ps -a --format '{{.Names}}' | grep -Fxq "$deploy_rustfs_container"; then
        docker start "$deploy_rustfs_container"
    fi
fi

ts="$(date +%Y%m%d%H%M%S)"
if [ -f "$deploy_binary_path" ]; then
    cp "$deploy_binary_path" "$deploy_binary_path.bak-$ts"
fi

install -m 755 "$deploy_remote_tmp_path" "$deploy_binary_path"
systemctl restart "$deploy_service"
systemctl is-active "$deploy_service"
systemctl --no-pager --full status "$deploy_service" | sed -n '1,12p'
curl --fail --silent --show-error "$deploy_service_health_url" >/dev/null
EOF

curl --fail --silent --show-error --location --head "$deploy_verify_url" >/dev/null
curl --fail --silent --show-error --location --head "$deploy_favicon_url" >/dev/null

echo "deployment complete"
