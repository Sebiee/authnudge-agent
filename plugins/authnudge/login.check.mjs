import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptForRequester } from "./e2e.js";
import { fillLoginForm } from "./fill.js";
import { login, publicKeyInfo } from "./login.mjs";
import { ignorePlaceholder, normalizeTo } from "./origin.js";

assert.equal(ignorePlaceholder("${AUTHNUDGE_API_KEY}"), "");
assert.equal(ignorePlaceholder("  ${AUTHNUDGE_TO}  "), "");
assert.equal(ignorePlaceholder("an_real"), "an_real");
assert.equal(normalizeTo("${AUTHNUDGE_TO}"), "");
assert.equal(normalizeTo("@You@Example.com"), "you@example.com");

const src = fillLoginForm.toString();
assert.match(src, /typeof identifier === "object"/);
assert.match(src, /suche/);
assert.match(src, /anmelden/);
assert.match(src, /"search"\]\.includes\(type\)/);
assert.match(src, /insertFromPaste/);
assert.match(src, /op === "inspect"/);

const origin = "https://www.galaxus.ch/login";
const fakePage = () => ({
  url: () => origin,
  evaluate: async (_fn, arg) => {
    captured = arg;
    return { ok: true };
  },
});

let captured = null;
process.env.AUTHNUDGE_KEY_FILE = join(mkdtempSync(join(tmpdir(), "authnudge-")), "requester.json");
delete process.env.AUTHNUDGE_API_KEY;

