import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
assert.match(skill, /Never ask for, type, or print a username, password, code, or the private key/);
assert.match(skill, /host question tool/);
assert.match(skill, /Both true → local `loginFallback`/);
assert.match(skill, /plugin-authnudge-authnudge/);
assert.match(skill, /plugin-authnudge-authnudge-chrome/);
assert.match(skill, /echo the exact origin/i);
assert.match(skill, /No push was sent/);
assert.doesNotMatch(skill, /no grant was used/);
assert.doesNotMatch(skill, /http:\/\/127\.0\.0\.1:9222/);
assert.match(rule, /follow the \*\*authnudge-login\*\* skill/i);
assert.match(rule, /plugin-authnudge-authnudge/);
assert.match(rule, /loginFallback/);
assert.match(skill, /call `fill` again with the exact same arguments/);
assert.match(skill, /pushed when `fill` sees the form/);
assert.ok(rule.split("\n").length <= 12, "the rule rides in every prompt: never-type only, the how lives in the skill");
// Bots guessed login URLs (/login 404, /ap/signin) and burned a push each time. The recipe must forbid guessing before it mentions `login`.
assert.ok(skill.indexOf("**Never guess a URL.**") < skill.indexOf("Call remote **`login`**"));
assert.ok(skill.split("\n").length <= 45, "skill must stay a short recipe; long prose gets skimmed");
assert.match(skill, /computer-use, Playwright/i, "browsing yourself is allowed; only the credential step is Authnudge's");
assert.match(rule, /computer-use, Playwright/i, "browsing yourself is allowed; only the credential step is Authnudge's");
assert.match(skill, /--remote-debugging-port=/);
assert.match(skill, /Do \*\*not\*\* start a second|Do not start a separate/);
assert.match(skill, /cdpUrl/);
assert.doesNotMatch(skill, /stay logged out|not a Playwright or computer-use window/);
assert.doesNotMatch(rule, /stay logged out|not a Playwright or computer-use window/);
assert.doesNotMatch(skill.split("\n")[2], /computer-use, screen control/, "skill must not trigger on plain computer-use");
assert.doesNotMatch(skill.split("\n")[2], /whenever a site needs/);
assert.match(skill, /\| `fulfilled` \| This request was already used/);
// Shared box: the bot filled another agent's Chrome on the default port, then reattached to that zombie job.
assert.match(skill, /1\. \*\*Your Chrome's DevTools port\.\*\*/);
assert.match(skill, /Pass `cdpUrl`/);
assert.match(skill, /loopback only/);
assert.match(skill, /there is no default/);
assert.match(skill, /Every result echoes `cdpUrl`/);
assert.match(skill, /`claimToken` needs no refresh/);
assert.match(plugin.variables.properties.AUTHNUDGE_TO.description, /fallback/i);
assert.match(plugin.variables.properties.AUTHNUDGE_API_KEY.description, /fallback/i);
assert.match(plugin.variables.properties.AUTHNUDGE_CDP_URL.description, /loopback/i);
// Shipped plugin skill is the source of truth. Stale copies must be pointers, not the old one-tool / 9222 recipe.
function assertStalePointer(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  assert.match(text, /plugin skill|source of truth/i);
  assert.doesNotMatch(text, /http:\/\/127\.0\.0\.1:9222/);
  assert.doesNotMatch(text, /Call `login` with \{ "url": "<login URL>", "to"/);
}
assertStalePointer(join(homedir(), ".cursor/skills/authnudge-login/SKILL.md"));
assertStalePointer(join(repoRoot, "../Authnudge2/.cursor/skills/authnudge-login/SKILL.md"));

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
    assert.match(init.result.instructions, /Never invent \/login/);
    child.stdin.write(encode({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const listed = await next();
    const names = listed.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["publicKey", "fill", "loginFallback"]); // preferred order, as agents read it
    assert.equal(names.includes("login"), false);
    const pub = listed.result.tools.find((t) => t.name === "publicKey");
    assert.match(pub.description, /never returned/i);
    assert.match(pub.description, /never a guessed \/login/);
    const fillTool = listed.result.tools.find((t) => t.name === "fill");
    assert.match(fillTool.description, /^Preferred\./);
    assert.match(fillTool.description, /never invent \/login/);
    assert.match(fillTool.description, /Never returns usernames/);
    assert.match(fillTool.description, /browser you work in/);
    assert.doesNotMatch(fillTool.description, /Does not fill Playwright/);
    assert.doesNotMatch(fillTool.description, /default http:\/\/127\.0\.0\.1:9222/i);
    assert.doesNotMatch(fillTool.inputSchema.properties.cdpUrl.description, /Defaults to/);
    assert.match(fillTool.inputSchema.properties.cdpUrl.description, /loopback/i);
    assert.deepEqual(fillTool.inputSchema.required, ["url", "requestId", "claimToken", "expiresAt"]);
    const urlDesc = fillTool.inputSchema.properties.url.description;
    assert.match(urlDesc, /Never invent \/login/);
    assert.doesNotMatch(urlDesc, /galaxus\.ch\/login/);
    const loginTool = listed.result.tools.find((t) => t.name === "loginFallback");
    assert.match(loginTool.description, /^Fallback/);
    assert.match(loginTool.description, /never invent \/login/);
    assert.deepEqual(loginTool.inputSchema.required, ["url"]);
    assert.equal(loginTool.inputSchema.properties.url.description, urlDesc);
    assert.doesNotMatch(JSON.stringify(listed.result.tools), /galaxus\.ch\/login/);
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

await handshake(process.execPath, [join(here, "mcp.mjs")], here);
await handshake("npx", ["-y", repoRoot], join(repoRoot, ".."));
console.log("authnudge mcp check ok");
