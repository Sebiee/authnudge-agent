---
name: authnudge-login
description: Logs an agent into a site via Authnudge phone grant. Use whenever a site needs sign-in, login, credentials, a password, or a 2FA code, in any browser you drive (computer-use, Playwright, DevTools). Authnudge replaces only the credential-entry step; never type a password or hand the user the screen for it. Preferred path is the Authnudge OAuth server's login tool plus the local fill tool, with no handle, API key, or pairing. Falls back to the local login tool with a handle and API key or paired public key.
---

# Authnudge login

You are a **requester**. The account holder approves a grant on their phone. Authnudge fills the login form for you. Never ask for, type, or print a username, password, or code (not in chat, not Playwright, not computer-use).

Browsing yourself is fine: open the site, click its sign-in link, keep working after login with computer-use or Playwright. Only the credential-entry step goes through Authnudge. If you were about to type a password or hand the screen to the user for that step, call Authnudge instead.

Two MCP servers come with this plugin:

- **`authnudge`** (remote, OAuth): one tool, **`login`**. It opens the phone-grant request on the connected account. Cursor connects it the first time (the user signs in at authnudge.com and names the connection). No handle, API key, or pairing.
- **`authnudge-chrome`** (local): **`publicKey`**, **`fill`**, and the fallback **`login`**. These type into **the Chrome you point them at** over DevTools: default `http://127.0.0.1:9222`, or `cdpUrl`.

## One browser

`fill` can only type into a Chrome that exposes a DevTools port. Make that the browser you work in, so the session lands where you need it:

- **Find your Chrome's DevTools address before the first `login`.** It is the `--remote-debugging-port` your Chrome was started with (check its command line or `curl http://127.0.0.1:<port>/json/version`). On a shared machine every agent's Chrome has its own port; the default `9222` may be someone else's browser. Pass yours as `cdpUrl` on every `fill` and `login`.
- Computer-use or a Chrome you start yourself: start it with `--remote-debugging-port=<port>` (add `--user-data-dir` if you want a separate profile). Then drive it with computer-use as usual.
- Playwright: launch Chromium with the arg `--remote-debugging-port=<port>`, or connect Playwright over CDP to a Chrome you started that way.
- Do **not** start a second, hidden "Authnudge Chrome" next to the one you use. A login in a browser you never look at is worthless, and your own browser stays logged out.
- Every result echoes `cdpUrl`. If it is not your browser, call `fill` again with the same request and the right `cdpUrl`: the wrong attempt is stopped and the same grant is filled in the right browser. No new `login`, no new push.
- `fill` opens the login URL in a new tab unless a tab is already on that site, so your current tab is left alone.

**Never print, copy, or ask for the private key.** No tool returns it.

## Preferred: OAuth

1. Call local **`publicKey`**. Keep `publicKey` (P-256 SPKI, base64). Do not show it to the user on this path.
2. Pick the **login URL**: the page that shows the email/password form, not the site home or a guessed `/login`. Many shops host it on another domain (Galaxus: `https://id.digitecgalaxus.ch/n/p/22/de`, not `www.galaxus.ch/login`, which is a 404). If unsure, open the site in that Chrome and click its sign-in link first. A wrong URL costs the user a push.
3. Call the remote **`login`** with `{ "origin": "<login URL>", "requesterPublicKey": "<publicKey>" }`. If Cursor says the server needs authorization, run its auth (for example `mcp_auth`) and let the user finish the sign-in in the browser, then retry.
4. Call local **`fill`** with `{ "url": "<same login URL>", "requestId", "claimToken", "expiresAt" }` copied from the remote result.
5. `fill` returns within about 25 seconds. `status: "waiting"` means the holder has not approved yet, or the site asked for a one-time code and the holder is entering it on their phone: **call `fill` again with the exact same arguments**, as many times as needed until `expiresAt`. The code step is handled inside the same `fill` job; you never see the code. Do not call the remote `login` again for this site while the request is open. One `login` call = one push to their phone; a second call is spam. The `claimToken` is valid until `expiresAt`; there is nothing to "refresh". Tell the user once that a request is on their phone, then keep polling quietly, and report the final result as soon as it arrives. Do not run other login checks (computer-use, screenshots) in parallel; they only add noise.
6. Their phone gets a push; they submit Authnudge's grant form. If the site then asks for a one-time code, `fill` asks them and fills that too. Never print the code.
7. `{ "ok": true }`: the session is in that Chrome profile; keep working there. `expired`: the holder did not approve in time; ask before opening a new request. `no_form`: that URL has no login form; the grant was not consumed, but a new request is needed for the right URL, so find it first (step 2). `fulfilled`: this request was already used; look at the tab, it is probably signed in. `error`: stop and report the message; if the holder had already sent the password and wants a retry, one new remote `login` closes that request and pushes once more. `otp`: the site wants a one-time code that Authnudge could not request; tell the user to type it in that Chrome window, never in chat.
8. If the tool call itself errors or times out (host-side timeout, MCP error), look at the tab before anything else. Signed in: done. Not signed in: call `fill` again with the same arguments. Do not open a new request; that pushes their phone again.

## Fallback: handle plus API key or paired key

Use only when the remote `authnudge` server is missing or cannot be authorized.

1. `publicKey` also returns `toConfigured` (handle/email in `AUTHNUDGE_TO`) and `apiKeyConfigured` (API key in `AUTHNUDGE_API_KEY`), never the values.
2. If **both** are true: call local `login` with `{ "url": "<login URL>" }` only. Do not ask for a handle, do not show a public key.
3. **Handle.** If `toConfigured` is false and you do not know their Authnudge handle or email, ask. Prefer a host question tool if one exists. Never ask for a password or API secret in that prompt.
4. **Pair** (skip if `apiKeyConfigured` is true). Show the user the `publicKey` value; do not paraphrase it. Tell them to open authnudge.com → Access → Public keys, enter any Name, paste it into **Public key** (placeholder: "P-256 SPKI, base64"), and Save. Wait until they confirm.
5. Call local `login` with `{ "url": "<login URL>", "to": "<handle>" }` (omit `to` if `toConfigured`). On `waiting`, call it again with the same arguments; it reattaches to the open request and does not push again. Other results as above. `status: "pairing"` with a `publicKey` means the key is not saved yet: show that same key again.

If the authnudge tools are missing, they need the Authnudge Cursor plugin (Customize → Plugins) and push enabled on the Authnudge PWA.
