import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptEnvelope, encryptForRequester, generateRequesterKeys } from "./e2e.js";
import { loginFormOp } from "./fill.js";
import { fill, login, pollJob, publicKeyInfo, timing } from "./login.mjs";
import { ignorePlaceholder, normalizeTo } from "./origin.js";

// Fake pages react instantly; the budgets only need to be long enough for a few loop turns.
Object.assign(timing, { form: 2_000, settle: 150, otpQuiet: 200, otpWatch: 500, retypeAfter: 300, toolCall: 100 });

// One MCP call must return inside the host's tools/call cap. Slow work runs once; repeat calls reattach, never restart.
{
  let starts = 0;
  let finish;
  const slow = () => {
    starts += 1;
    return new Promise((resolve) => (finish = resolve));
  };
  const first = await pollJob("k", slow, { message: "again" });
  assert.deepEqual(first, { ok: false, status: "waiting", message: "again" });
  const second = await pollJob("k", slow, { message: "again" });
  assert.equal(second.status, "waiting");
  assert.equal(starts, 1);
  finish({ ok: true });
  assert.deepEqual(await pollJob("k", slow, {}), { ok: true });
  assert.deepEqual(await pollJob("k", async () => ({ ok: false, status: "expired" }), {}), { ok: false, status: "expired" }); // key freed after a result
  assert.equal(starts, 1);
  const thrown = await pollJob("boom", async () => { throw new Error("cdp down"); }, {});
  assert.deepEqual(thrown, { ok: false, status: "error", message: "cdp down" });
}

assert.equal(ignorePlaceholder("${AUTHNUDGE_API_KEY}"), "");
assert.equal(ignorePlaceholder("  ${AUTHNUDGE_TO}  "), "");
assert.equal(ignorePlaceholder("an_real"), "an_real");
assert.equal(normalizeTo("${AUTHNUDGE_TO}"), "");
assert.equal(normalizeTo("@You@Example.com"), "you@example.com");

