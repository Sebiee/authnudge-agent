#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loginCdp } from "./login.mjs";

function readVersion() {
  for (const name of ["./package.json", "./.cursor-plugin/plugin.json"]) {
    try {
      const version = JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")).version;
      if (version) return version;
    } catch {
      /* try next */
    }
  }
  return "0.0.0";
}

const version = readVersion();

const TOOL = {
  name: "login",
  description:
    "Ask the Authnudge account holder to grant site credentials on their phone, then fill the login form in Chrome with remote debugging (default http://127.0.0.1:9222). Does not fill Playwright, computer-use, or other browser-automation tabs — those are a different Chrome. Never returns usernames or passwords. Pass `to` (Authnudge email or handle); ask the user if unknown. AUTHNUDGE_API_KEY is optional; if omitted, login returns status pairing with a publicKey to save at authnudge.com → Access → Public keys, then retry. Start Chrome with --remote-debugging-port=9222 (or set AUTHNUDGE_CDP_URL / cdpUrl).",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Login page to open in the DevTools Chrome before filling, e.g. https://www.galaxus.ch/login",
      },
      to: {
        type: "string",
        description: "Authnudge email or handle. Ask the user if unknown. Optional AUTHNUDGE_TO env is a fallback.",
      },
      cdpUrl: {
        type: "string",
        description: "Chrome DevTools HTTP URL. Defaults to AUTHNUDGE_CDP_URL or http://127.0.0.1:9222.",
      },
    },
  },
};

let framing = null;
let buf = Buffer.alloc(0);

function write(msg) {
  const json = JSON.stringify(msg);
  if (framing === "lsp") {
    const body = Buffer.from(json, "utf8");
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
    return;
  }
  process.stdout.write(`${json}\n`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return;
  const { id, method, params } = msg;
  if (id === undefined) return;

  if (method === "initialize") {
    return reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "authnudge", version },
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: [TOOL] });
  if (method === "resources/list") return reply(id, { resources: [] });
  if (method === "prompts/list") return reply(id, { prompts: [] });
  if (method === "tools/call") {
    if (params?.name !== "login") return fail(id, -32601, "Unknown tool");
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    let result;
    try {
      result = await loginCdp({
        url: typeof args.url === "string" ? args.url : undefined,
        to: typeof args.to === "string" ? args.to : undefined,
        cdpUrl: typeof args.cdpUrl === "string" ? args.cdpUrl : undefined,
      });
    } catch {
      result = { ok: false, status: "error" };
    }
    const text = JSON.stringify(result);
    return reply(id, { content: [{ type: "text", text }], isError: !result.ok });
  }
  return fail(id, -32601, "Method not found");
}

function takeLsp() {
  const crlf = buf.indexOf("\r\n\r\n");
  const lf = buf.indexOf("\n\n");
  const sep = crlf >= 0 ? crlf : lf;
  const seplen = crlf >= 0 ? 4 : lf >= 0 ? 2 : 0;
  if (sep < 0) return null;
  const header = buf.subarray(0, sep).toString("ascii");
  const match = header.match(/Content-Length:\s*(\d+)/i);
  if (!match) return null;
  const len = Number(match[1]);
  if (buf.length < sep + seplen + len) return null;
  const body = buf.subarray(sep + seplen, sep + seplen + len).toString("utf8");
  buf = Buffer.from(buf.subarray(sep + seplen + len));
  return JSON.parse(body);
}

function takeNl() {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return null;
  let line = buf.subarray(0, nl).toString("utf8");
  buf = Buffer.from(buf.subarray(nl + 1));
  if (line.endsWith("\r")) line = line.slice(0, -1);
  if (!line) return undefined;
  return JSON.parse(line);
}

function takeMessage() {
  if (!buf.length) return null;
  const peek = buf.toString("ascii", 0, Math.min(buf.length, 20)).replace(/^\s+/, "");
  const lsp = framing === "lsp" || /^Content-Length:/i.test(peek);
  if (lsp) {
    const msg = takeLsp();
    if (msg) framing = "lsp";
    return msg;
  }
  try {
    const msg = takeNl();
    if (msg) framing = "nl";
    return msg;
  } catch {
    return undefined;
  }
}

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    let msg;
    try {
      msg = takeMessage();
    } catch {
      break;
    }
    if (msg === null) break;
    if (msg === undefined) continue;
    void handle(msg);
  }
});

process.stdin.resume();
