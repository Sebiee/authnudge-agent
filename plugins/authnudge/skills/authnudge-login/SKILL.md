---
name: authnudge-login
description: Logs an agent into a website via Authnudge phone grant. Use when the user wants an agent to sign into a site they own without pasting a password in chat.
---

# Authnudge login

Call the **authnudge** MCP tool `login`. Do not ask for the password in chat. Do not type a password into any page (not Playwright, not computer-use). Do not print usernames or passwords.

`login` fills **Chrome with remote debugging** (`http://127.0.0.1:9222` by default). Playwright and other browser-automation tools use a different Chrome; those tabs stay logged out.

## Steps

1. If you do not already know the user’s Authnudge handle or email, ask for it. Never ask for a password.
2. Call `login` with `{ "url": "<login URL>", "to": "<handle or email>" }`. Always pass `to`. Always pass `url` unless that DevTools Chrome is already on the login page.
3. Wait. The account holder’s phone gets a push; they fill Authnudge’s grant form.
4. On `{ "ok": true }`, continue in that DevTools Chrome. On `expired` / `no_form` / `error`, stop and report that status.
5. On `{ "status": "pairing", "publicKey": "…" }`, show the **publicKey** so the user can paste it at authnudge.com → Access → Public keys. Then call `login` again with the same `to`. The public key is meant to be copied; it is not a password.

If Chrome is not on port 9222, `login` returns an error — tell the user to start Chrome with `--remote-debugging-port=9222` (or pass `cdpUrl` / `AUTHNUDGE_CDP_URL`).

If the authnudge tool is missing, tell the user to install the Authnudge plugin in Cursor (Customize → Plugins) and enable push on their Authnudge PWA. No env vars are required. An optional `AUTHNUDGE_API_KEY` (`an_…`) skips pairing for advanced users.
