import { useEffect, useState } from "react";
import { api, auth } from "../api";
import { checkPassword, PasswordInput, PasswordStrength } from "../components/Password";

const USERNAME_RE = /^[a-z0-9._-]{3,30}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Reset links in emails look like  http://localhost:5173/?reset_token=...
function readResetToken() {
  return new URLSearchParams(window.location.search).get("reset_token");
}
function clearResetToken() {
  const url = new URL(window.location.href);
  url.searchParams.delete("reset_token");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

export default function AuthPage({ onSignedIn, notice: initialNotice }) {
  const [view, setView] = useState(() => (readResetToken() ? "reset" : "login")); // login | register | verify | forgot | reset
  const [pending, setPending] = useState(null); // { login, email, remember } while waiting for the emailed code
  const [settings, setSettings] = useState({ allow_registration: true, first_user: false, remember_me_days: 30 });
  const [notice, setNotice] = useState(initialNotice || "");
  const [backendDown, setBackendDown] = useState(false);

  useEffect(() => {
    api.authSettings()
      .then((s) => {
        setSettings(s);
        if (s.first_user && view === "login") setView("register");
      })
      .catch(() => setBackendDown(true));
  }, []);

  function go(next, message = "") {
    setView(next);
    setNotice(message);
  }

  const titles = {
    login: ["Welcome back", "Sign in to continue."],
    register: ["Create your account", "Use your real email address. We'll email you a code to sign in."],
    verify: ["Check your email", "Enter the 6-digit code we emailed you to finish signing in."],
    forgot: ["Forgot your password?", "Enter your account email and we'll send you a reset link."],
    reset: ["Choose a new password", "Pick a strong password you don't use anywhere else."],
  };

  return (
    <div className="auth-screen">
      <aside className="auth-brand">
        <div className="auth-logo" aria-hidden="true">N</div>
        <h1>NPSB Dispute Email Automation</h1>
        <p>Group unknown-response transactions by partner and request clarification by email.</p>
        <ul>
          <li>Upload the daily NPSB dispute file</li>
          <li>Review transactions grouped by partner</li>
          <li>Preview, edit and send one email per partner</li>
        </ul>
      </aside>

      <main className="auth-panel">
        <div className="auth-card">
          <h2>{titles[view][0]}</h2>
          <p className="muted">{titles[view][1]}</p>

          {(view === "login" || view === "register") && settings.allow_registration && (
            <div className="auth-switch" role="tablist">
              <button type="button" role="tab" aria-selected={view === "login"}
                className={view === "login" ? "active" : ""} onClick={() => go("login")}>Sign in</button>
              <button type="button" role="tab" aria-selected={view === "register"}
                className={view === "register" ? "active" : ""} onClick={() => go("register")}>Create account</button>
            </div>
          )}

          {backendDown && (
            <div className="alert error">
              Cannot reach the server. Start the backend in the backend folder with{" "}
              <code>uvicorn app.main:app --reload</code>.
            </div>
          )}
          {notice && <div className="alert info">{notice}</div>}

          {view === "login" && (
            <LoginForm rememberDays={settings.remember_me_days} onSignedIn={onSignedIn}
              onForgot={() => go("forgot")}
              onNeedsCode={(p) => { setPending(p); go("verify", p.message); }} />
          )}
          {view === "register" && (
            <RegisterForm onRegistered={(p) => { setPending(p); go("verify", p.message); }} />
          )}
          {view === "verify" && pending && (
            <VerifyForm pending={pending} onSignedIn={onSignedIn}
              onBack={() => { setPending(null); go("login"); }} />
          )}
          {view === "forgot" && <ForgotForm onBack={() => go("login")} />}
          {view === "reset" && (
            <ResetForm
              onDone={(msg) => { clearResetToken(); go("login", msg); }}
              onRequestNew={() => { clearResetToken(); go("forgot"); }}
            />
          )}

          {view === "login" && !settings.allow_registration && (
            <p className="auth-footnote">Need an account? Ask an existing user to create one for you.</p>
          )}
        </div>
      </main>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function signedIn(data, onSignedIn) {
  auth.setToken(data.access_token);
  auth.broadcast("login");
  onSignedIn(data.user);
}

// ---------------------------------------------------------------- sign in

function LoginForm({ rememberDays, onSignedIn, onForgot, onNeedsCode }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const { busy, error, run } = useSubmit();

  function submit(e) {
    e.preventDefault();
    if (!login.trim() || !password) return;
    run(async () => {
      // Right password: a code was emailed, sign-in finishes on the code screen
      const data = await api.login(login, password, remember);
      onNeedsCode({ login: data.login, email: data.email, remember, message: data.message });
    });
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      {error && <div className="alert error" role="alert">{error}</div>}
      <label className="auth-field">
        <span>Username or email</span>
        <input autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
      </label>
      <label className="auth-field">
        <span className="label-row">
          Password
          <button type="button" className="link" onClick={onForgot}>Forgot password?</button>
        </span>
        <PasswordInput value={password} onChange={setPassword} autoComplete="current-password" />
      </label>
      <label className="auth-check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Keep me signed in for {rememberDays} days
      </label>
      <button className="btn primary auth-submit" disabled={busy || !login.trim() || !password}>
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- create account

function RegisterForm({ onRegistered }) {
  const [form, setForm] = useState({ full_name: "", username: "", email: "", password: "" });
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState({});
  const { busy, error, run } = useSubmit();
  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));
  const touch = (field) => () => setTouched((t) => ({ ...t, [field]: true }));

  const username = form.username.trim().toLowerCase();
  const problems = {
    full_name: form.full_name.trim().length < 2 ? "Enter your full name." : "",
    username: !USERNAME_RE.test(username) ? "3–30 characters: letters, numbers, dot, dash or underscore." : "",
    email: !EMAIL_RE.test(form.email.trim()) ? "Enter a valid email address." : "",
  };
  const strength = checkPassword(form.password, { username, email: form.email });
  const confirmOk = confirm === form.password;
  const canSubmit = !problems.full_name && !problems.username && !problems.email && strength.valid && confirm && confirmOk;

  function submit(e) {
    e.preventDefault();
    setTouched({ full_name: true, username: true, email: true });
    if (!canSubmit) return;
    run(async () => {
      const data = await api.register(form);
      onRegistered({ login: data.login, email: data.email, remember: false, message: data.message });
    });
  }

  const fieldError = (f) => touched[f] && problems[f] && <small className="text-red">{problems[f]}</small>;

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      {error && <div className="alert error" role="alert">{error}</div>}
      <label className="auth-field">
        <span>Full name</span>
        <input autoFocus autoComplete="name" value={form.full_name} maxLength={100}
          onChange={(e) => set("full_name")(e.target.value)} onBlur={touch("full_name")} />
        {fieldError("full_name")}
      </label>
      <div className="auth-row">
        <label className="auth-field">
          <span>Username</span>
          <input autoComplete="username" value={form.username} maxLength={30} placeholder="e.g. your.name"
            onChange={(e) => set("username")(e.target.value)} onBlur={touch("username")} />
          {fieldError("username")}
        </label>
        <label className="auth-field">
          <span>Email</span>
          <input type="email" autoComplete="email" value={form.email} maxLength={254}
            onChange={(e) => set("email")(e.target.value)} onBlur={touch("email")} />
          {fieldError("email")}
        </label>
      </div>
      <label className="auth-field">
        <span>Password</span>
        <PasswordInput value={form.password} onChange={set("password")} autoComplete="new-password" />
      </label>
      <PasswordStrength password={form.password} username={username} email={form.email} />
      <label className="auth-field">
        <span>Confirm password</span>
        <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {confirm && !confirmOk && <small className="text-red">Passwords do not match.</small>}
      </label>
      <button className="btn primary auth-submit" disabled={busy || !canSubmit}>
        {busy ? "Creating account and sending code..." : "Create account"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- sign-in code (6 digits)

export function CodeInput({ value, onChange, autoFocus = true }) {
  return (
    <input
      className="code-input"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      placeholder="••••••"
      aria-label="6-digit code"
    />
  );
}

export function useResendTimer(seconds = 60) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((l) => l - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, () => setLeft(seconds)];
}

function VerifyForm({ pending, onSignedIn, onBack }) {
  const [code, setCode] = useState("");
  const [info, setInfo] = useState("");
  const [resendIn, restartTimer] = useResendTimer(60);
  const { busy, error, setError, run } = useSubmit();

  function submit(e) {
    e?.preventDefault();
    if (code.length !== 6) return;
    setInfo("");
    run(async () => signedIn(await api.verifyCode(pending.login, code, pending.remember), onSignedIn));
  }

  async function resend() {
    setError("");
    setInfo("");
    try {
      setInfo((await api.resendCode(pending.login)).message);
      setCode("");
      restartTimer();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      {error && <div className="alert error" role="alert">{error}</div>}
      {info && <div className="alert success">{info}</div>}
      <p className="small">
        Code sent to <b>{pending.email}</b>. It is valid for 15 minutes. Check your spam folder if you don't see it.
      </p>
      <CodeInput value={code} onChange={setCode} />
      <button className="btn primary auth-submit" disabled={busy || code.length !== 6}>
        {busy ? "Signing in..." : "Sign in"}
      </button>
      <div className="row-between small">
        <button type="button" className="link" onClick={onBack}>Back to sign in</button>
        {resendIn > 0
          ? <span className="muted">Resend code in {resendIn}s</span>
          : <button type="button" className="link" onClick={resend}>Resend code</button>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- forgot password

function ForgotForm({ onBack }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState("");
  const { busy, error, run } = useSubmit();
  const valid = EMAIL_RE.test(email.trim());

  function submit(e) {
    e.preventDefault();
    if (!valid) return;
    run(async () => setSent((await api.forgotPassword(email)).message));
  }

  if (sent) {
    return (
      <div className="auth-form">
        <div className="alert success">{sent}</div>
        <p className="muted small">Didn't get it? Check your spam folder, or try again in a few minutes.</p>
        <button type="button" className="btn auth-submit" onClick={onBack}>Back to sign in</button>
      </div>
    );
  }
  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      {error && <div className="alert error" role="alert">{error}</div>}
      <label className="auth-field">
        <span>Email</span>
        <input type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button className="btn primary auth-submit" disabled={busy || !valid}>
        {busy ? "Sending..." : "Send reset link"}
      </button>
      <button type="button" className="link center" onClick={onBack}>Back to sign in</button>
    </form>
  );
}

// ---------------------------------------------------------------- reset password (from email link)

function ResetForm({ onDone, onRequestNew }) {
  const [token] = useState(readResetToken);
  const [username, setUsername] = useState(null);
  const [linkError, setLinkError] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    api.checkResetToken(token).then((r) => setUsername(r.username)).catch((e) => setLinkError(e.message));
  }, [token]);

  const strength = checkPassword(password, { username: username || "" });
  const canSubmit = strength.valid && confirm && confirm === password;

  function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    run(async () => onDone((await api.resetPassword(token, password)).message));
  }

  if (linkError) {
    return (
      <div className="auth-form">
        <div className="alert error">{linkError}</div>
        <button type="button" className="btn primary auth-submit" onClick={onRequestNew}>Request a new link</button>
      </div>
    );
  }
  if (username === null) return <p className="muted">Checking your link...</p>;

  return (
    <form className="auth-form" onSubmit={submit} noValidate>
      {error && <div className="alert error" role="alert">{error}</div>}
      <p className="small">Resetting the password for <b>{username}</b>. You will be signed out on all devices.</p>
      <input type="text" autoComplete="username" value={username} readOnly hidden />
      <label className="auth-field">
        <span>New password</span>
        <PasswordInput value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
      </label>
      <PasswordStrength password={password} username={username} />
      <label className="auth-field">
        <span>Confirm new password</span>
        <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {confirm && confirm !== password && <small className="text-red">Passwords do not match.</small>}
      </label>
      <button className="btn primary auth-submit" disabled={busy || !canSubmit}>
        {busy ? "Saving..." : "Reset password"}
      </button>
    </form>
  );
}
