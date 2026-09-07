import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { attachCdpPage } from "./cdp.mjs";
import { decryptEnvelope, generateRequesterKeys, requesterFingerprint, signRequest } from "./e2e.js";
import { ignorePlaceholder, normalizeBaseUrl, normalizeOrigin, normalizeTo, sameLoginHost } from "./origin.js";

const DEFAULT_BASE = "https://authnudge.com";

/** Wall-clock budgets (ms). Exported so checks can shrink them; not a config surface. */
export const timing = {
  form: 45_000, // SPA may still be rendering the login form
  settle: 6_000, // after one submit, how long the step gets to go away
  otpQuiet: 8_000, // after the password step: no code prompt within this much page quiet = done
  otpWatch: 20_000, // hard cap on that watch
  retypeAfter: 8_000, // identifier step still showing: type + submit again after this long
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readApiKey(options) {
  return ignorePlaceholder(options.apiKey ?? process.env.AUTHNUDGE_API_KEY);
}

function keyFilePath() {
  const keyFile = ignorePlaceholder(process.env.AUTHNUDGE_KEY_FILE);
  if (keyFile) return keyFile;
  const pluginData = ignorePlaceholder(process.env.PLUGIN_DATA);
  if (pluginData) return join(pluginData, "requester.json");
  // ponytail: one JSON file on disk, not a keychain. Move to OS secret storage if this machine is shared.
  return join(homedir(), ".authnudge", "requester.json");
}

async function loadPersistentKeys() {
  const file = keyFilePath();
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved.publicKey === "string" && saved.publicKey && typeof saved.privateKey === "string" && saved.privateKey) {
      return { publicKey: saved.publicKey, privateKey: saved.privateKey };
    }
  } catch {
    /* missing or junk */
  }
  const keys = await generateRequesterKeys();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return keys;
}

/** Public SPKI only. Private key stays in the key file. No key pair when an API key is already set. */
export async function publicKeyInfo() {
  const toConfigured = Boolean(normalizeTo(process.env.AUTHNUDGE_TO));
  const apiKeyConfigured = readApiKey({}).startsWith("an_");
  if (apiKeyConfigured) return { toConfigured, apiKeyConfigured };
  const keys = await loadPersistentKeys();
  return {
    publicKey: keys.publicKey,
    fingerprint: await requesterFingerprint(keys.publicKey),
    toConfigured,
    apiKeyConfigured,
  };
}

export async function createCredentialRequest({ baseUrl, to, origin, apiKey, publicKey, signature }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = { to, origin, requesterPublicKey: publicKey };
  if (signature) body.signature = signature;
  const res = await fetch(`${baseUrl}/api/v1/requests`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, body: payload };
}

