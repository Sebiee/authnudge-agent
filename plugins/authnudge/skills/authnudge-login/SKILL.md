---
name: authnudge-login
description: Logs an agent into a site via Authnudge phone grant. Use only when the user explicitly asks you to sign in, log in, or enter credentials, or when you need to login into the users account to complete a task. Never type a password, code, or private key. Preferred: plugin-authnudge-authnudge login plus plugin-authnudge-authnudge-chrome fill. Fallback: plugin-authnudge-authnudge-chrome loginFallback.
---

# Authnudge login

The account holder approves on their phone; `fill` types into your Chrome. Browsing yourself (computer-use, Playwright) is fine. Never ask for, type, or print a username, password, code, or the private key.

## Preferred: OAuth (`plugin-authnudge-authnudge` `login` + `plugin-authnudge-authnudge-chrome` `fill`)

1. **Your Chrome's DevTools port.** The `--remote-debugging-port=<port>` your Chrome was started with; start it with one if needed. Pass `cdpUrl` (`http://127.0.0.1:<port>`, loopback only) on every call; there is no default. Do **not** start a second "Authnudge Chrome"; a login in a browser you never use is worthless.
2. **The login URL.** Open the site in that Chrome, click **Sign in**, copy the URL of the page that shows the email/password form (Galaxus: `https://id.digitecgalaxus.ch/n/p/22/de`; Amazon: the `/ap/signin?…` page). **Never guess a URL.**
3. Call local **`publicKey`**. Keep `publicKey`; do not show it to the user on this path.
4. Echo the exact origin in chat. Call remote **`login`** `{ "origin": "<login URL>", "requesterPublicKey": "<publicKey>" }`. Copy `requestId`, `claimToken`, `expiresAt`. One call opens one request; the phone is pushed when `fill` sees the form. If Cursor says the server needs authorization, run its auth (for example `mcp_auth`), let the user sign in, retry.
5. Call local **`fill`** `{ "url": "<login URL>", "requestId", "claimToken", "expiresAt", "cdpUrl" }`, copied from step 4. Returns within ~25 s.
6. `status: "waiting"` → call `fill` again with the exact same arguments, quietly, until `expiresAt`. Covers approval and a one-time code. `claimToken` needs no refresh; a second `login` is a second request.
7. `{ "ok": true }` → done. Keep working in that Chrome profile. Report the result right away.

| Result | Do |
| --- | --- |
| `no_form` | No login form at that URL. No push was sent. Do not call `login` again. Find the form, then `fill` again with the same `requestId` / `claimToken` / `expiresAt`. |
| `expired` | The holder did not approve in time. Ask before opening a new request. |
| `fulfilled` | This request was already used. Look at the tab; it is probably signed in. |
| `error` | Report the message. If the password was already sent and the user wants a retry, one new `login` closes the old request. |
| `otp` | The site wants a code Authnudge could not request. Tell the user to type it in that Chrome window or look at their phone, never in chat. |
| Tool call timed out / MCP error | Look at the tab first. Signed in: done. Not: `fill` again, same arguments. Never a new `login` for this. |
| `cdpUrl` in the result is not your browser | `fill` again with the same request and the right `cdpUrl`; the wrong attempt is stopped, the grant is kept. |

Every result echoes `cdpUrl`. `fill` opens the login URL in a new tab unless one is already on that site. Do not run other login checks (computer-use, screenshots) while a `fill` is open.

## Fallback: `plugin-authnudge-authnudge-chrome` `loginFallback` (only if remote `authnudge` is missing or cannot be authorized)

`publicKey` also returns `toConfigured` and `apiKeyConfigured` (never the values).

- Both true → local `loginFallback` `{ "url", "cdpUrl" }`. Do not ask for a handle, do not show the key.
- `toConfigured` false → ask for their Authnudge handle or email (prefer a host question tool; never ask for a password or API secret).
- `apiKeyConfigured` false → show `publicKey` verbatim; they save it at authnudge.com → Access → Public keys. Wait for confirmation. `status: "pairing"` means it is not saved yet: show the same key again.
- Then local `loginFallback` `{ "url", "to", "cdpUrl" }`. `waiting` → call again with the same arguments; it reattaches, no second push. Other results as in the table.

If the authnudge tools are missing, the user needs the Authnudge Cursor plugin (Customize → Plugins) and push enabled on the Authnudge PWA.
