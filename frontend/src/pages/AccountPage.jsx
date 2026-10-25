import { useEffect, useState } from "react";
import { api, auth, describeDevice, formatDateTime } from "../api";
import { checkPassword, PasswordInput, PasswordStrength } from "../components/Password";
import { CodeInput, useResendTimer } from "./AuthPage";

export const EVENT_LABELS = {
  register: "Account created",
  login_success: "Signed in",
  login_failed: "Failed sign-in",
  login_blocked: "Sign-in blocked",
  logout: "Signed out",
  logout_all: "Signed out everywhere",
  refresh_reuse: "Suspicious session re-use",
  session_revoked: "Signed out a device",
  password_changed: "Password changed",
  password_change_failed: "Password change failed",
  password_reset_requested: "Password reset requested",
  password_reset: "Password reset",
  profile_updated: "Profile updated",
  admin_user_created: "Created a user",
  admin_user_updated: "Updated a user",
  user_created: "Created a user",
  user_updated: "Updated a user",
  email_verified: "Email verified",
  verification_sent: "Verification code sent",
  login_code_sent: "Sign-in code sent",
  login_code_failed: "Wrong sign-in code",
  email_change_requested: "Email change requested",
  email_changed: "Email changed",
};

export default function AccountPage({ user, onUserChange, onSignedOut }) {
  return (
    <div className="page">
      <div className="account-grid">
        <ProfileCard user={user} onUserChange={onUserChange} />
        <ChangePasswordCard user={user} />
      </div>
      <SessionsCard onSignedOut={onSignedOut} />
      <ActivityCard />
    </div>
  );
}

