# Authnudge agent

Cursor plugin marketplace for Authnudge phone-grant login. Layout follows the [Cursor plugin template](https://github.com/cursor/plugin-template).

This repository is the agent plugin, not the [Authnudge web app](https://authnudge.com).

**GitHub:** [Sebiee/authnudge-agent](https://github.com/Sebiee/authnudge-agent)  
**npm:** [authnudge-mcp](https://www.npmjs.com/package/authnudge-mcp)

## Plugin

| Plugin | Path | What it adds |
| --- | --- | --- |
| **authnudge** | `plugins/authnudge` | MCP `publicKey` + `login`, plus skill |

MCP is launched the same way as the template’s example:

```json
{
  "command": "npx",
  "args": ["-y", "authnudge-mcp"]
}
```

Node 22+ must be on `PATH`. Cursor starts plugin MCP from the workspace, so a relative `./mcp.mjs` does not work.

## Setup

1. Sign in at [authnudge.com](https://authnudge.com) and enable **Notify me of incoming requests**.
2. Start Chrome with remote debugging:

```bash
chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.authnudge-chrome"
```

3. Install this plugin in Cursor (Customize → Plugins).

If there is no plugin API key, the agent calls `publicKey` (P-256 SPKI, base64) and the holder pastes it at Access → Public keys. The private key stays on the agent machine. Pass `to` (handle or email) on `login`, or set `AUTHNUDGE_TO` under Plugins → Configure.

Playwright, computer-use, and other browser-automation windows are a different Chrome. After `{ "ok": true }`, the session is in the DevTools Chrome.

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
