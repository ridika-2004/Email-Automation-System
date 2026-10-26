import { useState } from "react";
import { cx, input } from "./ui";

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

const BAR = { 1: "bg-red-600", 2: "bg-amber-500", 3: "bg-green-500", 4: "bg-green-700" };

// Password box with Show/Hide and a Caps Lock warning. className: classes for the input box.
export function PasswordInput({ value, onChange, autoComplete, autoFocus, placeholder, id, className = input }) {
  const [visible, setVisible] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const trackCaps = (e) => setCapsLock(e.getModifierState?.("CapsLock") ?? false);

  return (
    <>
      <div className="relative">
        <input
          id={id}
          className={cx(className, "!pr-16")}
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
        <button type="button"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-2 py-1.5 text-xs font-semibold text-muted hover:bg-gray-100 hover:text-ink"
          onClick={() => setVisible((v) => !v)} aria-label={visible ? "Hide password" : "Show password"}>
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {capsLock && <small className="font-normal text-amber-800">Caps Lock is on</small>}
    </>
  );
}

// Live strength bar + checklist
export function PasswordStrength({ password, username, email }) {
  const s = checkPassword(password, { username, email });
  // One checklist line: ✓ passed, ✕ problem, ○ not yet
  const Rule = ({ state = "", children }) => (
    <li className={cx("flex gap-1.5", state === "ok" && "text-green-700", state === "bad" && "col-span-full text-red-700")}>
      <span className="w-3 shrink-0" aria-hidden="true">{{ ok: "✓", bad: "✕" }[state] || "○"}</span>
      {children}
    </li>
  );
  return (
    <div className="-mt-1 flex flex-col gap-2 font-normal" aria-live="polite">
      <div className="grid grid-cols-4 gap-1">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={cx("h-1.5 rounded-sm transition-colors", i <= s.score ? BAR[s.score] : "bg-line")} />
        ))}
      </div>
      <div className="text-xs">
        Strength: <b>{password ? LEVELS[s.score] : "—"}</b>
        {s.score === 3 && <span className="text-muted"> · 12+ characters makes it strong</span>}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted max-[820px]:grid-cols-1">
        {RULES.map((r) => <Rule key={r.id} state={s.passed.includes(r.id) ? "ok" : ""}>{r.label}</Rule>)}
        {s.containsName && <Rule state="bad">Must not contain your username</Rule>}
        {s.containsEmail && <Rule state="bad">Must not contain your email address</Rule>}
        {s.isCommon && <Rule state="bad">Too common — choose something else</Rule>}
      </ul>
    </div>
  );
}
