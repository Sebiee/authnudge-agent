#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fillCdp, loginCdp, publicKeyInfo } from "./login.mjs";

function readVersion() {
  for (const name of ["./package.json", "./.cursor-plugin/plugin.json", "../../package.json"]) {
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

const URL_ARG = {
  type: "string",
  description:
    "Copied from the live Chrome tab after you clicked Sign in, on the page that already shows the email/password form. Never invent /login, /signin, or /ap/signin.",
};
const CDP_ARG = {
  type: "string",
  description:
    "Chrome DevTools HTTP URL of the browser you work in. Loopback only (127.0.0.1, localhost, or [::1]). Required unless AUTHNUDGE_CDP_URL is set. No default port. Userinfo and non-loopback hosts are rejected.",
};

const TOOLS = [
  {
    name: "publicKey",
    description:
      "Call first. Creates (once) or returns this agent's requester public key as P-256 SPKI base64: pass it as requesterPublicKey to plugin-authnudge-authnudge `login` with origin copied from the live Sign-in form tab (never a guessed /login), then call plugin-authnudge-authnudge-chrome `fill` with that result. The matching private key is stored on this machine and is never returned. Also returns booleans toConfigured / apiKeyConfigured (not the secret values) for the fallback `loginFallback` tool here.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "fill",
    description:
      "Preferred. `url` is copied from the live Sign-in form tab (never invent /login). After plugin-authnudge-authnudge `login` opened a request with this agent's publicKey, wait for the phone grant and fill the login form in Chrome with remote debugging. The phone is pushed on this tool's first poll after a login form is on screen — not at remote `login`. Pass requestId, claimToken, expiresAt (ISO, copied from login), and cdpUrl (loopback DevTools URL of the browser you work in; required unless AUTHNUDGE_CDP_URL is set; no default port). Returns within ~25s: `{ ok: true }`, a final status, or `status: \"waiting\"` — then call fill again with the same arguments (the request stays open until expiresAt). Never call remote `login` again for the same site while a request is open. Stays if the site asks for a one-time code. Fills whichever Chrome cdpUrl points at: give it the browser you work in (find its --remote-debugging-port first), not a separate one. Results echo cdpUrl; a repeat call with a different cdpUrl restarts the fill there without losing the grant. Opens the login URL in a new tab unless one is already on that site. `status: \"fulfilled\"` means the request was already used; check the tab, it is probably signed in. Never returns usernames, passwords, codes, or the requester private key.",
    inputSchema: {
      type: "object",
      properties: {
        url: URL_ARG,
        requestId: { type: "string", description: "requestId from the Authnudge `login` tool result." },
        claimToken: { type: "string", description: "claimToken from the Authnudge `login` tool result." },
        expiresAt: { type: "string", description: "ISO expiresAt from the Authnudge `login` tool result. Required. Copy it; do not invent a deadline." },
        cdpUrl: CDP_ARG,
      },
      required: ["url", "requestId", "claimToken", "expiresAt"],
    },
  },
  {
    name: "loginFallback",
    description:
      "Fallback when plugin-authnudge-authnudge is not connected. Creates the phone-grant request here (after a login form is on screen) and fills Chrome with remote debugging. Pass the live Sign-in form url (never invent /login) and cdpUrl (loopback; required unless AUTHNUDGE_CDP_URL is set). Needs `to` (Authnudge email or handle) unless AUTHNUDGE_TO is set, and either AUTHNUDGE_API_KEY or this agent's publicKey saved at authnudge.com → Access → Public keys. Returns within ~25s; on `status: \"waiting\"` call loginFallback again with the same arguments (it reattaches, no second push). Same filling and secrecy rules as `fill`.",
    inputSchema: {
      type: "object",
      properties: {
        url: URL_ARG,
        to: {
          type: "string",
          description: "Authnudge email or handle. Omit when toConfigured / AUTHNUDGE_TO is set; do not ask for a handle then. Ask only if unknown and toConfigured is false.",
        },
        cdpUrl: CDP_ARG,
      },
      required: ["url"],
    },
  },
];

const str = (value) => (typeof value === "string" ? value : undefined);

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
      instructions:
        "url and origin are the live Sign-in form tab, copied after clicking Sign in. Never invent /login, /signin, or /ap/signin. This server is plugin-authnudge-authnudge-chrome (`publicKey`, `fill`, `loginFallback`). Remote OAuth login is plugin-authnudge-authnudge `login`.",
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") return reply(id, { tools: TOOLS });
  if (method === "resources/list") return reply(id, { resources: [] });
  if (method === "prompts/list") return reply(id, { prompts: [] });
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    let result;
    try {
      if (name === "publicKey") result = await publicKeyInfo();
      else if (name === "fill") {
        result = await fillCdp({
          url: str(args.url),
          requestId: str(args.requestId),
          claimToken: str(args.claimToken),
          expiresAt: typeof args.expiresAt === "number" ? args.expiresAt : str(args.expiresAt),
          cdpUrl: str(args.cdpUrl),
        });
      } else if (name === "loginFallback") {
        result = await loginCdp({ url: str(args.url), to: str(args.to), cdpUrl: str(args.cdpUrl) });
      } else return fail(id, -32601, "Unknown tool");
    } catch {
      result = { ok: false, status: "error" };
    }
    const text = JSON.stringify(result);
    const isError = name !== "publicKey" && result && result.ok === false && result.status !== "waiting";
    return reply(id, { content: [{ type: "text", text }], isError });
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
