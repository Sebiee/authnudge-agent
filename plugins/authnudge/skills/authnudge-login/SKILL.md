---
name: authnudge-login
description: Logs an agent into a site via Authnudge phone grant. Use when signing into a site the user owns without a password in chat. Covers asking for a handle, generating a requester key pair, and filling DevTools Chrome.
---

# Authnudge login

You are a **requester**. The account holder approves a grant on their phone. Never ask for, type, or print a username or password (not in chat, not Playwright, not computer-use).

Their inbox accepts this agent only if:

- they set an **API key** (`an_…`) on the plugin, or
- they saved **this agent’s public key** at authnudge.com → **Access** → **Public keys**.

You cannot see plugin settings. Call **`publicKey`** first. That tool generates a P-256 key pair once, stores the private key on this machine, and returns only the public SPKI (base64) plus `toConfigured` / `apiKeyConfigured`. **Never print, copy, or ask for the private key.** The tool does not return it.

`login` fills **Chrome with remote debugging** (`http://127.0.0.1:9222`). Playwright and other automation use a different Chrome and stay logged out.

## Setup (before `login`)

1. Call **`publicKey`**. This is how the key pair is created. Show the user the `publicKey` value when pairing; do not paraphrase it.
2. **Handle.** If `toConfigured` is false and you do not already know their Authnudge handle or email, ask. Prefer a host question tool if one exists. Never ask for a password or API secret in that prompt.
3. **Pair** (skip if `apiKeyConfigured` is true). Tell them to open authnudge.com → Access → Public keys, enter any Name, paste the `publicKey` string into **Public key** (placeholder: “P-256 SPKI, base64”), and Save. Wait until they confirm it is saved.
4. Then Login.

## Login

1. Call `login` with `{ "url": "<login URL>", "to": "<handle or email>" }`. Always pass `to` unless `toConfigured` was true. Always pass `url` unless that DevTools Chrome is already on the login page. Do not try to guess the login page, but rather make sure you first identify it correctly.
2. Wait. Their phone gets a push; they submit Authnudge’s grant form. If the site then asks for a one-time code, `login` asks them and fills that too. Never print the code.
3. `{ "ok": true }` — continue in that DevTools Chrome. `expired` / `no_form` / `error` — stop and report that status. `otp` — the site wants a one-time code that Authnudge could not request; tell the user to type it in that Chrome window, never in chat.
4. If `login` returns `status: "pairing"` with a `publicKey`, they have not saved this key yet. Show that same `publicKey` again; do not generate a new one in chat.

Depending on the user's request nature, chrome might already be started with debug port 9222, or you should start it yourself with `--remote-debugging-port=9222` (or pass `cdpUrl`).

If the authnudge tools are missing, they need the Authnudge Cursor plugin (Customize → Plugins) and push enabled on the Authnudge PWA.
