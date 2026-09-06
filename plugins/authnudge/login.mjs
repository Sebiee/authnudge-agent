import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { attachCdpPage } from "./cdp.mjs";
import { decryptEnvelope, generateRequesterKeys, requesterFingerprint, signRequest } from "./e2e.js";
import { fillLoginForm } from "./fill.js";
import { ignorePlaceholder, normalizeBaseUrl, normalizeOrigin, normalizeTo, sameLoginHost } from "./origin.js";

const DEFAULT_BASE = "https://authnudge.com";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pageUrl(page) {
  const value = typeof page?.url === "function" ? page.url() : page?.url;
  return String((await value) ?? "");
}

function toWsUrl(baseUrl, path, claimToken) {
  const url = new URL(path, baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("claim", claimToken);
  return url.toString();
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

/** Public SPKI only. Private key stays in the key file. */
export async function publicKeyInfo() {
  const keys = await loadPersistentKeys();
  return {
    publicKey: keys.publicKey,
    fingerprint: await requesterFingerprint(keys.publicKey),
    toConfigured: Boolean(normalizeTo(process.env.AUTHNUDGE_TO)),
    apiKeyConfigured: readApiKey({}).startsWith("an_"),
  };
}

export async function createCredentialRequest({ baseUrl, to, origin, apiKey, publicKey, signature }) {
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const body = { to, origin, requesterPublicKey: publicKey };
  if (signature) body.signature = signature;
  const res = await fetch(`${baseUrl}/api/v1/requests`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, body: payload };
}

export async function waitForEnvelope({ baseUrl, requestId, claimToken, expiresAt, signal }) {
  const poll = async () => {
    const res = await fetch(`${baseUrl}/api/v1/requests/${requestId}`, {
      headers: { authorization: `Bearer ${claimToken}` },
    });
    if (!res.ok) return null;
    return res.json();
  };

  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ status: "error", code: "aborted" });
    const consider = (data) => {
      if (data?.status === "fulfilled" || data?.type === "fulfilled") {
        finish({ status: "fulfilled", envelope: data.envelope ?? null });
      }
      if (data?.status === "expired" || data?.type === "expired") finish({ status: "expired" });
    };
    const connect = () => {
      if (settled || typeof WebSocket !== "function") return;
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
      try {
        socket = new WebSocket(toWsUrl(baseUrl, `/api/v1/requests/${requestId}/ws`, claimToken));
      } catch {
        return;
      }
      socket.addEventListener("message", (event) => {
        if (event.data === "pong") return;
        try {
          consider(JSON.parse(event.data));
        } catch {
          /* ignore */
        }
      });
      socket.addEventListener("close", () => {
        socket = null;
      });
    };
    const tick = async () => {
      if (Date.now() >= expiresAt) return finish({ status: "expired" });
      try {
        consider(await poll());
      } catch {
        /* still waiting */
      }
      if (socket?.readyState === WebSocket.OPEN) socket.send("ping");
      else connect();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    connect();
    void tick();
    const timer = setInterval(() => void tick(), 2000);
  });
}

async function fillPage(page, origin, identifier, secret) {
  const deadline = Date.now() + 45_000;
  let waitMs = 15_000;
  while (Date.now() < deadline) {
    if (!sameLoginHost(await pageUrl(page), origin)) return { ok: false, status: "page_changed" };
    let result;
    try {
      result = await page.evaluate(fillLoginForm, { identifier, secret, expectedOrigin: origin, waitMs });
    } catch {
      result = { ok: false, reason: "need_password" };
    }
    if (result?.ok) return { ok: true };
    if (result?.reason === "wrong_origin") return { ok: false, status: "page_changed" };
    if (result?.reason === "no_form") return { ok: false, status: "no_form" };
    waitMs = 4_000;
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }
  if (!sameLoginHost(await pageUrl(page), origin)) return { ok: false, status: "page_changed" };
  return { ok: false, status: "no_form" };
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
  const origin = normalizeOrigin(options.origin ?? (await pageUrl(page)));
  if (!to) {
    return {
      ok: false,
      status: "error",
      message: "Pass to as your Authnudge email or handle (ask the user if unknown).",
    };
  }
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
  if (created.status === 401) {
    return { ok: false, status: "error", message: "API key was rejected. It must belong to the account in `to`." };
  }
  if (created.status === 429) return { ok: false, status: "error", message: "Inbox is full. Try again shortly." };
  if (created.status !== 201) return { ok: false, status: "error", message: "Could not create a credential request." };

  const expiresAt = Date.parse(created.body.expiresAt) || Date.now() + 5 * 60 * 1000;
  const waited = await waitForEnvelope({
    baseUrl,
    requestId: created.body.requestId,
    claimToken: created.body.claimToken,
    expiresAt,
    signal: options.signal,
  });
  if (waited.status !== "fulfilled" || !waited.envelope) {
    return { ok: false, status: waited.status === "expired" ? "expired" : "error" };
  }

  let payload;
  try {
    payload = await decryptEnvelope(keys.privateKey, waited.envelope, {
      requestId: created.body.requestId,
      requesterPublicKey: keys.publicKey,
    });
  } catch {
    return { ok: false, status: "error" };
  }
  if (payload?.origin !== origin) return { ok: false, status: "error" };
  const identifier = payload?.username;
  const secret = payload?.password;
  payload = null;
  if (typeof identifier !== "string" || typeof secret !== "string") return { ok: false, status: "error" };

  try {
    return await fillPage(page, origin, identifier, secret);
  } finally {
    waited.envelope = null;
  }
}

/** Same as `login`, but the page is a tab in Chrome with remote debugging (default port 9222), not another agent's browser. */
export async function loginCdp(options = {}) {
  let page;
  try {
    page = await attachCdpPage(options.cdpUrl);
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
