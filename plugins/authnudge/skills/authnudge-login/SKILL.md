---
name: authnudge-login
description: Logs an agent into a site via Authnudge phone grant. Use whenever a site needs sign-in, login, credentials, a password, or a 2FA code, in any browser you drive (computer-use, Playwright, DevTools). Authnudge replaces only the credential-entry step; never type a password or hand the user the screen for it. Preferred path is the Authnudge OAuth server's login tool plus the local fill tool, with no handle, API key, or pairing. Falls back to the local login tool with a handle and API key or paired public key.
---

# Authnudge login

The account holder approves on their phone; `fill` types the credentials into your Chrome. Browsing yourself (computer-use, Playwright) is fine. Never ask for, type, or print a username, password, code, or the private key.

## Preferred: OAuth (remote `login` + local `fill`)

1. **Your Chrome's DevTools port.** The `--remote-debugging-port=<port>` your Chrome was started with; start it with one if needed. On a shared machine the default `9222` may be another agent's browser. Pass `cdpUrl` on every call. Do **not** start a second "Authnudge Chrome"; a login in a browser you never use is worthless.
2. **The login URL.** Open the site in that Chrome, click **Sign in**, copy the URL of the page that shows the email/password form (Galaxus: `https://id.digitecgalaxus.ch/n/p/22/de`; Amazon: the `/ap/signin?…` page). **Never guess a URL.** A wrong one costs the user a push.
3. Call local **`publicKey`**. Keep `publicKey`; do not show it to the user on this path.
4. Call remote **`login`** `{ "origin": "<login URL>", "requesterPublicKey": "<publicKey>" }`. One call = one push. Tell the user once that a request is on their phone. If Cursor says the server needs authorization, run its auth (for example `mcp_auth`), let the user sign in, retry.
5. Call local **`fill`** `{ "url": "<login URL>", "requestId", "claimToken", "expiresAt", "cdpUrl" }`, copied from step 4. Returns within ~25 s.
6. `status: "waiting"` → call `fill` again with the exact same arguments, quietly, until `expiresAt`. Covers both the approval and a one-time code the holder may be typing. `claimToken` needs no refresh; a second `login` is a second push.
7. `{ "ok": true }` → done. The session is in that Chrome profile; keep working there. Report the result to the user right away.

| Result | Do |
| --- | --- |
| `no_form` | That URL has no login form; no grant was used. Do step 2 properly, then a new `login`. |
| `expired` | The holder did not approve in time. Ask before opening a new request. |
| `fulfilled` | This request was already used. Look at the tab; it is probably signed in. |
| `error` | Report the message. If the password was already sent and the user wants a retry, one new `login` closes the old request and pushes once. |
| `otp` | The site wants a code Authnudge could not request. Tell the user to type it in that Chrome window, never in chat. |
| Tool call timed out / MCP error | Look at the tab first. Signed in: done. Not: `fill` again, same arguments. Never a new `login` for this. |
| `cdpUrl` in the result is not your browser | `fill` again with the same request and the right `cdpUrl`; the wrong attempt is stopped, the grant is kept. |

Every result echoes `cdpUrl`. `fill` opens the login URL in a new tab unless one is already on that site. Do not run other login checks (computer-use, screenshots) while a `fill` is open.

## Fallback: local `login` (only if the remote `authnudge` server is missing or cannot be authorized)

`publicKey` also returns `toConfigured` and `apiKeyConfigured` (never the values).

- Both true → local `login` `{ "url", "cdpUrl" }`. Do not ask for a handle, do not show the key.
- `toConfigured` false → ask for their Authnudge handle or email (prefer a host question tool; never ask for a password or API secret).
- `apiKeyConfigured` false → show `publicKey` verbatim; they save it at authnudge.com → Access → Public keys. Wait for their confirmation. `status: "pairing"` means it is not saved yet: show the same key again.
- Then local `login` `{ "url", "to", "cdpUrl" }`. `waiting` → call again with the same arguments; it reattaches, no second push. Other results as in the table.

If the authnudge tools are missing, the user needs the Authnudge Cursor plugin (Customize → Plugins) and push enabled on the Authnudge PWA.
