import { useState } from "react";

// Same rules as password_problems() in backend/app/auth.py
const RULES = [
  { id: "length", label: "At least 8 characters", test: (p) => p.length >= 8 },
  { id: "lower", label: "A lowercase letter", test: (p) => /[a-z]/.test(p) },
  { id: "upper", label: "An uppercase letter", test: (p) => /[A-Z]/.test(p) },
  { id: "number", label: "A number", test: (p) => /\d/.test(p) },
  { id: "symbol", label: "A symbol (e.g. ! @ # $)", test: (p) => /[^A-Za-z0-9]/.test(p) },
];
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwerty123", "qwertyuiop", "11111111", "iloveyou", "admin123", "welcome1",
  "letmein1", "abc12345", "p@ssw0rd", "passw0rd",
]);
const LEVELS = ["", "Weak", "Fair", "Good", "Strong"];

export function checkPassword(password, { username = "", email = "" } = {}) {
  const passed = RULES.filter((r) => r.test(password)).map((r) => r.id);
  const lowered = password.toLowerCase();
  const name = username.trim().toLowerCase();
  const local = email.trim().toLowerCase().split("@")[0];
  const containsName = name.length >= 3 && lowered.includes(name);
  const containsEmail = local.length >= 3 && lowered.includes(local);
  const isCommon = COMMON_PASSWORDS.has(lowered);

  let score = 0; // 0 = nothing typed, 1..4 = Weak..Strong
  if (password) {
    if (passed.length <= 2) score = 1;
    else if (passed.length < RULES.length) score = 2;
    else score = password.length >= 12 ? 4 : 3;
    if (containsName || containsEmail || isCommon) score = 1;
  }
  return {
    passed, containsName, containsEmail, isCommon, score,
    valid: passed.length === RULES.length && !containsName && !containsEmail && !isCommon && password.length <= 128,
  };
}

// Password box with Show/Hide and a Caps Lock warning
export function PasswordInput({ value, onChange, autoComplete, autoFocus, placeholder, id }) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const trackCaps = (e) => setCapsLock(e.getModifierState?.("CapsLock") ?? false);

  return (
    <>
      <div className="password-input">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={trackCaps}
          onKeyUp={trackCaps}
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          placeholder={placeholder}
          maxLength={128}
        />
        <button type="button" className="reveal" onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}>
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {capsLock && <small className="caps-warning">Caps Lock is on</small>}
    </>
  );
}

// Live strength bar + checklist
export function PasswordStrength({ password, username, email }) {
  const s = checkPassword(password, { username, email });
  return (
    <div className="strength" aria-live="polite">
      <div className={`strength-bar level-${s.score}`}>
        {[1, 2, 3, 4].map((i) => <span key={i} className={i <= s.score ? "on" : ""} />)}
      </div>
      <div className="strength-label">
        Strength: <b>{password ? LEVELS[s.score] : "—"}</b>
        {s.score === 3 && <span className="muted"> · 12+ characters makes it strong</span>}
      </div>
      <ul className="rules">
        {RULES.map((r) => <li key={r.id} className={s.passed.includes(r.id) ? "ok" : ""}>{r.label}</li>)}
        {s.containsName && <li className="bad">Must not contain your username</li>}
        {s.containsEmail && <li className="bad">Must not contain your email address</li>}
        {s.isCommon && <li className="bad">Too common — choose something else</li>}
      </ul>
    </div>
  );
}
