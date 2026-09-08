import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { attachCdpPage, resolveCdpUrl } from "./cdp.mjs";
import { decryptEnvelope, generateRequesterKeys, requesterFingerprint, signRequest } from "./e2e.js";
import { ignorePlaceholder, normalizeBaseUrl, normalizeOrigin, normalizeTo, sameLoginHost } from "./origin.js";

const DEFAULT_BASE = "https://authnudge.com";
/** Keep in lockstep with Authnudge2 `RELAY_TTL_MS`. */
export const RELAY_TTL_MS = 10 * 60 * 1000;

/** ISO string or unix-ms number. `str()` on the MCP layer used to drop numbers. */
export function parseExpiresAt(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const trimmed = value.trim();
  if (!trimmed) return NaN;
  const fromIso = Date.parse(trimmed);
  if (Number.isFinite(fromIso)) return fromIso;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : NaN;
}

/** Wall-clock budgets (ms). Exported so checks can shrink them; not a config surface. */
export const timing = {
  form: 45_000, // SPA may still be rendering the login form
  settle: 6_000, // after one submit, how long the step gets to go away
  otpQuiet: 8_000, // after the password step: no code prompt within this much page quiet = done
  otpWatch: 20_000, // hard cap on that watch
  retypeAfter: 8_000, // identifier step still showing: type + submit again after this long
  toolCall: 25_000, // one MCP tool call returns within this; hosts cut tools/call at ~60s and do not honor progress
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

/** Public SPKI only. Private key stays in the key file. The OAuth `login` tool needs this key, so it is always returned. */
export async function publicKeyInfo() {
  const keys = await loadPersistentKeys();
  return {
    publicKey: keys.publicKey,
    fingerprint: await requesterFingerprint(keys.publicKey),
    toConfigured: Boolean(normalizeTo(process.env.AUTHNUDGE_TO)),
    apiKeyConfigured: readApiKey({}).startsWith("an_"),
  };
}

function resolveBaseUrl(options) {
  return normalizeBaseUrl(ignorePlaceholder(options.baseUrl ?? process.env.AUTHNUDGE_URL) || DEFAULT_BASE);
}

export async function createCredentialRequest({ baseUrl, to, origin, apiKey, publicKey, signature, issuedAt }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = { to, origin, requesterPublicKey: publicKey };
  if (signature) {
    body.signature = signature;
    body.issuedAt = issuedAt;
  }
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

/** The form is filled and no code step is coming: resolve the request now so the phone shows "Done" instead of waiting out the hold. */
async function markDone({ baseUrl, requestId, claimToken }) {
  try {
    await fetch(`${baseUrl}/api/v1/requests/${requestId}/done`, { method: "POST", headers: { authorization: `Bearer ${claimToken}` } });
  } catch {
    /* the relay's own alarm resolves it a little later */
  }
}

/** Poll until the relay shows a new envelope, is fulfilled, or expires. GET does not consume; `lastCiphertext` tells a new step from a re-read. Deadline follows GET `expiresAt` (relay TTL or a shorter code window), not a local 5-minute guess. */
export async function waitForEnvelope({ baseUrl, requestId, claimToken, expiresAt, signal, lastCiphertext = "" }) {
  let deadline = parseExpiresAt(expiresAt);
  if (!Number.isFinite(deadline)) deadline = Date.now() + RELAY_TTL_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) return { status: "error", code: "aborted" };
    try {
      const res = await fetch(`${baseUrl}/api/v1/requests/${requestId}`, { headers: { authorization: `Bearer ${claimToken}` } });
      if (res.ok) {
        const data = await res.json();
        const next = parseExpiresAt(data.expiresAt);
        if (Number.isFinite(next)) deadline = next;
        if (data.envelope && data.envelope.ciphertext !== lastCiphertext) {
          return { status: "holding", envelope: data.envelope, envelopeKind: data.envelopeKind || "password" };
        }
        if (data.status === "fulfilled") return { status: "fulfilled" };
        if (data.status === "expired" || deadline <= Date.now()) return { status: "expired" };
      } else if (res.status === 401 || res.status === 403) {
        return { status: "error", code: "unauthorized" };
      } else if (res.status === 404 || res.status === 410) {
        // The relay dropped it (e.g. the 90 s code window closed). Its own deadline can be earlier than the request's.
        return { status: "expired" };
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

/** A login form must be on screen before a grant is consumed (or a push sent): a wrong URL must not eat either. */
async function awaitLoginForm(page, origin) {
  const deadline = Date.now() + timing.form;
  while (Date.now() < deadline) {
    const s = await state(page, origin);
    if (s.gone) return { ok: false, status: "page_changed" };
    if (s.identifier || s.password) return { ok: true };
    await page.waitForUpdate(700);
  }
  return {
    ok: false,
    status: "no_form",
    message: `No login form at ${origin}. Find the page that shows the email/password form (often on an id., login., or account. host). Do not call login again: if you already have requestId and claimToken, call fill again with those and this URL. The phone is not pushed until fill polls after seeing a form.`,
  };
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

/** The relay has an open request: wait for the grant, decrypt with `keys`, fill `page`, handle a code step. */
async function fillFromRelay(page, origin, keys, relay) {
  const waited = await waitForEnvelope(relay);
  if (waited.status === "fulfilled") return FULFILLED;
  if (!waited.envelope) return { ok: false, status: waited.status === "expired" ? "expired" : "error" };

  const first = await useDelivery(page, origin, keys, relay.requestId, waited.envelope, waited.envelopeKind);
  if (!first.ok) return first;
  const result = await afterPassword(page, origin, keys, relay, waited.envelope.ciphertext);
  if (result.ok) await markDone(relay);
  return result;
}

/**
 * Fill `page` for a request plugin-authnudge-authnudge `login` already opened (it was given this
 * machine's `publicKey`). Phone push happens on the first relay poll after a form is on screen.
 * No handle, API key, or pairing needed. Never returns usernames or passwords.
 */
export async function fill(page, options = {}) {
  const claim = claimOf(options);
  if (!claim) return MISSING_CLAIM;
  let baseUrl;
  try {
    baseUrl = resolveBaseUrl(options);
  } catch {
    return { ok: false, status: "error", message: "AUTHNUDGE_URL must be http or https." };
  }
  const origin = normalizeOrigin(options.origin ?? options.url ?? (await page.url()));
  if (!origin) return { ok: false, status: "error", message: "The page URL is not a login origin." };
  const form = await awaitLoginForm(page, origin);
  if (!form.ok) return form;
  const deadline = parseExpiresAt(options.expiresAt);
  if (!Number.isFinite(deadline)) return MISSING_EXPIRES;

  return fillFromRelay(page, origin, await loadPersistentKeys(), {
    baseUrl,
    ...claim,
    expiresAt: deadline,
    signal: options.signal,
  });
}

const MISSING_CLAIM = { ok: false, status: "error", message: "Pass requestId and claimToken from the Authnudge `login` tool result." };
const MISSING_EXPIRES = { ok: false, status: "error", message: "Pass expiresAt (ISO) from the Authnudge `login` tool result." };
const FULFILLED = { ok: false, status: "fulfilled", message: "This request was already used. Check whether that Chrome tab is signed in before opening a new request." };
const MISSING_URL = { ok: false, status: "error", message: "Pass url copied from the live Sign-in form tab (never invent /login)." };

function claimOf(options) {
  const requestId = String(options.requestId ?? "").trim();
  const claimToken = String(options.claimToken ?? "").trim();
  return requestId && claimToken ? { requestId, claimToken } : null;
}

/** Fallback without OAuth: open the request here with a handle plus API key or paired key, then fill `page`. */
export async function login(page, options = {}) {
  const to = normalizeTo(options.to ?? process.env.AUTHNUDGE_TO);
  const apiKey = readApiKey(options);
  const namedKey = apiKey.startsWith("an_");
  if (apiKey && !namedKey) {
    return { ok: false, status: "error", message: "AUTHNUDGE_API_KEY must be a dashboard API key (an_…), or omit it to pair with a public key." };
  }
  let baseUrl;
  try {
    baseUrl = resolveBaseUrl(options);
  } catch {
    return { ok: false, status: "error", message: "AUTHNUDGE_URL must be http or https." };
  }
  // The URL the agent asked for is the login origin; page.url() can still be mid-redirect right after goto.
  const origin = normalizeOrigin(options.origin ?? options.url ?? (await page.url()));
  if (!to) return { ok: false, status: "error", message: "Pass to as your Authnudge email or handle (ask the user if unknown)." };
  if (!origin) return { ok: false, status: "error", message: "The page URL is not a login origin." };
  const form = await awaitLoginForm(page, origin);
  if (!form.ok) return form;

  const keys = namedKey ? await generateRequesterKeys() : await loadPersistentKeys();
  let created;
  try {
    created = await createCredentialRequest({
      baseUrl,
      to,
      origin,
      apiKey: namedKey ? apiKey : "",
      publicKey: keys.publicKey,
      ...(namedKey ? {} : await signRequest(keys.privateKey, { to, origin, publicKey: keys.publicKey })),
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
  if (created.status !== 201 && created.status !== 200) return { ok: false, status: "error", message: "Could not create a credential request." }; // 200 = reattached to a still-open request

  return fillFromRelay(page, origin, keys, {
    baseUrl,
    requestId: created.body.requestId,
    claimToken: created.body.claimToken,
    expiresAt: parseExpiresAt(created.body.expiresAt) || Date.now() + RELAY_TTL_MS,
    signal: options.signal,
  });
}

/** Run `step` on a tab in the Chrome at `options.cdpUrl`. `signal` aborts it: the socket closes, every page call fails, the job ends. */
async function onCdpPage(options, step, signal) {
  let page;
  try {
    page = await attachCdpPage(options.cdpUrl, options.url);
    signal?.addEventListener("abort", () => page.close(), { once: true });
    if (options.url) await page.goto(options.url);
  } catch (err) {
    page?.close();
    return { ok: false, status: "error", message: err instanceof Error ? err.message : "No browser." };
  }
  try {
    return await step(page, { ...options, signal });
  } finally {
    page.close();
  }
}

/**
 * Long work runs once, in the background, keyed so a repeat call reattaches instead of opening a
 * second phone-grant request. Each call returns within `timing.toolCall`: the final result, or
 * `status: "waiting"` telling the agent to call again with the same arguments.
 * A repeat call with a different `tag` (another browser) aborts the running job and starts over: the
 * first attempt was aimed at the wrong Chrome, and the relay lets the right one read the same grant.
 * ponytail: in-memory map; jobs die with this process, and the agent then gets "expired" from the relay on retry.
 */
const jobs = new Map();

export async function pollJob(key, start, waiting, tag = "") {
  let job = jobs.get(key);
  if (job && job.tag !== tag) {
    job.controller.abort();
    jobs.delete(key);
    job = null;
  }
  if (!job) {
    const controller = new AbortController();
    job = { tag, controller };
    job.promise = start(controller.signal).then(
      (result) => (job.result = result),
      (err) => (job.result = { ok: false, status: "error", message: String(err?.message ?? err) }),
    );
    jobs.set(key, job);
  }
  await Promise.race([job.promise, sleep(timing.toolCall)]);
  if (!job.result) return { ok: false, status: "waiting", ...waiting };
  jobs.delete(key);
  return job.result;
}

const RETRY_FILL = "Not done yet: waiting on the account holder's phone (approval, or the one-time code if the site asked for one). Call fill again with the same url, requestId, claimToken, and expiresAt. Do not call login again; reuse this request. Check cdpUrl is the browser you work in; if not, call fill again with the right cdpUrl.";
const RETRY_LOGIN = "Not done yet: waiting on the account holder's phone (approval, or the one-time code if the site asked for one). Call loginFallback again with the same url (and to). Only one request is open per site. Check cdpUrl is the browser you work in.";

const BAD_CDP = {
  ok: false,
  status: "error",
  message:
    "Pass cdpUrl as a loopback http(s) Chrome DevTools URL (127.0.0.1, localhost, or [::1]). Userinfo and remote hosts are rejected. Or set AUTHNUDGE_CDP_URL.",
};

export async function fillCdp(options = {}) {
  const claim = claimOf(options);
  if (!claim) return MISSING_CLAIM;
  if (!Number.isFinite(parseExpiresAt(options.expiresAt))) return { ...MISSING_EXPIRES, cdpUrl: resolveCdpUrl(options.cdpUrl) || "" };
  const cdpUrl = resolveCdpUrl(options.cdpUrl);
  if (!cdpUrl) return { ...BAD_CDP, cdpUrl: "" };
  const result = await pollJob(
    `fill:${claim.requestId}`,
    (signal) => onCdpPage({ ...options, cdpUrl }, fill, signal),
    { message: RETRY_FILL, expiresAt: options.expiresAt },
    cdpUrl,
  );
  return { ...result, cdpUrl };
}

export async function loginCdp(options = {}) {
  if (!String(options.url ?? "").trim()) return { ...MISSING_URL, cdpUrl: resolveCdpUrl(options.cdpUrl) || "" };
  const cdpUrl = resolveCdpUrl(options.cdpUrl);
  if (!cdpUrl) return { ...BAD_CDP, cdpUrl: "" };
  const site = normalizeOrigin(options.url ?? "") || cdpUrl;
  const result = await pollJob(`login:${site}`, (signal) => onCdpPage({ ...options, cdpUrl }, login, signal), { message: RETRY_LOGIN }, cdpUrl);
  return { ...result, cdpUrl };
}
