#!/usr/bin/env python3
"""Keep Supabase Auth's redirect allow-list in sync with the current quick-tunnel
URLs so OAuth / magic links work on the rotating tunnel domains.

Auth config (uri_allow_list) can only be changed through the Supabase Management
API, which needs a personal access token (sbp_...). Reads the token from
/root/.supabase-mgmt-token (root-only). Safe to run repeatedly (idempotent).
"""

import json
import sys
import urllib.error
import urllib.request

MGMT = "https://api.supabase.com/v1"
PROJECT = "dwstivxwyqdogzgxnidm"
TOKEN_FILE = "/root/.supabase-mgmt-token"
STATE_FILE = "/srv/zchat/state/quicktunnels.json"

BASE_ALLOW = [
    "https://z-chat.men",
    "https://z-chat.men/**",
    "https://www.z-chat.men",
    "https://www.z-chat.men/**",
    "https://*.z-chat.men/**",
    "https://present.z-chat.men/**",
    "https://game.z-chat.men/**",
    "https://access.z-chat.men/**",
    "capacitor://localhost",
    "capacitor://localhost/**",
    "https://localhost",
    "https://localhost/**",
]


def call(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        MGMT + path,
        method=method,
        data=data,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def main():
    try:
        token = open(TOKEN_FILE, encoding="utf-8").read().strip()
    except OSError:
        print("[redirects] no management token at", TOKEN_FILE, file=sys.stderr)
        return 0
    if not token:
        print("[redirects] empty management token", file=sys.stderr)
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

    path = f"/projects/{PROJECT}/config/auth"
    try:
        current = call("GET", path, token)
    except urllib.error.HTTPError as error:
        print("[redirects] GET config/auth failed:", error.code, error.read()[:200], file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001
        print("[redirects] GET config/auth failed:", error, file=sys.stderr)
        return 1

    existing = [entry.strip() for entry in str(current.get("uri_allow_list") or "").split(",") if entry.strip()]
    merged = set(existing) | set(BASE_ALLOW)
    for url in quick:
        merged.add(url)
        merged.add(url + "/**")

    allow_list = ",".join(sorted(merged))
    try:
        call("PATCH", path, token, {"uri_allow_list": allow_list})
    except urllib.error.HTTPError as error:
        print("[redirects] PATCH config/auth failed:", error.code, error.read()[:200], file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001
        print("[redirects] PATCH config/auth failed:", error, file=sys.stderr)
        return 1

    print(f"[redirects] allow-list now has {len(merged)} entries; quick tunnels: {quick}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
