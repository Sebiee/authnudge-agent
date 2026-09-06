# Authnudge agent

Cursor plugin marketplace for Authnudge phone-grant login. Layout follows the [Cursor plugin template](https://github.com/cursor/plugin-template).

This repository is the agent plugin, not the [Authnudge web app](https://authnudge.com).

**GitHub:** [Sebiee/authnudge-agent](https://github.com/Sebiee/authnudge-agent)

## Plugin

| Plugin | Path | What it adds |
| --- | --- | --- |
| **authnudge** | `plugins/authnudge` | MCP `login` tool + skill |

The plugin runs the bundled stdio server with `./mcp.mjs` (same plugin-relative `./` form as the template’s hook scripts). Node 22+ must be on `PATH`.

Other MCP clients can run the same server with `npx -y github:Sebiee/authnudge-agent` or `node plugins/authnudge/mcp.mjs`.

## Setup

1. Sign in at [authnudge.com](https://authnudge.com) and enable **Notify me of incoming requests**.
2. Start Chrome with remote debugging:

```bash
chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.authnudge-chrome"
```

3. Install this plugin in Cursor (Customize → Plugins), or add it from this GitHub repo.

No env vars are required. Pass `to` (Authnudge email or handle) on `login`. Optionally set `AUTHNUDGE_TO` / `AUTHNUDGE_API_KEY` under Plugins → Configure.

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

Submit `https://github.com/Sebiee/authnudge-agent` at [cursor.com/marketplace/publish](https://cursor.com/marketplace/publish).
