// Runs inside the page (one isolated world per frame). Never receives or returns field values:
// the host types with Chrome's Input.insertText, this only finds, focuses, and submits.
export function loginFormOp({ op, kind, index = 0, expectedOrigin }) {
  const hostOf = (value) => {
    try {
      const url = new URL(value);
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
      return `${url.protocol}//${url.host.toLowerCase()}`;
    } catch {
      return null;
    }
  };
  const want = hostOf(expectedOrigin);
  if (want && hostOf(location.href) !== want) {
    let top = null;
    try {
      top = hostOf(window.top.location.href);
    } catch {
      /* cross-origin frame */
    }
    if (top !== want) return { ok: false, reason: "wrong_origin" };
  }

  const visible = (el) => {
    if (!el || el.disabled || el.readOnly || el.type === "hidden" || el.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 2 && rect.height >= 2;
  };
  const hint = (el) =>
    `${el.autocomplete || ""} ${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("inputmode") || ""} ${el.getAttribute("aria-label") || ""} ${[...(el.labels ?? [])].map((l) => l.textContent).join(" ")}`
      .replace(/\s+/g, " ")
      .toLowerCase();
  const inputs = () => [...document.querySelectorAll("input")].filter(visible);
  const NOT_TEXT = ["password", "hidden", "submit", "button", "checkbox", "radio", "file", "reset", "image", "search"];

  const looksLikeOtp = (el) => {
    const type = (el.type || "text").toLowerCase();
    const text = hint(el);
    const max = Number(el.maxLength);
    const numeric = (el.getAttribute("inputmode") || "").toLowerCase() === "numeric" || type === "tel" || type === "number";
    // One character per box (maxlength=1 or pattern like [0-9]{1}): only ever a code.
    if (max === 1 || /^(\[0-9\]|\\d)(\{1\})?$/.test(el.getAttribute("pattern") || "")) return true;
    if ((el.autocomplete || "").toLowerCase() === "one-time-code") return true;
    if (numeric && max >= 4 && max <= 8) return true;
    if (/(^|[^a-z])(otp|totp|2fa|mfa|code)([^a-z]|$)/.test(text)) return true;
    return /(verification code|one[- ]time|security code|login code|auth code|einmalcode)/.test(text);
  };
  // One code field, or 4–8 one-character boxes (Galaxus: six type=tel name="otp-code" boxes, no maxlength).
  const otpBoxes = () => {
    const list = inputs().filter((el) => !NOT_TEXT.includes((el.type || "text").toLowerCase()) && looksLikeOtp(el));
    return list.length === 1 || (list.length >= 4 && list.length <= 8) ? list : [];
  };

  const passwords = () => inputs().filter((el) => el.type === "password" && !hint(el).includes("new-password"));

  const scoreIdentifier = (el) => {
    const type = (el.type || "text").toLowerCase();
    const text = hint(el);
    const auto = (el.autocomplete || "").toLowerCase();
    if (auto === "username" || auto === "email") return 5;
    if (type === "email" || text.includes("email") || text.includes("e-mail")) return 4;
    if (text.includes("username") || text.includes("user")) return 3;
    if (/(^|[^a-z])(login|identifier|acct|account)([^a-z]|$)/.test(text)) return 2;
    return 1;
  };
  const pickIdentifier = (scope, passwordEl) => {
    const nodes = inputs().filter((el) => {
      const type = (el.type || "text").toLowerCase();
      if (NOT_TEXT.includes(type) || !["email", "text", "tel", "url"].includes(type)) return false;
      if (el === passwordEl || !scope.contains(el) || looksLikeOtp(el)) return false;
      return !/search|suche|recherch/.test(hint(el));
    });
    if (!nodes.length) return null;
    const before = passwordEl ? nodes.filter((el) => passwordEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) : nodes;
    const pool = before.length ? before : nodes;
    let best = pool[0];
    for (const el of pool) if (scoreIdentifier(el) > scoreIdentifier(best)) best = el;
    return best;
  };

  const field = (which) => {
    if (which === "otp") return otpBoxes()[index] ?? null;
    const pwd = passwords();
    const passwordEl = pwd.length === 1 ? pwd[0] : null;
    if (which === "password") return passwordEl;
    return pickIdentifier(passwordEl?.form ?? document, passwordEl);
  };

  const controls = (root) =>
    [...root.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")].filter((el) => visible(el));
  const label = (el) => (el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const looksLikeSubmit = (el) => {
    const text = label(el);
    if (!text || text.length > 48) return false;
    if (/google|apple|facebook|microsoft|github|passkey|forgot|vergessen|oubli|register|registr|sign\s*up|resend|neuen? code|renvoyer|cancel|abbrechen/i.test(text)) {
      return false;
    }
    return /continue|next|log\s*in|sign\s*in|submit|verify|confirm|anmelden|weiter|best[äa]tigen|se connecter|connexion|continuer|accedi|avanti|entrar|siguiente/i.test(
      text,
    );
  };
  // Browser order first: the form's default button is what Enter would press. Never guess a lone
  // button (Galaxus's code form only has "Neuen Code senden").
  const findSubmit = (el) => {
    const form = el.form ?? el.closest("form");
    if (form) {
      const list = controls(form);
      return (
        list.find((b) => b.matches("button[type=submit], input[type=submit]")) ??
        list.find((b) => b.matches("button:not([type])")) ??
        list.find(looksLikeSubmit) ??
        null
      );
    }
    // Form-less (div) forms: nearest ancestor that holds a submit-looking control.
    let root = el;
    for (let i = 0; i < 8 && root.parentElement && root !== document.body; i++) {
      root = root.parentElement;
      const hit = controls(root).find(looksLikeSubmit);
      if (hit) return hit;
    }
    return null;
  };

  if (op === "inspect") {
    const pwd = passwords();
    const passwordEl = pwd.length === 1 ? pwd[0] : null;
    const identifierEl = pickIdentifier(passwordEl?.form ?? document, passwordEl);
    const otp = otpBoxes();
    return {
      ok: true,
      password: Boolean(passwordEl),
      passwordFilled: Boolean(passwordEl?.value),
      identifier: Boolean(identifierEl),
      identifierFilled: Boolean(identifierEl?.value),
      otp: otp.length > 0,
      otpBoxes: otp.length,
      otpFilled: otp.length > 0 && otp.every((el) => el.value),
    };
  }
  const el = field(kind);
  if (!el) return { ok: false, reason: "no_field" };
  if (op === "focus") {
    el.focus();
    try {
      el.select();
    } catch {
      /* not selectable */
    }
    return { ok: document.activeElement === el };
  }
  if (op === "click") {
    const button = findSubmit(el);
    if (!button) return { ok: false, reason: "no_button" };
    button.click();
    return { ok: true };
  }
  if (op === "requestSubmit") {
    const form = el.form ?? el.closest("form");
    if (!form || typeof form.requestSubmit !== "function") return { ok: false, reason: "no_form" };
    form.requestSubmit();
    return { ok: true };
  }
  return { ok: false, reason: "bad_op" };
}
