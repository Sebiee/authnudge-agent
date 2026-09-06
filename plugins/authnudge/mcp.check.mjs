import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const plugin = JSON.parse(readFileSync(join(here, ".cursor-plugin/plugin.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const mcp = JSON.parse(readFileSync(join(here, "mcp.json"), "utf8"));

assert.equal(plugin.name, "authnudge");
assert.equal(plugin.repository, "https://github.com/Sebiee/authnudge-agent");
assert.equal(plugin.version, pkg.version);
assert.equal(pkg.bin["authnudge-mcp"], "./plugins/authnudge/mcp.mjs");
assert.equal(mcp.mcpServers.authnudge.command, "npx");
assert.deepEqual(mcp.mcpServers.authnudge.args, ["-y", "github:Sebiee/authnudge-agent"]);
assert.equal("cwd" in mcp.mcpServers.authnudge, false);
assert.doesNotMatch(JSON.stringify(mcp), /\$\{PLUGIN_ROOT\}/);
assert.doesNotMatch(JSON.stringify(mcp), /input-type=module/);
const placeholders = [...JSON.stringify(mcp).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]);
assert.deepEqual([...new Set(placeholders)].sort(), ["AUTHNUDGE_API_KEY", "AUTHNUDGE_TO"]);

function encode(msg) {
  return `${JSON.stringify(msg)}\n`;
}

async function handshake() {
  const child = spawn(process.execPath, [join(here, "mcp.mjs")], {
    cwd: here,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  let rest = "";
  const messages = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    rest += chunk;
    for (;;) {
      const n = rest.indexOf("\n");
      if (n === -1) break;
      const line = rest.slice(0, n).replace(/\r$/, "");
      rest = rest.slice(n + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (waiters.length) waiters.shift()(msg);
      else messages.push(msg);
    }
  });
  const next = () => (messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve) => waiters.push(resolve)));
  const timeout = setTimeout(() => {
    child.kill();
    throw new Error(`mcp handshake timed out\n${Buffer.concat(stderr).toString()}`);
  }, 5000);
  try {
    child.stdin.write(
      encode({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check" } },
      }),
    );
    const init = await next();
    assert.equal(init.result.serverInfo.name, "authnudge");
    child.stdin.write(encode({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const listed = await next();
    assert.equal(listed.result.tools[0].name, "login");
    assert.match(listed.result.tools[0].description, /Never returns usernames or passwords/);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

await handshake();
console.log("authnudge mcp check ok");
