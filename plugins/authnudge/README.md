# Authnudge

Phone-grant login for agents. The `login` tool never returns usernames or passwords.

## What `login` fills

Chrome started with remote debugging, default `http://127.0.0.1:9222`:

```bash
chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.authnudge-chrome"
```

Playwright, computer-use, and other browser-automation windows are a different Chrome. After `{ "ok": true }`, the session is in the DevTools Chrome. If the site asks for a one-time code, `login` requests it on the same grant and fills it; the code never appears in the tool result.

## Included

- `mcp.json`, two servers:
  - `authnudge` — remote `https://authnudge.com/mcp`, OAuth. Cursor connects it once (sign in, name the connection). Its `login` opens the phone-grant request. Preferred.
  - `authnudge-chrome` — local `npx -y authnudge-mcp`: `publicKey`, `fill` (finish the OAuth request in Chrome), and the fallback `login`.
- `skills/authnudge-login/`: OAuth flow first, fallback second
- `rules/prefer-authnudge-login.mdc`: always-on — prefer Authnudge over screen control / computer-use for login
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
