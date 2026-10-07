# Z Services

Monorepo for the Z Chat service family (all private).

| Service | Folder | Port | Hostname | Notes |
| ------- | ------ | ---- | -------- | ----- |
| Z Slides — AI presentation maker | `slides/` | 9861 | https://present.z-chat.men | OAuth-gated via Z Chat consent, DeepSeek generation, 3 free decks per account, 6 pages max, $5/month AI budget cap |

## Deploy

Everything runs on the black box (10.10.0.13):

- `slides/` → `/srv/zslides` (systemd unit `zslides.service`, starts on boot)
- Secrets live in `/srv/zslides/env` (not in the repo)
- Public access via the z-chat Cloudflare tunnel (same docker token as the main site)

## Auth

Z services use the custom Z Chat OAuth: the app redirects to
`https://z-chat.men/oauth/consent`, the consent page posts the user's Z Chat
access token to the app's own `/api/oauth/approve` endpoint (passed via the
`approve_url` parameter), and the app verifies the token + ban status against
Supabase before minting its own short-lived signed auth code (PKCE-bound).

## Auto-push (Windows)

`tools/autopush-windows.ps1` runs at logon and commits+pushes edits in the Z repos automatically (~40s debounce). Installed to `%USERPROFILE%\\.z-autopush` + Startup folder. Disable by removing `Startup\\ZAutoPush.cmd`.
