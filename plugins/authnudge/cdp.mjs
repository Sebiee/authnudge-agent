import { loginFormOp } from "./fill.js";
import { ignorePlaceholder } from "./origin.js";

export function defaultCdpUrl() {
  return ignorePlaceholder(process.env.AUTHNUDGE_CDP_URL) || "http://127.0.0.1:9222";
}

export function flattenFrameTree(node, out = []) {
  if (!node) return out;
  if (node.frame) out.push(node.frame);
  for (const child of node.childFrames ?? []) flattenFrameTree(child, out);
  return out;
}

/** The frame that owns the login step: password beats code beats identifier. */
export function pickFormFrame(hits) {
  const rank = (v) => (v?.password ? 3 : v?.otp ? 2 : v?.identifier ? 1 : 0);
  let best = null;
  for (const hit of hits) if (hit.value?.ok && rank(hit.value) > rank(best?.value)) best = hit;
  return best;
}

export function samePage(left, right) {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const path = (url) => url.pathname.replace(/\/+$/, "") || "/";
    return a.protocol === b.protocol && a.host.toLowerCase() === b.host.toLowerCase() && path(a) === path(b);
  } catch {
    return false;
  }
}

function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function tabScore(tab, want) {
  const url = parseHttpUrl(tab?.url);
  if (!url || url.protocol !== want.protocol || url.host.toLowerCase() !== want.host.toLowerCase()) return 0;
  const path = (value) => value.pathname.replace(/\/+$/, "") || "/";
  if (path(url) === path(want)) return 3;
  if (path(url).startsWith(path(want)) || path(want).startsWith(path(url))) return 2;
  return 1;
}

/** Prefer a page already on `wantUrl`; otherwise the first http(s) tab. */
export function pickTab(tabs, wantUrl) {
  const pages = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab?.type === "page" && tab.webSocketDebuggerUrl);
  if (!pages.length) return null;
  const http = pages.filter((tab) => /^https?:/i.test(tab.url ?? ""));
  const pool = http.length ? http : pages;
  const want = parseHttpUrl(wantUrl);
  if (want) {
    let best = null;
    let bestScore = 0;
    for (const tab of pool) {
      const score = tabScore(tab, want);
      if (score > bestScore) {
        best = tab;
        bestScore = score;
      }
    }
    if (best) return best;
  }
  return pool[0];
}

/** True when `tab` is already on the host of `wantUrl`. */
export function onHost(tab, wantUrl) {
  const want = parseHttpUrl(wantUrl);
  return Boolean(want && tabScore(tab, want) > 0);
}

/** Open `url` in a new tab; null if this Chrome refuses (then the caller falls back to an existing tab). */
async function newTab(cdpUrl, url) {
  try {
    const res = await fetch(new URL(`/json/new?${url}`, cdpUrl), { method: "PUT" });
    const tab = res.ok ? await res.json() : null;
    return tab?.webSocketDebuggerUrl ? tab : null;
  } catch {
    return null;
  }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Chrome DevTools socket timed out."));
    }, 5000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not attach to Chrome DevTools."));
    });
  });
}

