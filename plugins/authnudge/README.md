# Authnudge

Phone-grant login for agents. The `login` tool never returns usernames or passwords.

## What `fill` types into

The Chrome the agent already works in, over DevTools (`cdpUrl`, loopback only: `127.0.0.1`, `localhost`, or `[::1]`). There is no default port. Start that Chrome with a port:

```bash
chrome --remote-debugging-port=9222
```

Computer-use and Playwright are fine; only the credential-entry step goes through Authnudge. One browser, one profile: a second "Authnudge Chrome" logs in a window the agent never uses. On a shared machine, pass the agent's own port as `cdpUrl`; results echo it, and a repeat `fill` with a different `cdpUrl` restarts there without losing the grant. `fill` opens the login URL in a new tab unless one is already on that site. After `{ "ok": true }`, the session is in that profile. If the site asks for a one-time code, `fill` requests it on the same grant and fills it; the code never appears in the tool result.

## Included

- `mcp.json`, two servers:
  - `authnudge` — remote `https://authnudge.com/mcp`, OAuth. Cursor connects it once (sign in, name the connection). Its `login` opens the phone-grant request. Preferred.
  - `authnudge-chrome` — local `npx -y authnudge-mcp`: `publicKey`, `fill` (finish the OAuth request in Chrome), and `loginFallback`.
- `skills/authnudge-login/`: OAuth flow first, fallback second
- `rules/prefer-authnudge-login.mdc`: always-on — never type a password or ask the user to take over; follow the skill only when the task is to sign in or you need to sing in in the users account to complete a task
- Optional plugin variables: `AUTHNUDGE_TO`, `AUTHNUDGE_API_KEY` (fallback loginFallback), `AUTHNUDGE_CDP_URL` (loopback DevTools URL when `cdpUrl` is omitted). Not needed with OAuth plus a passed `cdpUrl`.

## Flow

1. `publicKey` (local) → this machine's P-256 public key.
2. `login` (remote, OAuth) with `origin` + `requesterPublicKey` → `requestId`, `claimToken`, `expiresAt`.
3. `fill` (local) with the same `url` and those three values → waits for the phone grant, decrypts with the local private key, fills Chrome.

`fill` and `loginFallback` return within ~25 s (MCP hosts cut `tools/call` at about 60 s). While the holder has not approved they return `status: "waiting"`; the agent calls the same tool again with the same arguments and reattaches to the running job. No second request, no second push. Remote `login` opens the request; the phone is pushed when `fill` first polls after seeing a login form. A URL without a login form returns `no_form` before that poll.

## Checks

From this plugin directory:

```bash
node login.check.mjs
node mcp.check.mjs
```
