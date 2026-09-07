# Authnudge

Phone-grant login for agents. The `login` tool never returns usernames or passwords.

## What `login` fills

Chrome started with remote debugging, default `http://127.0.0.1:9222`:

```bash
chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.authnudge-chrome"
```

Playwright, computer-use, and other browser-automation windows are a different Chrome. After `{ "ok": true }`, the session is in the DevTools Chrome. If the site asks for a one-time code, `login` requests it on the same grant and fills it; the code never appears in the tool result.

## Included

- `mcp.json`: `publicKey` (SPKI pairing) and `login` via `npx -y authnudge-mcp`
- `skills/authnudge-login/`: when and how to call `login`
- Optional plugin variables: `AUTHNUDGE_TO`, `AUTHNUDGE_API_KEY` (Plugins → Configure)

## Checks

From this plugin directory:

```bash
node login.check.mjs
node mcp.check.mjs
```
