#!/usr/bin/env bash
# mixr releases on polarcrest (no git, no sudo, no Docker). One script for hand and automatic deploys:
#   release.sh deploy [branch]   ship the branch's newest commit (default main); a no-op if it's already live
#   release.sh rollback          switch back to the previous release
# By hand: scripts/deploy.sh (on a laptop) copies this file to ~/mixr-data/release.sh and runs it over ssh.
# Automatic: mixr-autodeploy.timer runs ~/mixr-data/release.sh deploy main every 2 minutes (MIXR_AUTODEPLOY=1),
# and every successful deploy refreshes ~/mixr-data/release.sh from the new release, so script changes ship too.
#
# A deploy: resolve the commit (GitHub API, no git) -> download its tarball into a staging dir -> npm ci ->
# gates: tests (offline fakes, in-memory DB), tsc, dashboard build -> only then move it into ~/mixr-releases,
# point ~/mixr at it, install the systemd units, restart, and wait for /health. Unhealthy: back to the previous
# release. A release that fails a gate is deleted and never goes live. ~/mixr-data is never touched.
#
# Auto-deploy never retries a commit that failed, and it stands down after a rollback or a hand deploy of another
# branch: ~/mixr-data/autodeploy.hold names a commit on main to skip, and the next commit on main deploys as usual.
# `touch ~/mixr-data/autodeploy.paused` stops auto-deploys entirely (rm it to resume). FORCE=1 redeploys even if
# the commit is already live. One line per outcome goes to ~/mixr-data/deploys.log.
set -euo pipefail
export LC_ALL=C
export PATH="$HOME/.local/opt/node24/bin:$PATH"

REPO_SLUG="${REPO_SLUG:-Nano-AI/mixr}"
APP="$HOME/mixr"                      # symlink to the live release
RELEASES="$HOME/mixr-releases"
DATA="$HOME/mixr-data"
UNIT_DIR="$HOME/.config/systemd/user"
LOCK="$DATA/.deploy.lock"
HOLD="$DATA/autodeploy.hold"
PAUSED="$DATA/autodeploy.paused"
HISTORY="$DATA/deploys.log"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/health}"
AUTO_BRANCH=main
HEALTH_WAIT=45      # tune: seconds a restarted release has to answer /health
KEEP=3              # tune: releases kept for rollback
TEST_TIMEOUT=15m    # tune: a hung test run fails the gate instead of holding the deploy lock forever
TEST_MEMORY=3G      # tune: memory cap for the test run (the live server keeps running next to it)

AUTO=0; [ "${MIXR_AUTODEPLOY:-0}" = 1 ] && AUTO=1
FORCE=0; [ "${FORCE:-0}" = 1 ] && FORCE=1
WHO=manual; [ "$AUTO" = 1 ] && WHO=auto
STAGE=""
trap 'if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi' EXIT

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
loud() {
  {
    echo '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
    log "!!! $*"
    echo '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!'
  } >&2
}
die() { log "error: $*" >&2; exit 1; }
record() { log "$* ($WHO)" >>"$HISTORY"; }

# "main@abc1234 (20261017-183000-abc1234)" for a release dir, "none" when there isn't one.
describe() {
  if [ -z "$1" ] || [ ! -d "$1" ]; then echo none; return 0; fi
  echo "$(cat "$1/BRANCH" 2>/dev/null || echo '?')@$(cut -c1-7 "$1/REVISION" 2>/dev/null || echo '?') ($(basename "$1"))"
}

