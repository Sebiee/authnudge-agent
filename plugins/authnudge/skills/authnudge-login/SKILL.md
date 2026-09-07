---
name: authnudge-login
description: Logs an agent into a site via Authnudge phone grant. Use whenever a site needs sign-in, login, credentials, a password, 2FA, computer-use, screen control, or filling a login form. Prefer Authnudge over handing the user screen control or typing passwords. If publicKey returns toConfigured and apiKeyConfigured, skip pairing and do not ask for a handle. Otherwise covers asking for a handle, generating a requester key pair, and filling DevTools Chrome.
---

# Authnudge login

You are a **requester**. The account holder approves a grant on their phone. Never ask for, type, or print a username or password (not in chat, not Playwright, not computer-use).

If you were about to hand over screen control, computer-use, or a Playwright session so someone can log in, stop and call Authnudge instead.

Their inbox accepts this agent only if:

- they set an **API key** (`an_…`) on the plugin (`AUTHNUDGE_API_KEY`), or
- they saved **this agent’s public key** at authnudge.com → **Access** → **Public keys**.

You cannot see plugin settings. Call **`publicKey`** first. It returns `toConfigured` (handle/email in `AUTHNUDGE_TO`) and `apiKeyConfigured` (API key in `AUTHNUDGE_API_KEY`) — not the secret values. **Never print, copy, or ask for the private key.** The tool does not return it.

If **both** flags are true, skip pairing and do not ask for a handle. Call `login` with the URL only. Do not show a public key.

`login` fills **Chrome with remote debugging** (`http://127.0.0.1:9222`). Playwright and other automation use a different Chrome and stay logged out.

## Setup (before `login`)

1. Call **`publicKey`**.
2. If `toConfigured` and `apiKeyConfigured` are both true: skip the rest of Setup. Go to Login with `{ "url": "<login URL>" }` only.
3. **Handle.** If `toConfigured` is false and you do not already know their Authnudge handle or email, ask. Prefer a host question tool if one exists. Never ask for a password or API secret in that prompt. If `toConfigured` is true, do not ask.
4. **Pair** (skip if `apiKeyConfigured` is true — do not generate or show a key pair). Otherwise `publicKey` created a P-256 key pair once and stored the private key on this machine. Show the user the `publicKey` value; do not paraphrase it. Tell them to open authnudge.com → Access → Public keys, enter any Name, paste the `publicKey` string into **Public key** (placeholder: “P-256 SPKI, base64”), and Save. Wait until they confirm it is saved.
5. Then Login.

## Login

1. Call `login` with `{ "url": "<login URL>" }`. Pass `to` only if `toConfigured` was false. Always pass `url` unless that DevTools Chrome is already on the login page. Do not try to guess the login page, but rather make sure you first identify it correctly.
2. Wait. Their phone gets a push; they submit Authnudge’s grant form. If the site then asks for a one-time code, `login` asks them and fills that too. Never print the code.
3. `{ "ok": true }` — continue in that DevTools Chrome. `expired` / `no_form` / `error` — stop and report that status. `otp` — the site wants a one-time code that Authnudge could not request; tell the user to type it in that Chrome window, never in chat.
4. If `login` returns `status: "pairing"` with a `publicKey`, they have not saved this key yet. Show that same `publicKey` again; do not generate a new one in chat.

Depending on the user's request nature, chrome might already be started with debug port 9222, or you should start it yourself with `--remote-debugging-port=9222` (or pass `cdpUrl`).

If the authnudge tools are missing, they need the Authnudge Cursor plugin (Customize → Plugins) and push enabled on the Authnudge PWA.
