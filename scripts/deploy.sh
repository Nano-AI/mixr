#!/usr/bin/env bash
# Deploy the monolith to polarcrest. The server has no git, so this downloads the branch as a tarball from
# GitHub into a fresh release folder, installs, builds the dashboard, switches ~/mixr to it (keeping the last
# 3 releases for instant rollback), (re)installs the systemd units, restarts, and waits for /health.
# Secrets live in ~/mixr-data/mixr.env on the server (never in git); data in ~/mixr-data/pglite.
#   scripts/deploy.sh                      # deploys main (production)
#   DEPLOY_BRANCH=integration scripts/deploy.sh   # another branch
#   scripts/deploy.sh --rollback           # switch back to the previous release
set -euo pipefail
HOST="${DEPLOY_HOST:-jsomeara@polarcrest.johnomeara.com}"
BRANCH="${DEPLOY_BRANCH:-main}"
REPO_SLUG="${DEPLOY_REPO:-Nano-AI/mixr}"
MODE="${1:-deploy}"

ssh "$HOST" "BRANCH='$BRANCH' REPO_SLUG='$REPO_SLUG' MODE='$MODE' bash -s" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/opt/node24/bin:$PATH"
RELEASES="$HOME/mixr-releases"
mkdir -p "$RELEASES" "$HOME/mixr-data/backups" "$HOME/.config/systemd/user"

if [ "$MODE" = "--rollback" ]; then
  current=$(readlink -f "$HOME/mixr")
  previous=$(ls -1d "$RELEASES"/*/ | sed 's:/$::' | grep -v "^$current$" | tail -1)
  [ -n "$previous" ] || { echo "no previous release"; exit 1; }
  ln -sfn "$previous" "$HOME/mixr"
  echo "rolled back to $(basename "$previous")"
else
  sha=$(curl -fsSL "https://api.github.com/repos/$REPO_SLUG/commits/$BRANCH" | sed -n 's/^  "sha": "\([0-9a-f]\{40\}\)".*/\1/p' | head -1)
  [ -n "$sha" ] || { echo "could not resolve $BRANCH"; exit 1; }
  dir="$RELEASES/$(date +%Y%m%d-%H%M%S)-${sha:0:7}"
  mkdir -p "$dir"
  curl -fsSL "https://codeload.github.com/$REPO_SLUG/tar.gz/$sha" | tar -xz -C "$dir" --strip-components=1
  echo "$sha" > "$dir/REVISION"
  echo "deploying $BRANCH @ ${sha:0:7}"
  (cd "$dir" && npm ci --no-audit --no-fund --loglevel=error)
  (cd "$dir/web" && npm ci --no-audit --no-fund --loglevel=error && npx vite build --logLevel warn)
  ln -sfn "$dir" "$HOME/mixr"
  # keep the 3 newest releases
  ls -1d "$RELEASES"/*/ | sed 's:/$::' | head -n -3 | xargs -r rm -rf
fi

cd "$HOME/mixr"
cp deploy/mixr.service deploy/mixr-health.service deploy/mixr-health.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --quiet mixr mixr-health.timer
systemctl --user start mixr-health.timer
systemctl --user reset-failed mixr 2>/dev/null || true
systemctl --user restart mixr
for i in $(seq 1 45); do
  if curl -fsS --max-time 3 http://127.0.0.1:8787/health; then echo; echo "mixr is up ($(cut -c1-7 REVISION 2>/dev/null))"; exit 0; fi
  sleep 1
done
echo "mixr did not become healthy; last logs:"
journalctl --user -u mixr -n 60 --no-pager
exit 1
REMOTE