# Release dirs, oldest first (names start with a timestamp). Staging dirs (.incoming-*) aren't listed.
releases() {
  local d
  for d in "$RELEASES"/*/; do
    if [ -d "$d" ]; then printf '%s\n' "${d%/}"; fi
  done
  return 0
}

lock() {
  exec 9>>"$LOCK"
  if ! flock -n 9; then
    if [ "$AUTO" = 1 ]; then log "another deploy is running; skipping this check"; exit 0; fi
    log "waiting for the deploy that's already running..."
    flock -w 1800 9 || die "gave up waiting for $LOCK"
  fi
  rm -rf "$RELEASES"/.incoming-*   # left behind by a run that was killed mid-build
}

# Prints the 40-char sha at the head of branch $1.
resolve() {
  local out
  if ! out=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/$REPO_SLUG/commits/$1" 2>&1); then
    log "GitHub API: could not resolve $1: ${out:0:200}" >&2
    return 1
  fi
  if [[ ! "$out" =~ ^[0-9a-f]{40}$ ]]; then
    log "GitHub API: unexpected answer for $1: ${out:0:200}" >&2
    return 1
  fi
  printf '%s\n' "$out"
}

held_sha() {
  local sha=""
  if [ -f "$HOLD" ]; then read -r sha _ <"$HOLD" || true; fi
  printf '%s\n' "$sha"
}

hold() {
  printf '%s %s\n' "$1" "$2" >"$HOLD"
  log "auto-deploy will skip $AUTO_BRANCH@${1:0:7} ($2); the next commit on $AUTO_BRANCH deploys as usual"
}

switch_to() {
  ln -sfn "$1" "$APP.next"
  mv -Tf "$APP.next" "$APP"
}

install_units() {
  cp "$APP"/deploy/*.service "$APP"/deploy/*.timer "$UNIT_DIR"/
  systemctl --user daemon-reload
  local timers=(mixr-health.timer)
  # Releases from before auto-deploy existed don't ship its units; keep whatever is installed.
  if [ -f "$UNIT_DIR/mixr-autodeploy.timer" ]; then timers+=(mixr-autodeploy.timer); fi
  systemctl --user enable --quiet mixr "${timers[@]}"
  systemctl --user start "${timers[@]}"
}

# Restart on whatever ~/mixr points at and wait for /health. Returns 1 if it never answers.
restart_and_check() {
  install_units
  systemctl --user reset-failed mixr 2>/dev/null || true
  systemctl --user restart mixr
  local deadline=$((SECONDS + HEALTH_WAIT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS --max-time 3 -o /dev/null "$HEALTH_URL" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

show_logs() {
  echo "--- last mixr logs ---" >&2
  journalctl --user -u mixr -n 60 --no-pager >&2 2>&1 || true
}

# Keep ~/mixr-data/release.sh (what the timer runs) the same as the live release's copy.
sync_self() {
  local src="$APP/deploy/release.sh" dst="$DATA/release.sh"
  if [ ! -f "$src" ] || cmp -s "$src" "$dst"; then return 0; fi
  if ! bash -n "$src"; then log "not updating $dst: the live release's copy has a syntax error"; return 0; fi
  install -m 755 "$src" "$dst.next"
  mv -f "$dst.next" "$dst"
  log "updated $dst from the live release"
}

prune() {
  local live d
  live=$(readlink -e "$APP" || true)
  releases | head -n -"$KEEP" | while read -r d; do
    if [ "$d" != "$live" ]; then rm -rf "$d"; fi
  done
}

# --- deploy gates (run inside the staging dir) ---

npm_install() {
  npm ci --include=dev --no-audit --no-fund --loglevel=error && return 0
  log "npm ci failed; retrying once in 10s"
  sleep 10
  npm ci --include=dev --no-audit --no-fund --loglevel=error
}

run_tests() {
  local cap=()
  if command -v systemd-run >/dev/null &&
    systemd-run --user --scope -q -p MemoryMax="$TEST_MEMORY" -p MemorySwapMax=0 true 2>/dev/null; then
    cap=(systemd-run --user --scope -q -p MemoryMax="$TEST_MEMORY" -p MemorySwapMax=0 --)
  fi
  # Tests run offline (vitest.config.ts: MIXR_FAKE=1, in-memory DB) and never see a real key.
  env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u PROJECT_ID -u PROJECT_SECRET -u GMAIL_APP_PASSWORD \
    -u RESEND_API_KEY -u ADMIN_TOKEN MIXR_FAKE=1 \
    "${cap[@]}" timeout -k 30s "$TEST_TIMEOUT" npx vitest run
}

build_web() {
  cd web &&
    npm ci --include=dev --no-audit --no-fund --loglevel=error &&
    npx vite build --logLevel warn
}

# gate <label> <command...>: on failure the release is thrown away and the live one keeps running.
gate() {
  local label=$1
  shift
  log "gate: $label"
  if (cd "$STAGE" && "$@"); then return 0; fi
  loud "$label FAILED for $BRANCH@${SHA:0:7}; not deploying it. Still live: $(describe "$PREVIOUS")"
  record "FAILED $label: $BRANCH@${SHA:0:7}"
  if [ "$BRANCH" = "$AUTO_BRANCH" ]; then hold "$SHA" "$label failed"; fi
  exit 1
}

deploy() {
  BRANCH=$1
  [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "bad branch name: $BRANCH"
  lock
  if [ "$AUTO" = 1 ] && [ -e "$PAUSED" ]; then log "auto-deploy is paused ($PAUSED exists)"; exit 0; fi

  if ! SHA=$(resolve "$BRANCH"); then
    if [ "$AUTO" = 1 ]; then exit 0; fi # rate limit or a network blip: the next check tries again
    die "could not resolve $BRANCH"
  fi
  PREVIOUS=$(readlink -e "$APP" || true)
  local live
  live=$(cat "$PREVIOUS/REVISION" 2>/dev/null || true)
  if [ "$FORCE" != 1 ]; then
    if [ "$SHA" = "$live" ]; then
      if [ "$AUTO" != 1 ]; then log "$BRANCH@${SHA:0:7} is already live (FORCE=1 rebuilds it)"; fi
      sync_self
      exit 0
    fi
    if [ "$AUTO" = 1 ] && [ "$SHA" = "$(held_sha)" ]; then
      log "skipping $BRANCH@${SHA:0:7}: $(cut -d' ' -f2- "$HOLD"). Waiting for a new commit (or FORCE=1 scripts/deploy.sh)"
      exit 0
    fi
  fi

  local name dir
  name="$(date +%Y%m%d-%H%M%S)-${SHA:0:7}"
  dir="$RELEASES/$name"
  STAGE="$RELEASES/.incoming-$name"
  mkdir -p "$STAGE"
  log "deploying $BRANCH@${SHA:0:7} ($WHO). Live now: $(describe "$PREVIOUS")"
  if ! curl -fsSL --max-time 300 "https://codeload.github.com/$REPO_SLUG/tar.gz/$SHA" |
    tar -xz -C "$STAGE" --strip-components=1; then
    log "download of $BRANCH@${SHA:0:7} failed"
    if [ "$AUTO" = 1 ]; then exit 0; fi # network: the next check tries again
    exit 1
  fi
  echo "$SHA" >"$STAGE/REVISION"
  echo "$BRANCH" >"$STAGE/BRANCH"

  gate "npm ci" npm_install
  gate "tests" run_tests
  gate "typecheck" npx tsc --noEmit
  gate "dashboard build" build_web

  mv "$STAGE" "$dir"
  STAGE=""
  switch_to "$dir"
  if restart_and_check; then
    log "mixr is up: $(describe "$dir")"
    record "deployed $BRANCH@${SHA:0:7} $name"
    if [ "$BRANCH" = "$AUTO_BRANCH" ]; then
      rm -f "$HOLD"
    else
      # A hand deploy of another branch stays up until main gets a new commit.
      local main_head
      main_head=$(resolve "$AUTO_BRANCH" || echo "$live")
      if [ -n "$main_head" ]; then hold "$main_head" "hand deploy of $BRANCH"; fi
    fi
    sync_self
    prune
    exit 0
  fi

  loud "$BRANCH@${SHA:0:7} did not answer $HEALTH_URL within ${HEALTH_WAIT}s; going back to $(describe "$PREVIOUS")"
  show_logs
  record "FAILED health check: $BRANCH@${SHA:0:7}; reverted"
  if [ "$BRANCH" = "$AUTO_BRANCH" ]; then hold "$SHA" "failed its health check"; fi
  if [ -z "$PREVIOUS" ]; then
    loud "there is no previous release to go back to; leaving $name in place"
    exit 1
  fi
  switch_to "$PREVIOUS"
  if restart_and_check; then
    log "back on $(describe "$PREVIOUS")"
  else
    loud "the previous release is not answering /health either"
    show_logs
  fi
  rm -rf "$dir"
  exit 1
}

rollback() {
  lock
  [ -L "$APP" ] || die "$APP is not a release symlink"
  local current target="" d
  current=$(readlink -e "$APP") || die "$APP points nowhere"
  for d in $(releases); do
    if [[ "$(basename "$d")" < "$(basename "$current")" ]]; then target=$d; fi
  done
  [ -n "$target" ] || die "no release older than $(basename "$current") to roll back to"

  log "rolling back: $(describe "$current") -> $(describe "$target")"
  switch_to "$target"
  if restart_and_check; then
    log "mixr is up: $(describe "$target")"
    record "rolled back to $(basename "$target") from $(basename "$current")"
    local main_head
    main_head=$(resolve "$AUTO_BRANCH" || cat "$current/REVISION" 2>/dev/null || true)
    if [ -n "$main_head" ]; then hold "$main_head" "rolled back from $(basename "$current")"; fi
    exit 0
  fi

  loud "$(basename "$target") did not answer /health; returning to $(describe "$current")"
  show_logs
  record "FAILED rollback to $(basename "$target"); stayed on $(basename "$current")"
  switch_to "$current"
  if ! restart_and_check; then
    loud "$(basename "$current") is not answering /health either"
    show_logs
  fi
  exit 1
}

mkdir -p "$RELEASES" "$DATA/backups" "$UNIT_DIR"
case "${1:-}" in
  deploy) deploy "${2:-$AUTO_BRANCH}" ;;
  rollback) rollback ;;
  *)
    echo "usage: release.sh deploy [branch] | release.sh rollback" >&2
    exit 2
    ;;
esac