export async function attachCdpPage(cdpUrl, wantUrl) {
  cdpUrl = ignorePlaceholder(cdpUrl) || defaultCdpUrl();
  let tabs;
  try {
    const res = await fetch(new URL("/json/list", cdpUrl));
    if (!res.ok) throw new Error("bad");
    tabs = await res.json();
  } catch {
    throw new Error(
      `No Chrome at ${cdpUrl}. Start Chrome with --remote-debugging-port=9222. Other browser automation (Playwright, computer-use) does not expose this port.`,
    );
  }
  let tab = pickTab(tabs, wantUrl);
  // Leave the agent's own tab alone: no tab on the login host means a new tab, not a redirect of whatever is in front.
  let fresh = false;
  if (wantUrl && !(tab && onHost(tab, wantUrl))) {
    const created = await newTab(cdpUrl, wantUrl);
    if (created) {
      tab = created;
      fresh = true;
    }
  }
  if (!tab?.webSocketDebuggerUrl) throw new Error("Chrome has no open tab.");

  const ws = await openWs(tab.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const waiters = new Map();
  const sessions = new Set();

  const call = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) return reject(new Error("Chrome DevTools socket is closed."));
      const id = ++nextId;
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error("Chrome DevTools call failed."));
        else resolve(msg.result);
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  // Tab closed or Chrome quit: fail every in-flight call instead of hanging login forever.
  ws.addEventListener("close", () => {
    for (const finish of pending.values()) finish({ error: "closed" });
    pending.clear();
  });

  const adoptSession = async (sessionId, targetType, waitingForDebugger) => {
    if (targetType === "iframe" || targetType === "page") {
      sessions.add(sessionId);
      try {
        await call("Page.enable", undefined, sessionId);
        await call("Runtime.enable", undefined, sessionId);
      } catch {
        sessions.delete(sessionId);
      }
    }
    if (waitingForDebugger) {
      try {
        await call("Runtime.runIfWaitingForDebugger", undefined, sessionId);
      } catch {
        /* ignore */
      }
    }
  };

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const finish = pending.get(msg.id);
      pending.delete(msg.id);
      finish(msg);
    }
    if (msg.method === "Target.attachedToTarget") {
      const { sessionId, targetInfo, waitingForDebugger } = msg.params ?? {};
      if (sessionId) void adoptSession(sessionId, targetInfo?.type, waitingForDebugger);
    }
    if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
      sessions.delete(msg.params.sessionId);
    }
    if (msg.method && waiters.has(msg.method)) {
      const queue = waiters.get(msg.method);
      waiters.delete(msg.method);
      for (const finish of queue) finish(msg.params);
    }
  });

  const waitForAny = (methods, ms) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (fired) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const method of methods) {
          const queue = waiters.get(method);
          if (!queue) continue;
          const next = queue.filter((fn) => fn !== onEvent);
          if (next.length) waiters.set(method, next);
          else waiters.delete(method);
        }
        resolve(fired);
      };
      const onEvent = () => finish(true);
      for (const method of methods) {
        const queue = waiters.get(method) ?? [];
        queue.push(onEvent);
        waiters.set(method, queue);
      }
      const timer = setTimeout(() => finish(false), ms);
    });

  // Frame that holds the current login step; set by the last `inspect`.
  let target = null;

  const runInFrame = async (sessionId, frameId, arg) => {
    let contextId;
    try {
      const world = await call("Page.createIsolatedWorld", { frameId, worldName: "authnudge" }, sessionId);
      contextId = world?.executionContextId;
    } catch {
      return null;
    }
    if (contextId == null) return null;
    const result = await call(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: `function (arg) { return (${loginFormOp.toString()})(arg); }`,
        arguments: [{ value: arg }],
        executionContextId: contextId,
        returnByValue: true,
        userGesture: true,
      },
      sessionId,
    );
    if (result?.exceptionDetails) return null;
    return result?.result?.value ?? null;
  };

  const eachFrame = async (arg) => {
    const results = [];
    const seen = new Set();
    for (const sessionId of [undefined, ...sessions]) {
      let frames = [];
      try {
        const { frameTree } = await call("Page.getFrameTree", undefined, sessionId);
        frames = flattenFrameTree(frameTree);
      } catch {
        continue;
      }
      for (const frame of frames) {
        if (!frame.id || seen.has(frame.id)) continue;
        seen.add(frame.id);
        try {
          const value = await runInFrame(sessionId, frame.id, arg);
          if (value != null) results.push({ sessionId, frameId: frame.id, value });
        } catch {
          /* navigation tore the context down */
        }
      }
    }
    return results;
  };

  await call("Page.enable");
  await call("Runtime.enable");
  for (const [method, params] of [
    ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }],
    // A background window has no focus; without this, focus() sticks but Input.insertText goes nowhere.
    ["Emulation.setFocusEmulationEnabled", { enabled: true }],
  ]) {
    try {
      await call(method, params);
    } catch {
      /* older chrome */
    }
  }
  // A new tab still shows its initial empty document; wait for the first commit so goto() sees the real URL and does not load twice.
  if (fresh) await waitForAny(["Page.frameNavigated", "Page.loadEventFired"], 15_000);

  return {
    async url() {
      try {
        const { frameTree } = await call("Page.getFrameTree");
        // A fresh tab's initial empty document reports ":" until the first commit; that is not a URL.
        if (/^[a-z][\w+.-]*:./i.test(frameTree?.frame?.url ?? "")) return frameTree.frame.url;
      } catch {
        /* fall through */
      }
      try {
        const result = await call("Runtime.evaluate", { expression: "location.href", returnByValue: true });
        if (result?.result?.value) return result.result.value;
      } catch {
        /* fall through */
      }
      return tab.url ?? "";
    },
    async goto(url) {
      if (samePage(await this.url(), url)) return;
      const loaded = waitForAny(["Page.loadEventFired", "Page.frameStoppedLoading"], 15_000);
      const nav = await call("Page.navigate", { url });
      // Fail here, before any envelope is taken, so the grant stays on the relay for a Chrome that can load the site.
      if (nav?.errorText) throw new Error(`Chrome could not load ${url} (${nav.errorText}).`);
      await loaded;
    },
    /** Sleep up to `ms`, waking early on navigation. Resolves true when something happened. */
    async waitForUpdate(ms) {
      return waitForAny(["Page.frameNavigated", "Page.loadEventFired", "Page.frameStoppedLoading"], ms);
    },
    /** Trusted text input into the focused field, like a paste. Input goes to the page session; Chrome routes it to the focused frame. */
    async insertText(text) {
      await call("Input.insertText", { text: String(text ?? "") });
    },
    async pressEnter() {
      const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await call("Input.dispatchKeyEvent", { type: "keyDown", text: "\r", unmodifiedText: "\r", ...key });
      await call("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    },
    /** `inspect` scans every frame and remembers the one with the form; `focus`/`submit` run there. */
    async op(arg) {
      if (arg.op === "inspect") {
        const hit = pickFormFrame(await eachFrame(arg));
        target = hit ? { sessionId: hit.sessionId, frameId: hit.frameId } : null;
        return hit?.value ?? { ok: true, password: false, identifier: false, otp: false };
      }
      if (!target) return { ok: false, reason: "no_field" };
      return (await runInFrame(target.sessionId, target.frameId, arg)) ?? { ok: false, reason: "no_field" };
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
