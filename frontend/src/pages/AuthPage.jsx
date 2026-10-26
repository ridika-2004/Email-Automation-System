import { useEffect, useState } from "react";
import { api, auth } from "../api";
import { checkPassword, PasswordInput, PasswordStrength } from "../components/Password";
import { Alert, cx } from "../components/ui";

// Shared Tailwind classes of the sign-in forms
const authForm = "flex flex-col gap-3.5";
const fieldInput =
  "w-full rounded-lg border border-line bg-white px-3 py-2.5 text-sm font-normal text-ink " +
  "focus:border-brand focus:shadow-focus focus:outline-none";
// Label with its input (or select) directly inside
const field =
  "flex flex-col gap-1.5 text-[13px] font-semibold " +
  "[&>input]:w-full [&>input]:rounded-lg [&>input]:border [&>input]:border-line [&>input]:bg-white [&>input]:px-3 " +
  "[&>input]:py-2.5 [&>input]:text-sm [&>input]:font-normal [&>input:focus]:border-brand [&>input:focus]:shadow-focus " +
  "[&>input:focus]:outline-none [&>select]:w-full [&>select]:rounded-lg [&>select]:border [&>select]:border-line " +
  "[&>select]:bg-white [&>select]:px-3 [&>select]:py-2.5 [&>select]:text-sm [&>select]:font-normal " +
  "[&>select:focus]:border-brand [&>select:focus]:shadow-focus [&>select:focus]:outline-none";
