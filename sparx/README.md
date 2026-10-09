# zsparx - personal Sparx Maths API

A small HTTP API around Sparx Maths for Charles (NAS Dubai). It logs in
through the school's Microsoft SSO using a persistent headless Chrome
profile, replays the web app's own authenticated gRPC-web calls, and
decodes the protobuf responses into JSON-ish trees (strings, varints,
doubles; unknown bytes fall back to hex).

## Endpoints

All requests need `x-zsparx-token: <token>` (see below), except a plain
`GET /health` which only reports that the service is up.

| Endpoint          | What it returns                                            |
| ----------------- | ---------------------------------------------------------- |
| `GET /health`     | service + auth marker                                     |
| `GET /session`    | school / session JSON (`students/...`, `schools/...`)     |
| `GET /xp`         | `{ "xp": 45343, "state": ... }`                           |
| `GET /userinfo`   | name, surname, email, school                              |
| `GET /homework`   | homework packages (titles, due dates, tracked components) |
| `GET /notifications` | notifications list                                    |
| `GET /raw?p=/rpc/path[&b=<base64 proto body>]` | any gRPC-web call    |
| `POST /login`     | force a fresh Microsoft login                             |

Public URL: `https://z-chat.men/sparx/<endpoint>` (Cloudflare tunnel path
rule -> `http://localhost:8823`, added as ingress path rule).

Example:

```bash
curl -H "x-zsparx-token: $TOKEN" https://z-chat.men/sparx/homework
```

## Box layout

- `/srv/zsparx/zsparx.py` - the service (runs as `zchat`)
- `/srv/zsparx/creds.json` - `{"email": "...", "password": "..."}` (600, **not in git**)
- `/srv/zsparx/profile/` - persistent Chrome profile (keeps the Sparx/MS session)
- `/srv/zsparx/state/api-token.txt` - API token (600, generated on first run)
- `/etc/systemd/system/zsparx.service` - unit (venv: `/srv/zgames/.venv`)

Chrome for Testing lives in `/srv/zsparx/.cache/selenium` (HOME of the unit).

## Auth flow (how it works)

1. `GET https://api.sparx-learning.com/session` with cookie -> student subject.
2. `GET https://api.sparx-learning.com/token` -> `bearer eyJ...` (JWT).
3. `POST https://api.sparx-learning.com/<rpc>` with
   `content-type: application/grpc-web+proto`, `x-grpc-web: 1`,
   `authorization: bearer ...`, body = 5-byte framed protobuf.
4. Response is gRPC-web framed; trailing `grpc-status` is checked.

The Microsoft login runs only when the profile is logged out:
school selector -> "Log in to Sparx using Microsoft" -> email -> password
-> "Stay signed in? Yes". If the account picker appears, "Use another
account" is clicked. If the school ever enforces MFA this will need a
manual one-off login.