// The in-page helper must stay serializable (CDP sends fn.toString()) and value-free.
const src = loginFormOp.toString();
assert.doesNotMatch(src, /import|require\(/);
assert.match(src, /suche/);
assert.match(src, /anmelden/);
assert.match(src, /one-time-code/);
assert.match(src, /button\[type=submit\]/);
assert.doesNotMatch(src, /\.value = /); // never writes a value; typing is Input.insertText
assert.match(readFileSync(new URL("./login.mjs", import.meta.url), "utf8"), /\/continue/);

const pair = await generateRequesterKeys();
const otpEnvelope = await encryptForRequester(pair.publicKey, { otp: "123456", origin: "https://www.galaxus.ch/login" }, "req-otp", "otp");
const otpPlain = await decryptEnvelope(pair.privateKey, otpEnvelope, { requestId: "req-otp", requesterPublicKey: pair.publicKey, step: "otp" });
assert.equal(otpPlain.otp, "123456");
await assert.rejects(() => decryptEnvelope(pair.privateKey, otpEnvelope, { requestId: "req-otp", requesterPublicKey: pair.publicKey }));

const origin = "https://www.galaxus.ch/login";
process.env.AUTHNUDGE_KEY_FILE = join(mkdtempSync(join(tmpdir(), "authnudge-")), "requester.json");
delete process.env.AUTHNUDGE_API_KEY;

/**
 * Fake login page. Steps: identifier -> password (email kept, pre-filled) -> otp -> done.
 * `submitWorks` decides which submit mechanisms the site accepts. Records what was typed (lengths only) and asked.
 */
function fakePage({ steps = ["identifier", "password", "done"], submitWorks = { click: true, enter: true }, formDelay = 0, wrongPassword = false } = {}) {
  let step = steps[0];
  let filled = { identifier: false, password: false, otp: false };
  let focused = null;
  let loads = 0;
  const log = { typed: [], ops: [], submits: [] };
  const advance = () => {
    const next = steps[steps.indexOf(step) + 1];
    if (step === "password" && wrongPassword) {
      filled.password = false;
      log.submits.push("rejected");
      return;
    }
    step = next ?? "done";
    filled = { identifier: step === "password", password: false, otp: false };
    focused = null;
  };
  return {
    log,
    url: () => (step === "done" ? "https://www.galaxus.ch/" : origin),
    waitForUpdate: async () => {
      loads += 1;
      return false;
    },
    insertText: async (text) => {
      assert.ok(focused, "insertText without focus");
      log.typed.push(`${focused}:${text.length}`);
      filled[focused] = true;
    },
    pressEnter: async () => {
      log.submits.push("enter");
      if (submitWorks.enter) advance();
    },
    op: async (arg) => {
      log.ops.push(arg.op + (arg.kind ? `:${arg.kind}` : ""));
      assert.equal("secret" in arg || "identifier" in arg || "text" in arg, false, "secrets must not travel in ops");
      if (arg.op === "inspect") {
        if (loads < formDelay) return { ok: true, password: false, identifier: false, otp: false };
        return {
          ok: true,
          password: step === "password",
          passwordFilled: filled.password,
          identifier: step === "identifier" || step === "password",
          identifierFilled: filled.identifier,
          otp: step === "otp",
          otpBoxes: step === "otp" ? 1 : 0,
          otpFilled: filled.otp,
        };
      }
      const present = { identifier: step === "identifier" || step === "password", password: step === "password", otp: step === "otp" };
      if (!present[arg.kind]) return { ok: false, reason: "no_field" };
      if (arg.op === "focus") {
        focused = arg.kind;
        return { ok: true };
      }
      if (arg.op === "click") {
        log.submits.push("click");
        if (submitWorks.click) advance();
        return { ok: true };
      }
      if (arg.op === "requestSubmit") throw new Error("requestSubmit must not run when the form has a button");
      throw new Error(`unexpected op ${arg.op}`);
    },
  };
}

/** Relay mock: password envelope, then (if the page asks) an otp envelope, then fulfilled. */
function mockRelay(requestId, { status = 201, checkPost, otpCode = "123456" } = {}) {
  const seen = { continue: 0, posts: 0, done: 0 };
  let phase = "password";
  let publicKey = "";
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (init?.method === "POST" && path.endsWith("/requests")) {
      seen.posts += 1;
      const body = JSON.parse(init.body);
      publicKey = body.requesterPublicKey;
      checkPost?.(body, init.headers);
      if (status !== 201) return Response.json({ error: "nope" }, { status });
      return Response.json({ requestId, claimToken: `claim-${requestId}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
    }
    if (init?.method === "POST" && path.endsWith("/continue")) {
      assert.equal(init.headers.authorization, `Bearer claim-${requestId}`);
      assert.equal(JSON.parse(init.body).type, "otp");
      seen.continue += 1;
      phase = "otp";
      return Response.json({ ok: true, status: "otp_needed" });
    }
    if (init?.method === "POST" && path.endsWith("/done")) {
      assert.equal(init.headers.authorization, `Bearer claim-${requestId}`);
      seen.done += 1;
      phase = "done";
      return Response.json({ ok: true, status: "fulfilled" });
    }
    assert.match(path, new RegExp(`/api/v1/requests/${requestId}$`));
    assert.equal(init.headers.authorization, `Bearer claim-${requestId}`);
    if (phase === "password") {
      phase = "holding";
      const envelope = await encryptForRequester(publicKey, { username: "shopper", password: "s3cret", origin }, requestId);
      return Response.json({ status: "holding", envelope, envelopeKind: "password" });
    }
    if (phase === "otp") {
      phase = "done";
      const envelope = await encryptForRequester(publicKey, { otp: otpCode, origin }, requestId, "otp");
      return Response.json({ status: "holding", envelope, envelopeKind: "otp" });
    }
    return Response.json({ status: phase === "done" ? "fulfilled" : "holding", envelope: null });
  };
  return seen;
}

const opts = { to: "you@example.com", baseUrl: "http://127.0.0.1:9" };

// OAuth path: the remote `login` tool already opened the request with our publicKey; `fill` only polls and fills.
{
  const page = fakePage({ steps: ["identifier", "password", "otp", "done"] });
  const seen = mockRelay("req-oauth");
  const { publicKey } = await publicKeyInfo();
  // mockRelay learns the requester key from the create POST; the OAuth server did that for us. Prime it the same way.
  await fetch("http://127.0.0.1:9/api/v1/requests", { method: "POST", body: JSON.stringify({ requesterPublicKey: publicKey }) });
  const grant = { requestId: "req-oauth", claimToken: "claim-req-oauth", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const result = await fill(page, { ...grant, baseUrl: opts.baseUrl });
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.continue, 1);
  assert.equal(seen.done, 1); // phone flips to "Done" right away instead of at the hold alarm
  assert.deepEqual(page.log.typed, ["identifier:7", "password:6", "otp:6"]);
  assert.equal(JSON.stringify(result).includes("s3cret"), false);
}
globalThis.fetch = async () => {
  throw new Error("fill must not call Authnudge without a claim");
};
const noClaim = await fill(fakePage(), { requestId: "x", baseUrl: opts.baseUrl });
assert.equal(noClaim.status, "error");
assert.match(noClaim.message, /claimToken/);

// Wrong URL (a 404, a home page): say so before the grant is taken or a push is sent, so nothing is wasted.
globalThis.fetch = async () => {
  throw new Error("no relay call without a login form on screen");
};
{
  const formless = fakePage({ steps: ["done"] });
  formless.url = () => origin; // stays on the site, just no form
  const viaFill = await fill(formless, { requestId: "x", claimToken: "y", baseUrl: opts.baseUrl, url: origin });
  assert.equal(viaFill.status, "no_form");
  assert.match(viaFill.message, /id\., login\., or account\./);
  const viaLogin = await login(formless, opts);
  assert.equal(viaLogin.status, "no_form");
}

// Pairing: unsigned key is rejected with 401 -> hand back the public key, never the private one.
mockRelay("req-0", {
  status: 401,
  checkPost: (body, headers) => {
    assert.equal(headers.authorization, undefined);
    assert.ok(body.requesterPublicKey);
    assert.ok(body.signature);
  },
});
const pairing = await login(fakePage(), opts);
assert.equal(pairing.status, "pairing");
assert.ok(pairing.publicKey.length > 40);
assert.equal(typeof pairing.fingerprint, "string");
assert.equal(JSON.stringify(pairing).includes("privateKey"), false);

// Two-step site (Galaxus): email step, then password step that keeps the email pre-filled.
{
  const page = fakePage();
  mockRelay("req-1", { checkPost: (body) => assert.equal(body.requesterPublicKey, pairing.publicKey) });
  const result = await login(page, opts);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(page.log.typed, ["identifier:7", "password:6"]); // email typed once, never re-typed on step 2
  assert.deepEqual(page.log.submits, ["click", "click"]);
  assert.equal(JSON.stringify(result).includes("s3cret"), false);
}

// One-page form: both fields at once, single submit.
{
  const page = fakePage({ steps: ["password", "done"] });
  page.log.typed.length = 0;
  mockRelay("req-2");
  assert.deepEqual(await login(page, opts), { ok: true });
  assert.deepEqual(page.log.typed, ["identifier:7", "password:6"]);
  assert.deepEqual(page.log.submits, ["click"]);
}

// SPA still rendering: no form for a while, then it shows up.
{
  const page = fakePage({ steps: ["password", "done"], formDelay: 3 });
  mockRelay("req-3");
  assert.deepEqual(await login(page, opts), { ok: true });
  assert.deepEqual(page.log.typed, ["identifier:7", "password:6"]);
}

// Button click is swallowed (overlay, custom widget): fall back to Enter, still verified.
{
  const page = fakePage({ submitWorks: { click: false, enter: true } });
  mockRelay("req-4");
  assert.deepEqual(await login(page, opts), { ok: true });
  assert.deepEqual(page.log.submits, ["click", "enter", "click", "enter"]);
}

// Wrong password: the site stays on the password step. Two attempts max, honest failure.
{
  const page = fakePage({ steps: ["password", "done"], wrongPassword: true });
  const seen = mockRelay("req-5");
  const result = await login(page, opts);
  assert.equal(result.ok, false);
  assert.equal(result.status, "error");
  assert.deepEqual(page.log.submits, ["click", "rejected", "enter", "rejected"]);
  assert.equal(seen.done, 0); // a failed fill must leave the request open for a code/retry decision
}

// OTP after the password: ask the phone via /continue, type the code, submit, done.
{
  const page = fakePage({ steps: ["identifier", "password", "otp", "done"] });
  const seen = mockRelay("req-6");
  const result = await login(page, opts);
  assert.deepEqual(result, { ok: true });
  assert.equal(seen.continue, 1);
  assert.deepEqual(page.log.typed, ["identifier:7", "password:6", "otp:6"]);
  assert.equal(JSON.stringify(result).includes("123456"), false);
}

// API key mode: bearer header, fresh key pair, no signature.
mockRelay("req-7", {
  checkPost: (body, headers) => {
    assert.equal(headers.authorization, "Bearer an_testkey_xxxxxxxx");
    assert.equal(body.signature, undefined);
    assert.equal(body.to, "you@example.com");
    assert.equal(body.origin, origin);
  },
});
assert.deepEqual(await login(fakePage(), { ...opts, apiKey: "an_testkey_xxxxxxxx" }), { ok: true });

// Guard rails.
process.env.AUTHNUDGE_TO = "${AUTHNUDGE_TO}";
process.env.AUTHNUDGE_API_KEY = "${AUTHNUDGE_API_KEY}";
globalThis.fetch = async () => {
  throw new Error("login must not call Authnudge when `to` is missing");
};
const missingTo = await login(fakePage(), { baseUrl: "http://127.0.0.1:9" });
assert.equal(missingTo.status, "error");
assert.match(missingTo.message, /Pass to/);

process.env.AUTHNUDGE_API_KEY = "not-a-real-key";
const junkKey = await login(fakePage(), opts);
assert.equal(junkKey.status, "error");
assert.match(junkKey.message, /an_/);
delete process.env.AUTHNUDGE_API_KEY;

process.env.AUTHNUDGE_TO = "";
const shown = await publicKeyInfo();
assert.ok(shown.publicKey.length > 40);
assert.equal(typeof shown.fingerprint, "string");
assert.equal(shown.toConfigured, false);
assert.equal(shown.apiKeyConfigured, false);
assert.equal(JSON.stringify(shown).includes("privateKey"), false);

process.env.AUTHNUDGE_TO = "holder@example.com";
process.env.AUTHNUDGE_API_KEY = "an_testkey_xxxxxxxx";
const configured = await publicKeyInfo();
assert.equal(configured.toConfigured, true);
assert.equal(configured.apiKeyConfigured, true);
assert.equal(configured.publicKey, shown.publicKey); // OAuth `login` needs the key even when a fallback API key is set

console.log("agent login check ok");
