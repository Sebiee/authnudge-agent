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
assert.equal(pkg.bin["authnudge-mcp"], "authnudge-mcp");
// OAuth server first: Cursor runs the OAuth flow itself for `url` servers; no variables involved.
assert.deepEqual(Object.keys(mcp.mcpServers), ["authnudge", "authnudge-chrome"]);
assert.equal(mcp.mcpServers.authnudge.url, "https://authnudge.com/mcp");
assert.equal("env" in mcp.mcpServers.authnudge, false);
const local = mcp.mcpServers["authnudge-chrome"];
assert.equal(local.command, "npx");
assert.deepEqual(local.args, ["-y", "authnudge-mcp"]);
assert.equal("cwd" in local, false);
assert.doesNotMatch(JSON.stringify(mcp), /\$\{PLUGIN_ROOT\}/);
assert.doesNotMatch(JSON.stringify(mcp), /input-type=module/);
const placeholders = [...JSON.stringify(mcp).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]);
assert.deepEqual([...new Set(placeholders)].sort(), Object.keys(plugin.variables.properties).sort());

const skill = readFileSync(join(here, "skills/authnudge-login/SKILL.md"), "utf8");
const rule = readFileSync(join(here, "rules/prefer-authnudge-login.mdc"), "utf8");
assert.match(skill, /## Preferred: OAuth/);
assert.ok(skill.indexOf("## Preferred: OAuth") < skill.indexOf("## Fallback"));
assert.match(skill, /Call local \*\*`publicKey`\*\*/);
assert.match(skill, /"requesterPublicKey"/);
assert.match(skill, /Call local \*\*`fill`\*\*/);
assert.match(skill, /Never print, copy, or ask for the private key/);
assert.match(skill, /host question tool/);
assert.match(skill, /If \*\*both\*\* are true: call local `login`/);
assert.match(rule, /`login` with `origin` \+ `requesterPublicKey`, then local `fill`/);
assert.match(skill, /call `fill` again with the exact same arguments/);
assert.match(skill, /One `login` call = one push/);
assert.match(rule, /Never call the remote `login` twice/);
// Grok bot read "not a computer-use window" as "use a separate hidden Chrome" and logged in a browser it never used.
for (const text of [skill, rule]) {
  assert.match(text, /computer-use, Playwright/i, "browsing yourself is allowed; only the credential step is Authnudge's");
  assert.match(text, /--remote-debugging-port=/);
  assert.match(text, /Do \*\*not\*\* start a second|Do not start a separate/);
  assert.doesNotMatch(text, /stay logged out|not a Playwright or computer-use window/);
}
assert.doesNotMatch(skill.split("\n")[2], /computer-use, screen control/, "skill must not trigger on plain computer-use");
assert.match(skill, /`fulfilled`: this request was already used/);
// Shared box: the bot filled another agent's Chrome on the default port, then reattached to that zombie job.
assert.match(skill, /Find your Chrome's DevTools address before the first `login`/);
assert.match(skill, /Every result echoes `cdpUrl`/);
assert.match(skill, /nothing to "refresh"/);
assert.match(rule, /Find your own Chrome's DevTools port first/);
assert.match(plugin.variables.properties.AUTHNUDGE_TO.description, /fallback/i);
assert.match(plugin.variables.properties.AUTHNUDGE_API_KEY.description, /fallback/i);

function encode(msg) {
  return `${JSON.stringify(msg)}\n`;
}

async function handshake(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
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
    throw new Error(`mcp handshake timed out (${command} ${args.join(" ")})\n${Buffer.concat(stderr).toString()}`);
  }, command === "npx" ? 60000 : 5000);
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
    const names = listed.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["publicKey", "fill", "login"]); // preferred order, as agents read it
    const pub = listed.result.tools.find((t) => t.name === "publicKey");
    assert.match(pub.description, /never returned/i);
    const fillTool = listed.result.tools.find((t) => t.name === "fill");
    assert.match(fillTool.description, /^Preferred\./);
    assert.match(fillTool.description, /Never returns usernames/);
    assert.match(fillTool.description, /browser you work in/);
    assert.doesNotMatch(fillTool.description, /Does not fill Playwright/);
    assert.deepEqual(fillTool.inputSchema.required, ["url", "requestId", "claimToken"]);
    const loginTool = listed.result.tools.find((t) => t.name === "login");
    assert.match(loginTool.description, /^Fallback/);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

await handshake(process.execPath, [join(here, "mcp.mjs")], here);
await handshake("npx", ["-y", repoRoot], join(repoRoot, ".."));
console.log("authnudge mcp check ok");
