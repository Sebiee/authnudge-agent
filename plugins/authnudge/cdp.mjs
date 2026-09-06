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

export function foldFillResults(results) {
  const list = (results ?? []).filter(Boolean);
  if (list.some((item) => item.ok)) return { ok: true };
  if (list.some((item) => item.reason === "need_password")) return { ok: false, reason: "need_password" };
  if (list.some((item) => item.reason === "no_form")) return { ok: false, reason: "no_form" };
  if (list.some((item) => item.reason === "wrong_origin")) return { ok: false, reason: "wrong_origin" };
  return { ok: false, reason: "need_password" };
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
  const tab = pickTab(tabs, wantUrl);
  if (!tab?.webSocketDebuggerUrl) throw new Error("Chrome has no open tab.");

  const ws = await openWs(tab.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const waiters = new Map();
  const sessions = new Set();

  const call = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error("Chrome DevTools call failed."));
        else resolve(msg.result);
      });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
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
      const finish = () => {
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
        resolve();
      };
      const onEvent = () => finish();
      for (const method of methods) {
        const queue = waiters.get(method) ?? [];
        queue.push(onEvent);
        waiters.set(method, queue);
      }
      const timer = setTimeout(finish, ms);
    });

  const evaluateInFrame = async (sessionId, frameId, fn, arg) => {
    let contextId;
    if (frameId) {
      try {
        const world = await call("Page.createIsolatedWorld", { frameId, worldName: "authnudge" }, sessionId);
        contextId = world?.executionContextId;
      } catch {
        return null;
      }
    }
    const result = await call(
      "Runtime.evaluate",
      {
        expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
        awaitPromise: true,
        returnByValue: true,
        ...(contextId ? { contextId } : {}),
      },
      sessionId,
    );
    if (result?.exceptionDetails) return null;
    return result?.result?.value ?? null;
  };

  await call("Page.enable");
  await call("Runtime.enable");
  try {
    await call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  } catch {
    /* older chrome */
  }

  return {
    async url() {
      try {
        const { frameTree } = await call("Page.getFrameTree");
        if (frameTree?.frame?.url) return frameTree.frame.url;
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
      await call("Page.navigate", { url });
      await loaded;
    },
    async waitForUpdate(ms) {
      await waitForAny(["Page.frameNavigated", "Page.loadEventFired", "Page.frameStoppedLoading"], ms);
    },
    async evaluate(fn, arg) {
      const results = [];
      const seen = new Set();
      for (const sessionId of [undefined, ...sessions]) {
        let frames = [];
        try {
          const { frameTree } = await call("Page.getFrameTree", undefined, sessionId);
          frames = flattenFrameTree(frameTree);
        } catch {
          frames = [{ id: null }];
        }
        for (const frame of frames) {
          const key = frame.id ?? `session:${sessionId ?? "main"}`;
          if (seen.has(key)) continue;
          try {
            const value = await evaluateInFrame(sessionId, frame.id, fn, arg);
            if (value == null) continue;
            seen.add(key);
            results.push(value);
          } catch {
            /* navigation tore the context down — retry above */
          }
        }
      }
      return foldFillResults(results);
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
