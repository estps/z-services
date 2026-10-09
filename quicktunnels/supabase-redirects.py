#!/usr/bin/env python3
"""Keep Supabase Auth's redirect allow-list in sync with the current quick-tunnel
URLs, so OAuth / magic links work on the rotating tunnel domains.

Reads:
  /root/.supabase-secret   - the project secret key (sb_secret_...), root-only
  /srv/zchat/state/quicktunnels.json - zchat/games/slides current URLs

Writes the merged allow-list back via GoTrue's admin settings endpoint, which
needs the secret key. Safe to run repeatedly (idempotent merge).
"""

import json
import sys
import urllib.request

SUPA_URL = "https://dwstivxwyqdogzgxnidm.supabase.co"
KEY_FILE = "/root/.supabase-secret"
STATE_FILE = "/srv/zchat/state/quicktunnels.json"

# Patterns that should always be allowed, independent of tunnels.
BASE_ALLOW = [
    "https://z-chat.men",
    "https://z-chat.men/**",
    "https://www.z-chat.men",
    "https://www.z-chat.men/**",
    "https://*.z-chat.men/**",
    "https://present.z-chat.men/**",
    "https://game.z-chat.men/**",
    "https://access.z-chat.men/**",
    # Capacitor native shells
    "capacitor://localhost",
    "capacitor://localhost/**",
    "https://localhost",
    "https://localhost/**",
]


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        SUPA_URL + path,
        method=method,
        data=data,
        headers={
            "apikey": KEY,
            "Authorization": "Bearer " + KEY,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def main():
    global KEY
    try:
        KEY = open(KEY_FILE, encoding="utf-8").read().strip()
    except OSError:
        print("[redirects] no secret key at", KEY_FILE, file=sys.stderr)
        return 0
    if not KEY:
        print("[redirects] empty secret key", file=sys.stderr)
        return 0

    quick = []
    try:
        state = json.load(open(STATE_FILE, encoding="utf-8"))
        for site in ("zchat", "games", "slides"):
            url = ((state.get(site) or {}).get("url") or "").rstrip("/")
            if url.startswith("https://"):
                quick.append(url)
    except Exception as error:  # noqa: BLE001
        print("[redirects] could not read state:", error, file=sys.stderr)

    try:
        current = call("GET", "/auth/v1/settings")
    except Exception as error:  # noqa: BLE001
        print("[redirects] GET settings failed:", error, file=sys.stderr)
        return 1

    existing = [entry.strip() for entry in str(current.get("uri_allow_list") or "").split(",") if entry.strip()]
    merged = set(existing) | set(BASE_ALLOW)
    for url in quick:
        merged.add(url)
        merged.add(url + "/**")
        merged.add(url + "/*")

    allow_list = ",".join(sorted(merged))
    try:
        call("PUT", "/auth/v1/settings", {"uri_allow_list": allow_list})
    except Exception as error:  # noqa: BLE001
        print("[redirects] PUT settings failed:", error, file=sys.stderr)
        return 1

    print(f"[redirects] allow-list now has {len(merged)} entries; quick tunnels: {quick}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
