#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
commit="${1:-$(git -C "$repo_root" rev-parse HEAD)}"
git_remote="${DEPLOY_GIT_REMOTE:-origin}"
git_branch="${DEPLOY_GIT_BRANCH:-main}"

git -C "$repo_root" rev-parse --verify "${commit}^{commit}" >/dev/null

echo "pushing commit $commit to $git_remote/$git_branch"
git -C "$repo_root" push "$git_remote" "$commit:refs/heads/$git_branch"

"$repo_root/scripts/deploy-prod.sh" "$commit"
