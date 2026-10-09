#!/usr/bin/env bash
# Daily rotation for the Z Chat quick-tunnel URLs (real trycloudflare tunnels).
# Restarts each enabled site's tunnel one at a time (serialised to avoid the
# Cloudflare quick-tunnel creation rate limit), then re-syncs the Supabase
# redirect allow-list so the new URLs work for auth.
set -u
STATE=/srv/zchat/state/quicktunnels.json
STATE_TOOL=/srv/zchat/quicktunnels/state_tool.py

enabled_for() { python3 -c "import json; print('1' if json.load(open('$STATE'))['$1']['enabled'] else '')" 2>/dev/null || true; }
url_for() { python3 -c "import json; print(json.load(open('$STATE'))['$1'].get('url',''))" 2>/dev/null || true; }

for site in zchat games slides; do
  [ "$(enabled_for "$site")" = "1" ] || continue
  before="$(url_for "$site")"
  echo "[rotate] restarting $site (current: ${before:-none})"
  systemctl restart "zchat-quicktunnel@$site.service"
  for _ in $(seq 1 30); do
    sleep 2
    now="$(url_for "$site")"
    if [ -n "$now" ] && [ "$now" != "$before" ]; then
      echo "[rotate] $site -> $now"
      break
    fi
  done
  sleep 5
done

python3 /srv/zchat/quicktunnels/supabase-redirects.py || true
echo "[rotate] done"
