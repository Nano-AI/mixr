#!/usr/bin/env bash
# Deploy mixr to polarcrest by hand. main also ships itself: mixr-autodeploy.timer on the server deploys each new
# commit on main within ~2 minutes once its tests pass. Use this for rollbacks, other branches, and the first
# install. The release logic is deploy/release.sh: this copies YOUR copy of it to ~/mixr-data/release.sh on the
# server (which the timer also runs) and runs it there, so it works even if the live release predates it.
#   scripts/deploy.sh                 # deploy main now (a no-op if it's already live)
#   scripts/deploy.sh integration     # another branch; auto-deploy leaves it up until main gets a new commit
#   FORCE=1 scripts/deploy.sh         # rebuild and redeploy even if that commit is already live
#   scripts/deploy.sh --rollback      # back to the previous release; auto-deploy waits for a new commit on main
# Env: DEPLOY_HOST (required, user@host of the server), DEPLOY_BRANCH (default main), DEPLOY_REPO.
set -euo pipefail
HOST="${DEPLOY_HOST:?set DEPLOY_HOST=user@host of the server}"
REPO_SLUG="${DEPLOY_REPO:-Nano-AI/mixr}"
FORCE=$([ "${FORCE:-0}" = 1 ] && echo 1 || echo 0)
cd "$(dirname "$0")/.."

case "${1:-}" in
  --rollback | rollback) cmd=rollback ;;
  -h | --help)
    sed -n '2,10p' "$0"
    exit 0
    ;;
  -*)
    echo "unknown option: $1 (see --help)" >&2
    exit 2
    ;;
  *)
    branch="${1:-${DEPLOY_BRANCH:-main}}"
    [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "bad branch name: $branch" >&2; exit 2; }
    cmd="deploy $branch"
    ;;
esac
[[ "$REPO_SLUG" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || { echo "bad DEPLOY_REPO: $REPO_SLUG" >&2; exit 2; }
bash -n deploy/release.sh

# Upload under a temporary name and rename: a deploy the timer is running keeps reading the old file.
scp -q deploy/release.sh "$HOST:mixr-data/release.sh.new"
ssh "$HOST" "chmod 755 mixr-data/release.sh.new && mv -f mixr-data/release.sh.new mixr-data/release.sh &&
  FORCE=$FORCE REPO_SLUG=$REPO_SLUG bash mixr-data/release.sh $cmd"
