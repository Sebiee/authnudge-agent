// Real-Chrome check of the fill path: launches headless Chrome, serves fill.e2e.html, runs `loginCdp`
// against a mocked relay. Skips (exit 0) when no Chrome binary is found. CHROME=/path/to/chrome overrides.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptForRequester } from "./e2e.js";
import { loginCdp, timing } from "./login.mjs";

// Local mock answers in milliseconds; keep real Chrome, shrink only the waiting.
Object.assign(timing, { settle: 3_000, otpQuiet: 2_000, otpWatch: 6_000 });

const CANDIDATES = [
  process.env.CHROME,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
function findChrome() {
  for (const bin of CANDIDATES.filter(Boolean)) {
    if (bin.includes("/") || bin.includes("\\")) {
      if (existsSync(bin)) return bin;
      continue;
    }
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* next */
    }
  }
  return null;
}

const chromeBin = findChrome();
if (!chromeBin) {
  console.log("fill e2e skipped: no Chrome found (set CHROME=/path/to/chrome)");
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "authnudge-e2e-"));
process.env.AUTHNUDGE_KEY_FILE = join(work, "requester.json");
delete process.env.AUTHNUDGE_API_KEY;

const html = readFileSync(new URL("./fill.e2e.html", import.meta.url));
const server = createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url.startsWith("/done")) return res.end('<h1 id="done">logged in</h1><input type="search" placeholder="Suche">');
  res.end(html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const SITE = `http://127.0.0.1:${server.address().port}`;

const profile = join(work, "profile");
const chrome = spawn(chromeBin, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], {
  stdio: "ignore",
});
let CDP = "";
for (let i = 0; i < 100 && !CDP; i++) {
  try {
    CDP = `http://127.0.0.1:${readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim()}`;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
assert.ok(CDP, "Chrome did not open a DevTools port");

const realFetch = globalThis.fetch;
/** Relay mock: password envelope once, then (after /continue) the otp envelope once, then fulfilled. */
function mockRelay(origin, password) {
  const log = { continue: 0 };
  let phase = "password";
  let publicKey = "";
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (!path.startsWith("http://relay.test")) return realFetch(url, init);
    if (init?.method === "POST" && path.endsWith("/requests")) {
      publicKey = JSON.parse(init.body).requesterPublicKey;
      return Response.json({ requestId: "r1", claimToken: "c1", expiresAt: new Date(Date.now() + 120_000).toISOString() }, { status: 201 });
    }
    if (init?.method === "POST" && path.endsWith("/continue")) {
      log.continue += 1;
      phase = "otp";
      return Response.json({ ok: true });
    }
    if (init?.method === "POST" && path.endsWith("/done")) {
      phase = "done";
      return Response.json({ ok: true });
    }
    if (phase === "password") {
      phase = "holding";
      const envelope = await encryptForRequester(publicKey, { username: "shopper@example.com", password, origin }, "r1");
      return Response.json({ status: "holding", envelope, envelopeKind: "password" });
    }
    if (phase === "otp") {
      phase = "done";
      const envelope = await encryptForRequester(publicKey, { otp: "123456", origin }, "r1", "otp");
      return Response.json({ status: "holding", envelope, envelopeKind: "otp" });
    }
    return Response.json({ status: phase === "done" ? "fulfilled" : "holding", envelope: null });
  };
  return log;
}

/** Raw CDP look at the page after login (url, error text, decoy log). */
async function peek() {
  const [tab] = (await realFetch(`${CDP}/json/list`).then((r) => r.json())).filter((t) => t.type === "page");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  const expression =
    "JSON.stringify({ url: location.href, error: document.getElementById('error')?.textContent ?? '', log: document.getElementById('log')?.textContent ?? '' })";
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  const msg = await new Promise((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(e.data))));
  ws.close();
  return JSON.parse(msg.result.result.value);
}

async function scenario(name, query, { password = "s3cret!", otpAsks, ok, done, error = "" }) {
  const origin = `${SITE}/login`;
  const log = mockRelay(origin, password);
  const started = Date.now();
  const result = await loginCdp({ url: `${origin}${query}`, to: "you@example.com", baseUrl: "http://relay.test", cdpUrl: CDP });
  const page = await peek();
  console.log(`  ${name}: ${JSON.stringify(result)} ${Date.now() - started}ms`);
  assert.equal(result.ok, ok, `${name}: ${JSON.stringify(result)}`);
  assert.equal(/\/done$/.test(page.url), done, `${name}: done page (${page.url})`);
  assert.equal(log.continue, otpAsks, `${name}: /continue calls`);
  assert.equal(page.error, error, `${name}: page error "${page.error}"`);
  assert.equal(page.log, "", `${name}: decoy button clicked (${page.log})`);
  assert.equal(JSON.stringify(result).includes("s3cret"), false);
}

try {
  await scenario("two-step + single code field", "", { otpAsks: 1, ok: true, done: true });
  await scenario("two-step, slow render, Galaxus code boxes (auto-submit)", "?slow=1&boxes=1", { otpAsks: 1, ok: true, done: true });
  await scenario("two-step, no code", "?nootp=1", { otpAsks: 0, ok: true, done: true });
  // Site clears the field and complains. Must fail honestly after exactly two submits.
  await scenario("wrong password", "?wrong=1", { password: "nope", otpAsks: 0, ok: false, done: false, error: "password incorrect x2" });
  console.log("fill e2e ok");
} finally {
  chrome.kill();
  server.close();
  rmSync(work, { recursive: true, force: true });
}