const link = "cursor-pointer border-0 bg-transparent p-0 text-xs font-semibold text-brand hover:underline";
const check = "flex cursor-pointer items-center gap-2 text-[13px] [&>input]:h-4 [&>input]:w-4 [&>input]:shrink-0 [&>input]:accent-brand";
const submitBase = "mt-1 w-full rounded-md border px-3.5 py-[11px] text-[15px] font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const submitPrimary = cx(submitBase, "border-brand bg-brand text-white hover:enabled:bg-brand-dark");
const submitPlain = cx(submitBase, "border-line bg-white text-ink hover:enabled:bg-gray-100");
const codeInput =
  "w-full rounded-lg border border-line bg-white p-3 text-center font-mono text-[28px] font-bold tracking-[12px] text-ink " +
  "focus:border-brand focus:shadow-focus focus:outline-none";

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

  const tab = (active) => cx("rounded-md p-2 text-[13px] font-semibold", active ? "bg-white text-ink shadow" : "text-muted hover:text-ink");

  return (
    <div className="grid min-h-screen grid-cols-2 max-[820px]:grid-cols-1">
      <aside className="flex flex-col justify-center gap-3.5 bg-gradient-to-br from-brand via-brand-dark to-brand-darker p-14 text-white max-[820px]:px-4 max-[820px]:py-8">
        <div className="flex h-[52px] w-[52px] items-center justify-center rounded-[14px] bg-white text-[26px] font-extrabold text-brand" aria-hidden="true">N</div>
        <h1 className="max-w-[420px] text-[30px] font-bold leading-tight max-[820px]:text-[22px]">NPSB Dispute Email Automation</h1>
        <p className="max-w-[420px] text-[15px] leading-normal opacity-90">
          Group transactions by partner and mail type, and email each partner from the right template.
        </p>
        <ul className="mt-3 flex flex-col gap-2.5 max-[820px]:hidden">
          {["Upload the daily NPSB dispute file", "Review transactions grouped by partner and mail type",
            "Preview, edit and send one email per partner and mail type"].map((item) => (
            <li key={item} className="flex items-center gap-2 opacity-95">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-white/20 text-xs" aria-hidden="true">✓</span>
              {item}
            </li>
          ))}
        </ul>
      </aside>

      <main className="flex items-center justify-center px-4 py-10">
        <div className="flex w-full max-w-[420px] flex-col gap-3.5 rounded-xl border border-line bg-white p-8 shadow-card max-[820px]:px-5 max-[820px]:py-6">
          <h2 className="text-[22px] font-bold">{titles[view][0]}</h2>
          <p className="-mt-2 mb-1 text-muted">{titles[view][1]}</p>

          {(view === "login" || view === "register") && settings.allow_registration && (
            <div className="grid grid-cols-2 rounded-lg bg-gray-100 p-1" role="tablist">
              <button type="button" role="tab" aria-selected={view === "login"}
                className={tab(view === "login")} onClick={() => go("login")}>Sign in</button>
              <button type="button" role="tab" aria-selected={view === "register"}
                className={tab(view === "register")} onClick={() => go("register")}>Create account</button>
            </div>
          )}

          {backendDown && (
            <Alert type="error" className="">
              Cannot reach the server. Start the backend in the backend folder with{" "}
              <code className="rounded bg-black/5 px-1 py-px">uvicorn app.main:app --reload</code>.
            </Alert>
          )}
          {notice && <Alert type="info" className="">{notice}</Alert>}

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
            <p className="text-center text-xs text-muted">Need an account? Ask an admin to create one for you.</p>
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
      const data = await api.login(login, password, remember);
      // Trusted browser ("Keep me signed in" earlier): the password was enough
      if (data.access_token) {
        signedIn(data, onSignedIn);
        return;
      }
      // Otherwise a code was emailed, and sign-in finishes on the code screen
      onNeedsCode({ login: data.login, email: data.email, remember, message: data.message });
    });
  }

  return (
    <form className={authForm} onSubmit={submit} noValidate>
      {error && <Alert type="error" className="" role="alert">{error}</Alert>}
      <label className={field}>
        <span>Username or email</span>
        <input autoFocus autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
      </label>
      <label className={field}>
        <span className="flex items-baseline justify-between">
          Password
          <button type="button" className={link} onClick={onForgot}>Forgot password?</button>
        </span>
        <PasswordInput className={fieldInput} value={password} onChange={setPassword} autoComplete="current-password" />
      </label>
      <label className={check}>
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>
          Keep me signed in for {rememberDays} days
          <small className="mt-0.5 block text-xs font-normal text-muted">On this browser, later sign-ins need only your password, no email code.</small>
        </span>
      </label>
      <button className={submitPrimary} disabled={busy || !login.trim() || !password}>
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- create account

function RegisterForm({ onRegistered }) {
  const [form, setForm] = useState({ full_name: "", username: "", email: "", password: "", role: "user", admin_code: "" });
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
  const needsCode = form.role === "admin" && !form.admin_code.trim();
  const canSubmit = !problems.full_name && !problems.username && !problems.email && strength.valid && confirm && confirmOk && !needsCode;

  function submit(e) {
    e.preventDefault();
    setTouched({ full_name: true, username: true, email: true });
    if (!canSubmit) return;
    run(async () => {
      const data = await api.register(form);
      onRegistered({ login: data.login, email: data.email, remember: false, message: data.message });
    });
  }

  const fieldError = (f) => touched[f] && problems[f] && <small className="font-normal text-red-700">{problems[f]}</small>;

  return (
    <form className={authForm} onSubmit={submit} noValidate>
      {error && <Alert type="error" className="" role="alert">{error}</Alert>}
      <label className={field}>
        <span>Full name</span>
        <input autoFocus autoComplete="name" value={form.full_name} maxLength={100}
          onChange={(e) => set("full_name")(e.target.value)} onBlur={touch("full_name")} />
        {fieldError("full_name")}
      </label>
      <div className="grid grid-cols-2 gap-3 max-[820px]:grid-cols-1">
        <label className={field}>
          <span>Username</span>
          <input autoComplete="username" value={form.username} maxLength={30} placeholder="e.g. your.name"
            onChange={(e) => set("username")(e.target.value)} onBlur={touch("username")} />
          {fieldError("username")}
        </label>
        <label className={field}>
          <span>Email</span>
          <input type="email" autoComplete="email" value={form.email} maxLength={254}
            onChange={(e) => set("email")(e.target.value)} onBlur={touch("email")} />
          {fieldError("email")}
        </label>
      </div>
      <label className={field}>
        <span>Role</span>
        <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value, admin_code: "" }))}>
          <option value="user">User</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      {form.role === "admin" && (
        <label className={field}>
          <span>Admin code</span>
          <PasswordInput className={fieldInput} value={form.admin_code} onChange={set("admin_code")} autoComplete="off" />
          <small className="font-normal text-muted">Only admins know this code. Without it, choose User.</small>
        </label>
      )}
      <label className={field}>
        <span>Password</span>
        <PasswordInput className={fieldInput} value={form.password} onChange={set("password")} autoComplete="new-password" />
      </label>
      <PasswordStrength password={form.password} username={username} email={form.email} />
      <label className={field}>
        <span>Confirm password</span>
        <PasswordInput className={fieldInput} value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {confirm && !confirmOk && <small className="font-normal text-red-700">Passwords do not match.</small>}
      </label>
      <button className={submitPrimary} disabled={busy || !canSubmit}>
        {busy ? "Creating account and sending code..." : "Create account"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- sign-in code (6 digits)

export function CodeInput({ value, onChange, autoFocus = true, className = "" }) {
  return (
    <input
      className={cx(codeInput, className)}
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
    <form className={authForm} onSubmit={submit} noValidate>
      {error && <Alert type="error" className="" role="alert">{error}</Alert>}
      {info && <Alert type="success" className="">{info}</Alert>}
      <p className="text-xs">
        Code sent to <b>{pending.email}</b>. It is valid for 15 minutes. Check your spam folder if you don't see it.
      </p>
      <CodeInput value={code} onChange={setCode} />
      <button className={submitPrimary} disabled={busy || code.length !== 6}>
        {busy ? "Signing in..." : "Sign in"}
      </button>
      <div className="flex items-start justify-between gap-3 text-xs">
        <button type="button" className={link} onClick={onBack}>Back to sign in</button>
        {resendIn > 0
          ? <span className="font-normal text-muted">Resend code in {resendIn}s</span>
          : <button type="button" className={link} onClick={resend}>Resend code</button>}
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
      <div className={authForm}>
        <Alert type="success" className="">{sent}</Alert>
        <p className="text-xs text-muted">Didn't get it? Check your spam folder, or try again in a few minutes.</p>
        <button type="button" className={submitPlain} onClick={onBack}>Back to sign in</button>
      </div>
    );
  }
  return (
    <form className={authForm} onSubmit={submit} noValidate>
      {error && <Alert type="error" className="" role="alert">{error}</Alert>}
      <label className={field}>
        <span>Email</span>
        <input type="email" autoFocus autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <button className={submitPrimary} disabled={busy || !valid}>
        {busy ? "Sending..." : "Send reset link"}
      </button>
      <button type="button" className={cx(link, "self-center text-[13px]")} onClick={onBack}>Back to sign in</button>
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
      <div className={authForm}>
        <Alert type="error" className="">{linkError}</Alert>
        <button type="button" className={submitPrimary} onClick={onRequestNew}>Request a new link</button>
      </div>
    );
  }
  if (username === null) return <p className="font-normal text-muted">Checking your link...</p>;

  return (
    <form className={authForm} onSubmit={submit} noValidate>
      {error && <Alert type="error" className="" role="alert">{error}</Alert>}
      <p className="text-xs">Resetting the password for <b>{username}</b>. You will be signed out on all devices.</p>
      <input type="text" autoComplete="username" value={username} readOnly hidden />
      <label className={field}>
        <span>New password</span>
        <PasswordInput className={fieldInput} value={password} onChange={setPassword} autoComplete="new-password" autoFocus />
      </label>
      <PasswordStrength password={password} username={username} />
      <label className={field}>
        <span>Confirm new password</span>
        <PasswordInput className={fieldInput} value={confirm} onChange={setConfirm} autoComplete="new-password" />
        {confirm && confirm !== password && <small className="font-normal text-red-700">Passwords do not match.</small>}
      </label>
      <button className={submitPrimary} disabled={busy || !canSubmit}>
        {busy ? "Saving..." : "Reset password"}
      </button>
    </form>
  );
}
