// Self-contained: chrome.scripting.executeScript serializes this function.
// Return status only — never field values.
// Hosts inject this per frame (extension allFrames / CDP frame tree). Cross-host iframes stay isolated.
export async function fillLoginForm(identifier, secret, expectedOrigin, waitMs = 15000) {
  // page.evaluate-style hosts only pass one argument.
  let op;
  let kind;
  if (identifier !== null && typeof identifier === "object" && !Array.isArray(identifier)) {
    ({ identifier, secret, expectedOrigin, waitMs = 15000, op, kind } = identifier);
  }
  const hostOf = (tabUrl) => {
    let url;
    try {
      url = new URL(tabUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    return `${url.protocol}//${url.host.toLowerCase()}`;
  };
  const sameHost = () => {
    if (!expectedOrigin) return true;
    const right = hostOf(expectedOrigin);
    if (!right) return true;
    if (hostOf(location.href) === right) return true;
    try {
      return hostOf(window.top.location.href) === right;
    } catch {
      return false;
    }
  };

  if (!sameHost()) return { ok: false, reason: "wrong_origin" };

  const visible = (el) => {
    if (!el || el.disabled) return false;
    if (el.type === "hidden") return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  };

  const write = (el, value) => {
    el.focus();
    const tracker = el._valueTracker;
    if (tracker && typeof tracker.setValue === "function") tracker.setValue("");
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertFromPaste", data: value }));
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const hint = (el) =>
    `${el.autocomplete || ""} ${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("inputmode") || ""}`.toLowerCase();

  const scoreIdentifier = (el) => {
    const type = (el.type || "text").toLowerCase();
    const text = hint(el);
    if (type === "email" || text.includes("email")) return 4;
    if (text.includes("username") || text.includes("user")) return 3;
    if (/(^|[^a-z])(login|identifier|acct|account)([^a-z]|$)/.test(text)) return 2;
    return 1;
  };

  const identifiers = () =>
    [...document.querySelectorAll("input")].filter((el) => {
      if (!visible(el)) return false;
      const type = (el.type || "text").toLowerCase();
      if (["password", "hidden", "submit", "button", "checkbox", "radio", "file", "reset", "image", "search"].includes(type)) {
        return false;
      }
      const text = hint(el);
      if (text.includes("search") || text.includes("suche") || text.includes("recherch")) return false;
      return ["email", "text", "tel", "url"].includes(type);
    });

  const passwords = () =>
    [...document.querySelectorAll("input[type=password]")].filter((el) => {
      if (!visible(el)) return false;
      return !hint(el).includes("new-password");
    });

  const pickIdentifier = (scope, passwordEl) => {
    const nodes = identifiers().filter((el) => (!scope || scope.contains(el)) && el !== passwordEl);
    if (!nodes.length) return null;
    const before = passwordEl
      ? nodes.filter((el) => passwordEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)
      : nodes;
    const pool = before.length ? before : nodes;
    let best = pool[0];
    for (const el of pool) {
      if (scoreIdentifier(el) >= scoreIdentifier(best)) best = el;
    }
    return best;
  };

  const wipePassword = (el) => {
    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    if (desc?.set) desc.set.call(el, "");
    else el.value = "";
  };

  const submitForm = (form) => {
    if (form) {
      const submit =
        form.querySelector("button[type=submit], input[type=submit]") || form.querySelector("button:not([type])");
      if (submit && visible(submit) && !submit.disabled) {
        submit.click();
        return true;
      }
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
        return true;
      }
    }
    const next = [...document.querySelectorAll("button, input[type=submit], [role=button]")].find((el) => {
      if (!visible(el) || el.disabled) return false;
      return /^(continue|next|log\s*in|sign\s*in|submit|anmelden|weiter|se connecter|connexion|continuer|accedi|avanti)$/i.test(
        (el.textContent || el.value || "").trim(),
      );
    });
    if (next) {
      next.click();
      return true;
    }
    return false;
  };

  const submitThenWipe = async (form, passwordEl) => {
    const formEl = form || passwordEl.form;
    submitForm(formEl);
    // ponytail: give the page a macrotask to read the field; queueMicrotask wiped before Galaxus's submit handler.
    await new Promise((resolve) => setTimeout(resolve, 50));
    wipePassword(passwordEl);
  };

  const focusField = (which) => {
    const passwordEl = passwords()[0];
    const el = which === "password" ? passwordEl : pickIdentifier(passwordEl?.form ?? document, passwordEl ?? null);
    if (!el) return { ok: false, reason: which === "password" ? "need_password" : "no_form" };
    el.focus();
    if (typeof el.select === "function") el.select();
    return { ok: true };
  };

  if (op === "inspect") {
    if (!sameHost()) return { ok: false, reason: "wrong_origin" };
    const pwd = passwords();
    if (pwd.length > 1) return { ok: false, reason: "no_form" };
    return {
      ok: true,
      password: pwd.length === 1,
      identifier: Boolean(pickIdentifier(pwd[0]?.form ?? document, pwd[0] ?? null)),
    };
  }
  if (op === "focus") {
    if (!sameHost()) return { ok: false, reason: "wrong_origin" };
    return focusField(kind);
  }
  if (op === "submit") {
    if (!sameHost()) return { ok: false, reason: "wrong_origin" };
    const passwordEl = passwords()[0];
    const userEl = pickIdentifier(passwordEl?.form ?? document, passwordEl ?? null);
    return { ok: submitForm(passwordEl?.form || userEl?.form) };
  }

  const waitForPassword = (ms) =>
    new Promise((resolve) => {
      const finish = (value) => {
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        if (!sameHost()) return finish(null);
        const found = passwords();
        if (found.length === 1) return finish(found[0]);
        if (found.length > 1) return finish(null);
      };
      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      const timer = setTimeout(() => finish(passwords().length === 1 ? passwords()[0] : null), ms);
      check();
    });

  const pwdFields = passwords();
  if (pwdFields.length > 1) return { ok: false, reason: "no_form" };

  if (pwdFields.length === 1) {
    const passwordEl = pwdFields[0];
    const userEl = pickIdentifier(passwordEl.form ?? document, passwordEl);
    if (userEl) write(userEl, identifier);
    write(passwordEl, secret);
    await submitThenWipe(passwordEl.form, passwordEl);
    return { ok: true };
  }

  const userEl = pickIdentifier(document, null);
  if (!userEl) return { ok: false, reason: "no_form" };

  write(userEl, identifier);
  submitForm(userEl.form);

  const passwordEl = await waitForPassword(waitMs);
  if (!sameHost()) return { ok: false, reason: "wrong_origin" };
  if (!passwordEl) return { ok: false, reason: "need_password" };

  write(passwordEl, secret);
  await submitThenWipe(passwordEl.form, passwordEl);
  return { ok: true };
}