export async function askOtp({ baseUrl, requestId, claimToken }) {
  try {
    const res = await fetch(`${baseUrl}/api/v1/requests/${requestId}/continue`, {
      method: "POST",
      headers: { authorization: `Bearer ${claimToken}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "otp" }),
    });
    return res.ok || res.status === 409;
  } catch {
    return false;
  }
}

/** Poll until the relay hands over a new envelope, is fulfilled, or expires. GET takes the envelope, so each shows up once. */
export async function waitForEnvelope({ baseUrl, requestId, claimToken, expiresAt, signal, lastCiphertext = "" }) {
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return { status: "error", code: "aborted" };
    try {
      const res = await fetch(`${baseUrl}/api/v1/requests/${requestId}`, { headers: { authorization: `Bearer ${claimToken}` } });
      if (res.ok) {
        const data = await res.json();
        if (data.envelope && data.envelope.ciphertext !== lastCiphertext) {
          return { status: "holding", envelope: data.envelope, envelopeKind: data.envelopeKind || "password" };
        }
        if (data.status === "fulfilled") return { status: "fulfilled" };
        if (data.status === "expired") return { status: "expired" };
      }
    } catch {
      /* still waiting */
    }
    await sleep(2000);
  }
  return { status: "expired" };
}

// --- Form driving. Secrets only ever go through page.insertText (Chrome's own text input). ---

/** What the login page shows right now. `gone` = the tab left the login host. */
async function state(page, origin) {
  if (!sameLoginHost(await page.url(), origin)) return { gone: true };
  try {
    const snap = await page.op({ op: "inspect", expectedOrigin: origin });
    return snap?.ok ? snap : {};
  } catch {
    return {}; // mid-navigation
  }
}

/** Focus + select the field, then type over it. */
async function type(page, origin, kind, text, index = 0) {
  const focused = await page.op({ op: "focus", kind, index, expectedOrigin: origin });
  if (!focused?.ok) return false;
  await page.insertText(text);
  return true;
}

/** Typed text actually landed (field non-empty). Never submit on a blind type. */
async function filled(page, origin, kind) {
  return Boolean((await state(page, origin))[`${kind}Filled`]);
}

/**
 * Submit the step that owns `kind` and wait until `done(state)` says it is over.
 * Click the form's real submit button (goes through overlays); if the step is still there, Enter in the field;
 * requestSubmit() only when the form has no button at all. Two attempts max: a rejected password must not become a lockout.
 */
async function submitStep(page, origin, kind, done) {
  let hadButton = false;
  for (const how of ["click", "enter", "requestSubmit"]) {
    if (done(await state(page, origin))) return true;
    if (how === "requestSubmit" && hadButton) break;
    if (how === "enter") {
      const focused = await page.op({ op: "focus", kind, expectedOrigin: origin });
      if (!focused?.ok) continue;
      await page.pressEnter();
    } else {
      const sent = await page.op({ op: how, kind, expectedOrigin: origin });
      if (!sent?.ok) continue;
      if (how === "click") hadButton = true;
    }
    const until = Date.now() + timing.settle;
    while (Date.now() < until) {
      await page.waitForUpdate(500);
      if (done(await state(page, origin))) return true;
    }
  }
  return done(await state(page, origin));
}

const passwordStepOver = (s) => s.gone || !s.password;
const identifierStepOver = (s) => s.gone || s.password || s.otp || !s.identifier;

async function fillCredentials(page, origin, identifier, secret) {
  const deadline = Date.now() + timing.form;
  let identifierSentAt = 0;
  while (Date.now() < deadline) {
    const s = await state(page, origin);
    if (s.gone) return { ok: false, status: "page_changed" };
    if (s.password) {
      // Two-step sites keep the (pre-filled) email on the password step: leave it alone unless empty.
      if (s.identifier && !s.identifierFilled) await type(page, origin, "identifier", identifier);
      if (!(await type(page, origin, "password", secret)) || !(await filled(page, origin, "password"))) {
        await page.waitForUpdate(500);
        continue;
      }
      if (await submitStep(page, origin, "password", passwordStepOver)) return { ok: true };
      return { ok: false, status: "error", message: "The password was submitted but the site stayed on the password step." };
    }
    if (s.identifier && Date.now() - identifierSentAt > timing.retypeAfter) {
      if ((await type(page, origin, "identifier", identifier)) && (await filled(page, origin, "identifier"))) {
        identifierSentAt = Date.now();
        await submitStep(page, origin, "identifier", identifierStepOver);
        continue;
      }
    }
    await page.waitForUpdate(700);
  }
  return { ok: false, status: "no_form" };
}

async function fillOtp(page, origin, code) {
  const s = await state(page, origin);
  if (s.gone) return { ok: false, status: "page_changed" };
  if (!s.otp) return { ok: false, status: "no_form" };
  // Single-char boxes get one digit each (maxlength=1 truncates a paste); many auto-submit on the last one.
  for (let i = 0; i < (s.otpBoxes > 1 ? Math.min(code.length, s.otpBoxes) : 1); i++) {
    if (!(await type(page, origin, "otp", s.otpBoxes > 1 ? code[i] : code, i))) return { ok: false, status: "no_form" };
  }
  const after = await state(page, origin);
  if (after.otp && !after.otpFilled) return { ok: false, status: "no_form" };
  if (await submitStep(page, origin, "otp", (n) => n.gone || !n.otp)) return { ok: true };
  return { ok: false, status: "error", message: "The code was submitted but the site stayed on the code step." };
}

async function useDelivery(page, origin, keys, requestId, envelope, kind) {
  const step = kind === "otp" ? "otp" : undefined;
  let payload;
  try {
    payload = await decryptEnvelope(keys.privateKey, envelope, { requestId, requesterPublicKey: keys.publicKey, step });
  } catch {
    return { ok: false, status: "error" };
  }
  if (payload?.origin !== origin) return { ok: false, status: "error" };
  if (step === "otp") {
    const code = typeof payload.otp === "string" ? payload.otp.trim() : "";
    payload = null;
    return code ? fillOtp(page, origin, code) : { ok: false, status: "error" };
  }
  const { username, password } = payload;
  payload = null;
  if (typeof username !== "string" || typeof password !== "string") return { ok: false, status: "error" };
  return fillCredentials(page, origin, username, password);
}

/** Password is in. Watch briefly for a one-time-code prompt; if one shows, ask the phone for it and fill that too. */
async function afterPassword(page, origin, keys, relay, lastCiphertext) {
  for (let round = 0; round < 2; round++) {
    const cap = Date.now() + timing.otpWatch;
    let quietUntil = Date.now() + timing.otpQuiet;
    let s;
    do {
      if (await page.waitForUpdate(700)) quietUntil = Date.now() + timing.otpQuiet; // still navigating
      s = await state(page, origin);
    } while (!s.otp && !s.gone && Date.now() < Math.min(cap, quietUntil));
    if (!s.otp) return { ok: true };
    if (!(await askOtp(relay))) {
      return { ok: false, status: "otp", message: "The site asks for a one-time code. Enter it in that Chrome window." };
    }
    const ev = await waitForEnvelope({ ...relay, lastCiphertext });
    if (!ev.envelope) return { ok: false, status: ev.status === "expired" ? "expired" : "error" };
    lastCiphertext = ev.envelope.ciphertext;
    const filled = await useDelivery(page, origin, keys, relay.requestId, ev.envelope, "otp");
    if (!filled.ok) return filled;
  }
  return { ok: true };
}

/** Fill `page` after the account holder grants on their phone. Never returns usernames or passwords. */
export async function login(page, options = {}) {
  const to = normalizeTo(options.to ?? process.env.AUTHNUDGE_TO);
  const apiKey = readApiKey(options);
  const namedKey = apiKey.startsWith("an_");
  if (apiKey && !namedKey) {
    return { ok: false, status: "error", message: "AUTHNUDGE_API_KEY must be a dashboard API key (an_…), or omit it to pair with a public key." };
  }
  let baseUrl;
  try {
    baseUrl = normalizeBaseUrl(ignorePlaceholder(options.baseUrl ?? process.env.AUTHNUDGE_URL) || DEFAULT_BASE);
  } catch {
    return { ok: false, status: "error", message: "AUTHNUDGE_URL must be http or https." };
  }
  const origin = normalizeOrigin(options.origin ?? (await page.url()));
  if (!to) return { ok: false, status: "error", message: "Pass to as your Authnudge email or handle (ask the user if unknown)." };
  if (!origin) return { ok: false, status: "error", message: "The page URL is not a login origin." };

  const keys = namedKey ? await generateRequesterKeys() : await loadPersistentKeys();
  let created;
  try {
    created = await createCredentialRequest({
      baseUrl,
      to,
      origin,
      apiKey: namedKey ? apiKey : "",
      publicKey: keys.publicKey,
      signature: namedKey ? undefined : await signRequest(keys.privateKey, { to, origin, publicKey: keys.publicKey }),
    });
  } catch {
    return { ok: false, status: "error", message: "Could not reach Authnudge." };
  }
  if (created.status === 401 && !namedKey) {
    return {
      ok: false,
      status: "pairing",
      publicKey: keys.publicKey,
      fingerprint: await requesterFingerprint(keys.publicKey),
      message: "Save this public key at authnudge.com → Access → Public keys, then retry.",
    };
  }
  if (created.status === 401) return { ok: false, status: "error", message: "API key was rejected. It must belong to the account in `to`." };
  if (created.status === 429) return { ok: false, status: "error", message: "Inbox is full. Try again shortly." };
  if (created.status !== 201) return { ok: false, status: "error", message: "Could not create a credential request." };

  const relay = {
    baseUrl,
    requestId: created.body.requestId,
    claimToken: created.body.claimToken,
    expiresAt: Date.parse(created.body.expiresAt) || Date.now() + 5 * 60 * 1000,
    signal: options.signal,
  };
  const waited = await waitForEnvelope(relay);
  if (!waited.envelope) return { ok: false, status: waited.status === "expired" ? "expired" : "error" };

  const first = await useDelivery(page, origin, keys, relay.requestId, waited.envelope, waited.envelopeKind);
  if (!first.ok) return first;
  return afterPassword(page, origin, keys, relay, waited.envelope.ciphertext);
}

/** Same as `login`, but the page is a tab in Chrome with remote debugging (default port 9222), not another agent's browser. */
export async function loginCdp(options = {}) {
  let page;
  try {
    page = await attachCdpPage(options.cdpUrl, options.url);
    if (options.url) await page.goto(options.url);
  } catch (err) {
    page?.close();
    return { ok: false, status: "error", message: err instanceof Error ? err.message : "No browser." };
  }
  try {
    return await login(page, options);
  } finally {
    page.close();
  }
}
