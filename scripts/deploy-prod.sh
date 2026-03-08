#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
commit="${1:-$(git -C "$repo_root" rev-parse HEAD)}"
deploy_target="${DEPLOY_TARGET:-root@100.109.217.118}"
deploy_service="${DEPLOY_SERVICE:-containr}"
deploy_binary_path="${DEPLOY_BINARY_PATH:-/usr/local/bin/containr}"
deploy_remote_tmp_path="${DEPLOY_REMOTE_TMP_PATH:-/root/containr.new}"
deploy_verify_url="${DEPLOY_VERIFY_URL:-https://adm.svk77.com/}"
deploy_favicon_url="${DEPLOY_FAVICON_URL:-https://adm.svk77.com/favicon.svg}"
worktree_dir="${DEPLOY_WORKTREE_DIR:-/tmp/containr-release}"
binary_path="$worktree_dir/target/release/containr"

cleanup() {
    if git -C "$repo_root" worktree list --porcelain | grep -Fq "worktree $worktree_dir"; then
        git -C "$repo_root" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
    fi

    if [ -d "$worktree_dir" ]; then
        rm -rf "$worktree_dir"
    fi
}

trap cleanup EXIT

git -C "$repo_root" rev-parse --verify "${commit}^{commit}" >/dev/null

if git -C "$repo_root" worktree list --porcelain | grep -Fq "worktree $worktree_dir"; then
    git -C "$repo_root" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
fi

if [ -e "$worktree_dir" ]; then
    rm -rf "$worktree_dir"
fi

echo "deploying commit $commit to $deploy_target"

git -C "$repo_root" worktree add --detach "$worktree_dir" "$commit" >/dev/null
mise trust "$worktree_dir/mise.toml" >/dev/null

(
    cd "$worktree_dir"
    mise install >/dev/null
    mise exec -- cargo build --release -p containr
)

scp "$binary_path" "$deploy_target:$deploy_remote_tmp_path"

ssh "$deploy_target" "
    set -euo pipefail
    ts=\$(date +%Y%m%d%H%M%S)
    if [ -f '$deploy_binary_path' ]; then
        cp '$deploy_binary_path' '$deploy_binary_path.bak-\$ts'
    fi
    install -m 755 '$deploy_remote_tmp_path' '$deploy_binary_path'
    systemctl restart '$deploy_service'
    systemctl is-active '$deploy_service'
    systemctl --no-pager --full status '$deploy_service' | sed -n '1,12p'
"

curl --fail --silent --show-error --location --head "$deploy_verify_url" >/dev/null
curl --fail --silent --show-error --location --head "$deploy_favicon_url" >/dev/null

echo "deployment complete"