let publicKey = "";
globalThis.fetch = async (url, init) => {
  if (init?.method === "POST") {
    const body = JSON.parse(init.body);
    publicKey = body.requesterPublicKey;
    assert.equal(body.to, "you@example.com");
    assert.equal(body.origin, origin);
    assert.equal(init.headers.authorization, "Bearer an_testkey_xxxxxxxx");
    assert.ok(publicKey);
    return Response.json(
      {
        requestId: "req-1",
        claimToken: "claim-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { status: 201 },
    );
  }
  assert.match(String(url), /\/api\/v1\/requests\/req-1$/);
  assert.equal(init.headers.authorization, "Bearer claim-1");
  const envelope = await encryptForRequester(publicKey, { username: "shopper", password: "s3cret", origin }, "req-1");
  return Response.json({ status: "fulfilled", envelope });
};

captured = null;
const result = await login(fakePage(), {
  to: "you@example.com",
  apiKey: "an_testkey_xxxxxxxx",
  baseUrl: "http://127.0.0.1:9",
});

assert.equal(result.ok, true);
assert.equal(JSON.stringify(result).includes("shopper"), false);
assert.equal(JSON.stringify(result).includes("s3cret"), false);
assert.equal("username" in result || "password" in result, false);
assert.equal(captured.identifier, "shopper");
assert.equal(captured.secret, "s3cret");
assert.equal(captured.expectedOrigin, origin);

globalThis.fetch = async (_url, init) => {
  assert.equal(init?.method, "POST");
  assert.equal(init.headers.authorization, undefined);
  const body = JSON.parse(init.body);
  assert.ok(body.requesterPublicKey);
  assert.ok(body.signature);
  return Response.json({ error: "Invalid request signature" }, { status: 401 });
};

const pairing = await login(fakePage(), {
  to: "you@example.com",
  baseUrl: "http://127.0.0.1:9",
});
assert.equal(pairing.ok, false);
assert.equal(pairing.status, "pairing");
assert.equal(typeof pairing.publicKey, "string");
assert.ok(pairing.publicKey.length > 40);
assert.equal(typeof pairing.fingerprint, "string");
assert.equal("privateKey" in pairing, false);
assert.equal(JSON.stringify(pairing).includes("privateKey"), false);

let signedPub = "";
globalThis.fetch = async (url, init) => {
  if (init?.method === "POST") {
    const body = JSON.parse(init.body);
    signedPub = body.requesterPublicKey;
    assert.equal(body.requesterPublicKey, pairing.publicKey);
    assert.ok(body.signature);
    assert.equal(init.headers.authorization, undefined);
    return Response.json(
      {
        requestId: "req-2",
        claimToken: "claim-2",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { status: 201 },
    );
  }
  assert.match(String(url), /\/api\/v1\/requests\/req-2$/);
  const envelope = await encryptForRequester(signedPub, { username: "shopper", password: "s3cret", origin }, "req-2");
  return Response.json({ status: "fulfilled", envelope });
};

captured = null;
const signed = await login(fakePage(), {
  to: "you@example.com",
  baseUrl: "http://127.0.0.1:9",
});
assert.equal(signed.ok, true);
assert.equal(captured.identifier, "shopper");
assert.equal("publicKey" in signed, false);

process.env.AUTHNUDGE_TO = "${AUTHNUDGE_TO}";
process.env.AUTHNUDGE_API_KEY = "${AUTHNUDGE_API_KEY}";
globalThis.fetch = async () => {
  throw new Error("login must not call Authnudge when `to` is missing");
};
const missingTo = await login(fakePage(), { baseUrl: "http://127.0.0.1:9" });
assert.equal(missingTo.ok, false);
assert.equal(missingTo.status, "error");
assert.match(missingTo.message, /Pass to/);

globalThis.fetch = async (_url, init) => {
  assert.equal(init?.method, "POST");
  assert.equal(init.headers.authorization, undefined);
  const body = JSON.parse(init.body);
  assert.equal(body.to, "you@example.com");
  assert.ok(body.signature);
  return Response.json({ error: "Invalid request signature" }, { status: 401 });
};
const placeholderKey = await login(fakePage(), {
  to: "you@example.com",
  baseUrl: "http://127.0.0.1:9",
});
assert.equal(placeholderKey.ok, false);
assert.equal(placeholderKey.status, "pairing");
assert.equal(typeof placeholderKey.publicKey, "string");

process.env.AUTHNUDGE_API_KEY = "not-a-real-key";
const junkKey = await login(fakePage(), {
  to: "you@example.com",
  baseUrl: "http://127.0.0.1:9",
});
assert.equal(junkKey.ok, false);
assert.equal(junkKey.status, "error");
assert.match(junkKey.message, /an_/);

delete process.env.AUTHNUDGE_API_KEY;
process.env.AUTHNUDGE_TO = "you@example.com";
let fills = 0;
globalThis.fetch = async (url, init) => {
  if (init?.method === "POST") {
    return Response.json(
      {
        requestId: "req-3",
        claimToken: "claim-3",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { status: 201 },
    );
  }
  assert.match(String(url), /\/api\/v1\/requests\/req-3$/);
  const keys = JSON.parse(readFileSync(process.env.AUTHNUDGE_KEY_FILE, "utf8"));
  const envelope = await encryptForRequester(keys.publicKey, { username: "shopper", password: "s3cret", origin }, "req-3");
  return Response.json({ status: "fulfilled", envelope });
};
const lateForm = {
  url: () => origin,
  waitForUpdate: async () => {},
  evaluate: async () => {
    fills += 1;
    if (fills < 3) return { ok: false, reason: "no_form" };
    return { ok: true };
  },
};
const retried = await login(lateForm, { to: "you@example.com", baseUrl: "http://127.0.0.1:9" });
assert.equal(retried.ok, true);
assert.equal(fills, 3);

const typed = [];
const ops = [];
globalThis.fetch = async (url, init) => {
  if (init?.method === "POST") {
    return Response.json(
      {
        requestId: "req-4",
        claimToken: "claim-4",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      { status: 201 },
    );
  }
  assert.match(String(url), /\/api\/v1\/requests\/req-4$/);
  const keys = JSON.parse(readFileSync(process.env.AUTHNUDGE_KEY_FILE, "utf8"));
  const envelope = await encryptForRequester(keys.publicKey, { username: "shopper", password: "s3cret", origin }, "req-4");
  return Response.json({ status: "fulfilled", envelope });
};
const typedPage = {
  url: () => origin,
  waitForUpdate: async () => {},
  insertText: async (text) => {
    typed.push(text.length);
  },
  evaluate: async (_fn, arg) => {
    ops.push(arg.op);
    assert.equal("secret" in arg, false);
    assert.equal("identifier" in arg, false);
    if (arg.op === "inspect") return { ok: true, password: true, identifier: true };
    return { ok: true };
  },
};
const typedIn = await login(typedPage, { to: "you@example.com", baseUrl: "http://127.0.0.1:9" });
assert.equal(typedIn.ok, true);
assert.deepEqual(ops, ["inspect", "focus", "focus", "submit"]);
assert.deepEqual(typed, [7, 6]);
assert.equal(JSON.stringify(ops).includes("s3cret"), false);

process.env.AUTHNUDGE_TO = "";
const shown = await publicKeyInfo();
assert.equal(typeof shown.publicKey, "string");
assert.ok(shown.publicKey.length > 40);
assert.equal(typeof shown.fingerprint, "string");
assert.equal(shown.toConfigured, false);
assert.equal(shown.apiKeyConfigured, false);
assert.equal("privateKey" in shown, false);
assert.equal(JSON.stringify(shown).includes("privateKey"), false);

console.log("agent login check ok");
