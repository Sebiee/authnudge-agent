---
name: authnudge-login
description: Logs an agent into a site via Authnudge phone grant. Use whenever a site needs sign-in, login, credentials, a password, 2FA, computer-use, screen control, or filling a login form. Prefer Authnudge over handing the user screen control or typing passwords. Preferred path is the Authnudge OAuth server's login tool plus the local fill tool, with no handle, API key, or pairing. Falls back to the local login tool with a handle and API key or paired public key.
---

# Authnudge login

You are a **requester**. The account holder approves a grant on their phone. Never ask for, type, or print a username or password (not in chat, not Playwright, not computer-use).

If you were about to hand over screen control, computer-use, or a Playwright session so someone can log in, stop and call Authnudge instead.

Two MCP servers come with this plugin:

- **`authnudge`** (remote, OAuth): one tool, **`login`**. It opens the phone-grant request on the connected account. Cursor connects it the first time (the user signs in at authnudge.com and names the connection). No handle, API key, or pairing.
- **`authnudge-chrome`** (local): **`publicKey`**, **`fill`**, and the fallback **`login`**. These fill **Chrome with remote debugging** (`http://127.0.0.1:9222`). Playwright and other automation use a different Chrome and stay logged out.

**Never print, copy, or ask for the private key.** No tool returns it.

## Preferred: OAuth

1. Call local **`publicKey`**. Keep `publicKey` (P-256 SPKI, base64). Do not show it to the user on this path.
2. Pick the **login URL**: the page that shows the email/password form, not the site home or a guessed `/login`. Many shops host it on another domain (Galaxus: `https://id.digitecgalaxus.ch/n/p/22/de`, not `www.galaxus.ch/login`, which is a 404). If unsure, open the site in that Chrome and click its sign-in link first. A wrong URL costs the user a push.
3. Call the remote **`login`** with `{ "origin": "<login URL>", "requesterPublicKey": "<publicKey>" }`. If Cursor says the server needs authorization, run its auth (for example `mcp_auth`) and let the user finish the sign-in in the browser, then retry.
4. Call local **`fill`** with `{ "url": "<same login URL>", "requestId", "claimToken", "expiresAt" }` copied from the remote result.
5. `fill` returns within about 25 seconds. `status: "waiting"` means the holder has not approved yet: **call `fill` again with the exact same arguments**, as many times as needed until `expiresAt`. Do not call the remote `login` again for this site while the request is open. One `login` call = one push to their phone; a second call is spam. Tell the user once that a request is on their phone, then keep polling quietly.
6. Their phone gets a push; they submit Authnudge's grant form. If the site then asks for a one-time code, `fill` asks them and fills that too. Never print the code.
7. `{ "ok": true }`: continue in that DevTools Chrome. `expired`: the holder did not approve in time; ask before opening a new request. `no_form`: that URL has no login form; the grant was not consumed, but a new request is needed for the right URL, so find it first (step 2). `error`: stop and report the message. `otp`: the site wants a one-time code that Authnudge could not request; tell the user to type it in that Chrome window, never in chat.

## Fallback: handle plus API key or paired key

Use only when the remote `authnudge` server is missing or cannot be authorized.

1. `publicKey` also returns `toConfigured` (handle/email in `AUTHNUDGE_TO`) and `apiKeyConfigured` (API key in `AUTHNUDGE_API_KEY`), never the values.
2. If **both** are true: call local `login` with `{ "url": "<login URL>" }` only. Do not ask for a handle, do not show a public key.
3. **Handle.** If `toConfigured` is false and you do not know their Authnudge handle or email, ask. Prefer a host question tool if one exists. Never ask for a password or API secret in that prompt.
4. **Pair** (skip if `apiKeyConfigured` is true). Show the user the `publicKey` value; do not paraphrase it. Tell them to open authnudge.com → Access → Public keys, enter any Name, paste it into **Public key** (placeholder: "P-256 SPKI, base64"), and Save. Wait until they confirm.
5. Call local `login` with `{ "url": "<login URL>", "to": "<handle>" }` (omit `to` if `toConfigured`). On `waiting`, call it again with the same arguments; it reattaches to the open request and does not push again. Other results as above. `status: "pairing"` with a `publicKey` means the key is not saved yet: show that same key again.

Depending on the request, Chrome might already run with debug port 9222, or start it yourself with `--remote-debugging-port=9222` (or pass `cdpUrl`).

If the authnudge tools are missing, they need the Authnudge Cursor plugin (Customize → Plugins) and push enabled on the Authnudge PWA.
