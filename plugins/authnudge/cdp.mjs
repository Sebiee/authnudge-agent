import { ignorePlaceholder } from "./origin.js";

export function defaultCdpUrl() {
  return ignorePlaceholder(process.env.AUTHNUDGE_CDP_URL) || "http://127.0.0.1:9222";
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

export async function attachCdpPage(cdpUrl) {
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
  const pages = (Array.isArray(tabs) ? tabs : []).filter((tab) => tab?.type === "page");
  const tab = pages.find((item) => /^https?:/i.test(item.url ?? "")) ?? pages[0];
  if (!tab?.webSocketDebuggerUrl) throw new Error("Chrome has no open tab.");

  const ws = await openWs(tab.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const waiters = new Map();
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
    if (msg.method && waiters.has(msg.method)) {
      const queue = waiters.get(msg.method);
      waiters.delete(msg.method);
      for (const finish of queue) finish(msg.params);
    }
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (msg) => {
        if (msg.error) reject(new Error("Chrome DevTools call failed."));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const once = (method) =>
    new Promise((resolve) => {
      const queue = waiters.get(method) ?? [];
      queue.push(resolve);
      waiters.set(method, queue);
    });

  return {
    async url() {
      const result = await call("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      return result?.result?.value ?? tab.url ?? "";
    },
    async goto(url) {
      await call("Page.enable");
      const loaded = once("Page.loadEventFired");
      await call("Page.navigate", { url });
      await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, 15000))]);
    },
    async evaluate(fn, arg) {
      const result = await call("Runtime.evaluate", {
        expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result?.exceptionDetails) throw new Error("Fill script failed.");
      return result?.result?.value;
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
