import assert from "node:assert/strict";
import { flattenFrameTree, pickFormFrame, pickTab, samePage } from "./cdp.mjs";

const galaxus = { type: "page", url: "https://www.galaxus.ch/login", webSocketDebuggerUrl: "ws://g" };
const shop = { type: "page", url: "https://www.galaxus.ch/de/s1/product/1", webSocketDebuggerUrl: "ws://s" };
const other = { type: "page", url: "https://example.com/", webSocketDebuggerUrl: "ws://e" };
const blank = { type: "page", url: "chrome://newtab/", webSocketDebuggerUrl: "ws://n" };
const iframe = { type: "iframe", url: "https://www.galaxus.ch/login", webSocketDebuggerUrl: "ws://i" };

assert.equal(pickTab([other, galaxus, shop], "https://www.galaxus.ch/login"), galaxus);
assert.equal(pickTab([other, shop], "https://www.galaxus.ch/login"), shop);
assert.equal(pickTab([blank, other, shop], "https://news.ycombinator.com/login"), other);
assert.equal(pickTab([iframe, galaxus], "https://www.galaxus.ch/login"), galaxus);
assert.equal(pickTab([blank], undefined), blank);
assert.equal(pickTab([], "https://www.galaxus.ch/login"), null);

assert.equal(samePage("https://www.galaxus.ch/login?x=1", "https://www.galaxus.ch/login"), true);
assert.equal(samePage("https://www.galaxus.ch/de/login", "https://www.galaxus.ch/login"), false);

assert.deepEqual(
  flattenFrameTree({
    frame: { id: "root", url: "https://www.galaxus.ch/login" },
    childFrames: [{ frame: { id: "child", url: "https://www.galaxus.ch/widget" } }],
  }).map((frame) => frame.id),
  ["root", "child"],
);

const ad = { frameId: "ad", value: { ok: false, reason: "wrong_origin" } };
const footer = { frameId: "footer", value: { ok: true, identifier: true } };
const form = { frameId: "form", value: { ok: true, password: true, identifier: true } };
assert.equal(pickFormFrame([ad, footer, form]), form);
assert.equal(pickFormFrame([ad, footer]), footer);
assert.equal(pickFormFrame([ad, { frameId: "x", value: { ok: true } }]), null);
assert.equal(pickFormFrame([]), null);

console.log("authnudge cdp check ok");