function ProfileCard({ user, onUserChange }) {
  const [form, setForm] = useState({ full_name: user.full_name, email: user.email || "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const changed = form.full_name !== user.full_name || form.email !== (user.email || "");

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { message, ...updated } = await api.updateProfile(form);
      onUserChange(updated);
      setForm({ full_name: updated.full_name, email: updated.email || "" });
      setMsg({ type: "success", text: message });
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Profile</h2>
      <dl className="facts">
        <dt>Username</dt><dd>{user.username}</dd>
        <dt>Email</dt>
        <dd>
          {user.email || "—"}
        </dd>
        <dt>Member since</dt><dd>{formatDateTime(user.created_at)}</dd>
        <dt>Last sign-in</dt><dd>{formatDateTime(user.last_login_at)}</dd>
      </dl>
      {user.pending_email && (
        <ConfirmEmailChange user={user} onUserChange={onUserChange}
          onDone={(updated, text) => { setForm({ full_name: updated.full_name, email: updated.email || "" }); setMsg({ type: "success", text }); }} />
      )}
      <form className="form" onSubmit={save}>
        {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
        <label>Full name
          <input value={form.full_name} maxLength={100} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        </label>
        <label>Email
          <input type="email" value={form.email} maxLength={254} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <small className="muted">
            Used for signing in and password resets. A new address must be confirmed with a code sent to it.
          </small>
        </label>
        <div><button className="btn primary" disabled={busy || !changed}>{busy ? "Saving..." : "Save profile"}</button></div>
      </form>
    </section>
  );
}

// Enter the code that was sent to the new address
function ConfirmEmailChange({ user, onUserChange, onDone }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [resendIn, restartTimer] = useResendTimer(60);

  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const { message, ...updated } = await api.confirmEmailChange(code);
      onUserChange(updated);
      onDone(updated, message);
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setMsg(null);
    try {
      setMsg({ type: "success", text: (await api.resendEmailChangeCode()).message });
      restartTimer();
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    }
  }

  async function cancel() {
    try { onUserChange(await api.cancelEmailChange()); } catch (err) { setMsg({ type: "error", text: err.message }); }
  }

  return (
    <form className="pending-email" onSubmit={confirm}>
      <p className="small">
        Confirm your new email <b>{user.pending_email}</b>: enter the 6-digit code we sent there.
        Until then, <b>{user.email}</b> stays your email.
      </p>
      {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
      <div className="code-row">
        <CodeInput value={code} onChange={setCode} autoFocus={false} />
        <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? "Confirming..." : "Confirm"}</button>
      </div>
      <div className="actions small">
        {resendIn > 0
          ? <span className="muted">Resend code in {resendIn}s</span>
          : <button type="button" className="link" onClick={resend}>Resend code</button>}
        <button type="button" className="link" onClick={cancel}>Cancel change</button>
      </div>
    </form>
  );
}

function ChangePasswordCard({ user }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const strength = checkPassword(next, { username: user.username, email: user.email || "" });
  const canSubmit = current && strength.valid && confirm === next && next !== current;

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setMsg(null);
    try {
      const data = await api.changePassword(current, next);
      auth.setToken(data.access_token);
      setCurrent(""); setNext(""); setConfirm("");
      setMsg({ type: "success", text: "Password changed. You have been signed out on all other devices." });
    } catch (err) {
      setMsg({ type: "error", text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Change password</h2>
      <p className="muted small">
        Last changed: {formatDateTime(user.password_changed_at)}. Changing it signs you out on every other device.
      </p>
      <form className="form" onSubmit={submit} noValidate>
        {msg && <div className={`alert ${msg.type}`}>{msg.text}</div>}
        <input type="text" autoComplete="username" value={user.username} readOnly hidden />
        <label>Current password
          <PasswordInput value={current} onChange={setCurrent} autoComplete="current-password" />
        </label>
        <label>New password
          <PasswordInput value={next} onChange={setNext} autoComplete="new-password" />
        </label>
        {next && <PasswordStrength password={next} username={user.username} email={user.email || ""} />}
        {next && current && next === current && <small className="text-red">Choose a password different from the current one.</small>}
        <label>Confirm new password
          <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
          {confirm && confirm !== next && <small className="text-red">Passwords do not match.</small>}
        </label>
        <div><button className="btn primary" disabled={busy || !canSubmit}>{busy ? "Saving..." : "Change password"}</button></div>
      </form>
    </section>
  );
}

function SessionsCard({ onSignedOut }) {
  const [sessions, setSessions] = useState([]);
  const [error, setError] = useState("");

  const load = () => api.listSessions().then(setSessions).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function revoke(s) {
    if (s.current) return onSignedOut();
    if (!window.confirm(`Sign out ${describeDevice(s.user_agent)}?`)) return;
    try { await api.revokeSession(s.id); load(); } catch (e) { setError(e.message); }
  }

  async function signOutEverywhere() {
    if (!window.confirm("Sign out on all devices, including this one?")) return;
    try {
      await api.logoutAll();
    } finally {
      onSignedOut(true);
    }
  }

  return (
    <section className="card">
      <div className="row-between">
        <div>
          <h2>Where you're signed in</h2>
          <p className="muted small">If you don't recognise a device, sign it out and change your password.</p>
        </div>
        <button className="btn" onClick={signOutEverywhere}>Sign out everywhere</button>
      </div>
      {error && <div className="alert error">{error}</div>}
      <table className="table">
        <thead><tr><th>Device</th><th>IP address</th><th>Signed in</th><th>Last active</th><th>Expires</th><th /></tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>
                <b>{describeDevice(s.user_agent)}</b>{" "}
                {s.current && <span className="badge green">This device</span>}
                {s.remember_me && <span className="muted small"> · remembered</span>}
              </td>
              <td className="mono small">{s.ip_address}</td>
              <td className="small">{formatDateTime(s.signed_in_at)}</td>
              <td className="small">{formatDateTime(s.last_used_at)}</td>
              <td className="small">{formatDateTime(s.expires_at)}</td>
              <td className="num"><button className="btn small" onClick={() => revoke(s)}>Sign out</button></td>
            </tr>
          ))}
          {!sessions.length && <tr><td colSpan={6} className="muted">No active sessions.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function ActivityCard() {
  const [events, setEvents] = useState([]);
  useEffect(() => { api.myActivity().then(setEvents).catch(() => {}); }, []);

  return (
    <section className="card">
      <h2>Recent security activity</h2>
      <table className="table compact">
        <thead><tr><th>When</th><th>Event</th><th>Details</th><th>Device</th><th>IP address</th></tr></thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{formatDateTime(e.created_at)}</td>
              <td><span className={e.success ? "" : "text-red"}>{EVENT_LABELS[e.event] || e.event}</span></td>
              <td className="muted">{e.detail}</td>
              <td>{describeDevice(e.user_agent)}</td>
              <td className="mono">{e.ip_address}</td>
            </tr>
          ))}
          {!events.length && <tr><td colSpan={5} className="muted">No activity yet.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}
