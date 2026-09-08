# Authnudge agent

Cursor plugin marketplace for Authnudge phone-grant login. Layout follows the [Cursor plugin template](https://github.com/cursor/plugin-template).

This repository is the agent plugin, not the [Authnudge web app](https://authnudge.com).

**GitHub:** [Sebiee/authnudge-agent](https://github.com/Sebiee/authnudge-agent)  
**npm:** [authnudge-mcp](https://www.npmjs.com/package/authnudge-mcp)

## Plugin

| Plugin | Path | What it adds |
| --- | --- | --- |
| **authnudge** | `plugins/authnudge` | Remote OAuth MCP (`login`) + local MCP (`publicKey`, `fill`, fallback `login`), skill, always-apply rule (Authnudge for the sign-in step) |

The remote server is `https://authnudge.com/mcp`; Cursor runs the OAuth connection. The local server is launched the same way as the template’s example:

```json
{
  "command": "npx",
  "args": ["-y", "authnudge-mcp"]
}
```

Node 22+ must be on `PATH`. Cursor starts plugin MCP from the workspace, so a relative `./mcp.mjs` does not work.

## Setup

1. Sign in at [authnudge.com](https://authnudge.com) and enable **Notify me of incoming requests**.
2. Start the Chrome the agent works in with remote debugging:

```bash
chrome --remote-debugging-port=9222
```

3. Install this plugin in Cursor (Customize → Plugins).

Preferred flow: the agent calls local `publicKey`, the remote OAuth `login` (with that key), then local `fill`. The first remote call has Cursor send you to authnudge.com to sign in and name the connection. No handle, API key, or pasted key. Revoke under Access → Connected apps.

Fallback (remote server unavailable): set `AUTHNUDGE_TO` and `AUTHNUDGE_API_KEY` under Plugins → Configure, or let the agent show its `publicKey` (P-256 SPKI, base64) and paste it at Access → Public keys. The private key stays on the agent machine.

The agent may browse with computer-use or Playwright; only the credential step goes through Authnudge. `fill` types into whichever Chrome exposes the DevTools port, so that must be the browser the agent uses (one browser, one profile). After `{ "ok": true }`, the session is in that profile.

## Test locally

```bash
mkdir -p ~/.cursor/plugins/local
ln -sfn "$(pwd)/plugins/authnudge" ~/.cursor/plugins/local/authnudge
```

Then **Developer: Reload Window**. If `login` does not appear, disable any other installed plugin named `authnudge`.

## Validate

```bash
npm run check
```

## Publish

1. `npm publish --access public`
2. Submit `https://github.com/Sebiee/authnudge-agent` at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish).
