# Authnudge

Phone-grant login for agents. The `login` tool never returns usernames or passwords.

## What `fill` types into

The Chrome the agent already works in, over DevTools (default `http://127.0.0.1:9222`, or `cdpUrl`). Start that Chrome with the port:

```bash
chrome --remote-debugging-port=9222
```

Computer-use and Playwright are fine; only the credential-entry step goes through Authnudge. One browser, one profile: a second "Authnudge Chrome" logs in a window the agent never uses. On a shared machine, pass the agent's own port as `cdpUrl`; results echo it, and a repeat `fill` with a different `cdpUrl` restarts there without losing the grant. `fill` opens the login URL in a new tab unless one is already on that site. After `{ "ok": true }`, the session is in that profile. If the site asks for a one-time code, `fill` requests it on the same grant and fills it; the code never appears in the tool result.

## Included

- `mcp.json`, two servers:
  - `authnudge` — remote `https://authnudge.com/mcp`, OAuth. Cursor connects it once (sign in, name the connection). Its `login` opens the phone-grant request. Preferred.
  - `authnudge-chrome` — local `npx -y authnudge-mcp`: `publicKey`, `fill` (finish the OAuth request in Chrome), and the fallback `login`.
- `skills/authnudge-login/`: OAuth flow first, fallback second
- `rules/prefer-authnudge-login.mdc`: always-on — Authnudge for the sign-in step; no password typing, no handing the user the screen
- Optional fallback variables: `AUTHNUDGE_TO`, `AUTHNUDGE_API_KEY` (Plugins → Configure). Not needed with OAuth.

## Flow

1. `publicKey` (local) → this machine's P-256 public key.
2. `login` (remote, OAuth) with `origin` + `requesterPublicKey` → `requestId`, `claimToken`, `expiresAt`.
3. `fill` (local) with the same `url` and those three values → waits for the phone grant, decrypts with the local private key, fills Chrome.

`fill` and `login` return within ~25 s (MCP hosts cut `tools/call` at about 60 s). While the holder has not approved they return `status: "waiting"`; the agent calls the same tool again with the same arguments and reattaches to the running job. No second request, no second push. A URL without a login form returns `no_form` before the grant is consumed.

## Checks

From this plugin directory:

```bash
node login.check.mjs
node mcp.check.mjs
```
