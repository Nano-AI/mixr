#!/usr/bin/env bash
# Restarts mixr when /health fails twice in a row: catches hangs that systemd's Restart=always can't see.
# A service that started less than 90s ago is left alone while it boots.
set -u
STATE="$HOME/mixr-data/.health-failures"
URL="http://127.0.0.1:${PORT:-8787}/health"

if curl -fsS --max-time 10 "$URL" >/dev/null 2>&1; then
  rm -f "$STATE"
  exit 0
fi

since_us=$(systemctl --user show mixr -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo 0)
uptime_s=$(cut -d. -f1 /proc/uptime)
if [ "${since_us:-0}" -gt 0 ] && [ $(( uptime_s - since_us / 1000000 )) -lt 90 ]; then
  exit 0
fi

fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
if [ "$fails" -ge 2 ]; then
  echo "mixr /health failed ${fails}x; restarting"
  rm -f "$STATE"
  systemctl --user reset-failed mixr 2>/dev/null || true
  systemctl --user restart mixr
fi
