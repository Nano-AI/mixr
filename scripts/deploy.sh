#!/usr/bin/env bash
# Deploy the monolith to polarcrest: pull the branch, install, build the dashboard, (re)install the systemd
# units, restart, and wait for /health. Secrets live in ~/mixr-data/mixr.env on the server (never in git).
#   scripts/deploy.sh                      # deploys origin/integration
#   DEPLOY_BRANCH=main scripts/deploy.sh   # another branch
set -euo pipefail
HOST="${DEPLOY_HOST:-jsomeara@polarcrest.johnomeara.com}"
BRANCH="${DEPLOY_BRANCH:-integration}"
REPO="${DEPLOY_REPO:-https://github.com/Nano-AI/mixr.git}"

ssh "$HOST" "BRANCH='$BRANCH' REPO='$REPO' bash -s" <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/opt/node24/bin:$PATH"
[ -d "$HOME/mixr/.git" ] || git clone -q "$REPO" "$HOME/mixr"
cd "$HOME/mixr"
git fetch -q origin "$BRANCH"
git checkout -q -B "$BRANCH" "origin/$BRANCH"
git reset -q --hard "origin/$BRANCH"
echo "deploying $(git log --oneline -1)"
npm ci --no-audit --no-fund --loglevel=error
(cd web && npm ci --no-audit --no-fund --loglevel=error && npx vite build --logLevel warn)
mkdir -p "$HOME/.config/systemd/user" "$HOME/mixr-data/backups"
cp deploy/mixr.service deploy/mixr-health.service deploy/mixr-health.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --quiet mixr mixr-health.timer
systemctl --user start mixr-health.timer
systemctl --user reset-failed mixr 2>/dev/null || true
systemctl --user restart mixr
for i in $(seq 1 45); do
  if curl -fsS --max-time 3 http://127.0.0.1:8787/health; then echo; echo "mixr is up"; exit 0; fi
  sleep 1
done
echo "mixr did not become healthy; last logs:"
journalctl --user -u mixr -n 60 --no-pager
exit 1
REMOTE
