import { useEffect, useState } from "react";
import { api, describeDevice, formatDateTime } from "../api";
import { checkPassword, PasswordInput, PasswordStrength } from "../components/Password";
import { EVENT_LABELS, RoleBadge } from "./AccountPage";
import { Alert, badge, btnCls, card, cx, formCls, h2, input, num, page, table, tableCompact, scrollX } from "../components/ui";

const EMPTY_USER = { full_name: "", username: "", email: "", password: "", role: "user", admin_code: "" };

// Time left on a lock as "14:05", or null once it has run out
function lockTimeLeft(lockedUntil, now) {
  const ms = lockedUntil ? new Date(lockedUntil) - now : 0;
  if (ms <= 0) return null;
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// Admins only: create accounts, unlock locked ones and read the security audit log
export default function UsersPage({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [message, setMessage] = useState(null);
  const [now, setNow] = useState(Date.now());

  // Tick every second while an account is locked, so the countdown runs and expired locks disappear
  const anyLocked = users.some((u) => lockTimeLeft(u.locked_until, now));
  useEffect(() => {
    if (!anyLocked) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyLocked]);

  const load = () => api.listUsers().then(setUsers).catch((e) => setMessage({ type: "error", text: e.message }));
  useEffect(() => { load(); }, []);

  async function update(user, changes) {
    setMessage(null);
    try {
      const updated = await api.updateUser(user.id, changes);
      setUsers((list) => list.map((u) => (u.id === updated.id ? updated : u)));
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    }
  }

  return (
    <div className={page}>
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className={h2}>Users ({users.length})</h2>
          <button className={btnCls("primary")} onClick={() => setShowCreate((s) => !s)}>
            {showCreate ? "Close" : "+ New user"}
          </button>
        </div>
        {message && <Alert type={message.type}>{message.text}</Alert>}
        {showCreate && (
          <CreateUserForm onCreated={(u) => {
            setUsers((list) => [...list, u].sort((a, b) => a.username.localeCompare(b.username)));
            setShowCreate(false);
            setMessage({ type: "success", text: `Account "${u.username}" created.` });
          }} />
        )}
        <div className={scrollX}><table className={table}>
          <thead>
            <tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isMe = u.id === currentUser.id;
              const timeLeft = lockTimeLeft(u.locked_until, now);
              return (
                <tr key={u.id}>
                  <td><b>{u.full_name || "—"}</b>{isMe && <span className="text-xs text-muted"> (you)</span>}</td>
                  <td>{u.username}</td>
                  <td className="text-xs">
                    {u.email || <span className="text-muted">none</span>}
                  </td>
                  <td><RoleBadge role={u.role} /></td>
                  <td>
                    {timeLeft
                      ? <span className={badge("red")} title={`Unlocks automatically at ${formatDateTime(u.locked_until)}`}>Locked</span>
                      : <span className={badge("green")} title="Not locked: can sign in">Active</span>}
                  </td>
                  <td className="text-xs">{formatDateTime(u.last_login_at)}</td>
                  <td className={num}>
                    <div className="flex justify-end gap-2">
                      {timeLeft && (
                        <button className={btnCls("default", "sm")} onClick={() => update(u, { unlock: true })}
                          title={`The lock ends by itself at ${formatDateTime(u.locked_until)}`}>
                          Unlock ({timeLeft} left)
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </section>
      <AuditLog />
    </div>
  );
}

function CreateUserForm({ onCreated }) {
  const [form, setForm] = useState(EMPTY_USER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));
  const strength = checkPassword(form.password, { username: form.username, email: form.email });
  const canSubmit = form.full_name.trim().length >= 2 && form.username.trim().length >= 3 && form.email.includes("@") && strength.valid
    && (form.role !== "admin" || form.admin_code.trim());

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      onCreated(await api.createUser(form));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={cx(formCls, "my-3 !max-w-none rounded-lg border border-line bg-gray-50 p-4")} onSubmit={submit} noValidate>
      {error && <Alert type="error">{error}</Alert>}
      <div className="grid grid-cols-2 gap-3 max-[820px]:grid-cols-1">
        <label>Full name<input className={input} value={form.full_name} onChange={(e) => set("full_name")(e.target.value)} /></label>
        <label>Username<input className={input} value={form.username} onChange={(e) => set("username")(e.target.value)} autoComplete="off" /></label>
      </div>
      <label>Email
        <input className={input} type="email" value={form.email} onChange={(e) => set("email")(e.target.value)} autoComplete="off" />
        <small className="text-muted">Must be a real address: every sign-in needs a code emailed to it.</small>
      </label>
      <label>Temporary password
        <PasswordInput value={form.password} onChange={set("password")} autoComplete="new-password" />
        <small className="text-muted">Share it securely; the user can change it under My account.</small>
      </label>
      {form.password && <PasswordStrength password={form.password} username={form.username} email={form.email} />}
      <div className="grid grid-cols-2 gap-3 max-[820px]:grid-cols-1">
        <label>Role
          <select className={input} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value, admin_code: "" }))}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {form.role === "admin" && (
          <label>Admin code
            <PasswordInput value={form.admin_code} onChange={set("admin_code")} autoComplete="off" />
          </label>
        )}
      </div>
      <div><button className={btnCls("primary")} disabled={busy || !canSubmit}>{busy ? "Creating..." : "Create user"}</button></div>
    </form>
  );
}

function AuditLog() {
  const [events, setEvents] = useState([]);
  const [onlyFailures, setOnlyFailures] = useState(false);
  const load = () => api.auditLog(300).then(setEvents).catch(() => {});
  useEffect(() => { load(); }, []);
  const shown = onlyFailures ? events.filter((e) => !e.success) : events;

  return (
    <section className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_320px]">
          <h2 className={h2}>Security audit log</h2>
          <p className="text-xs text-muted">Sign-ins, failures, lockouts, password changes and account changes.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px]">
            <input type="checkbox" checked={onlyFailures} onChange={(e) => setOnlyFailures(e.target.checked)} /> Failures only
          </label>
          <button className={btnCls("default", "sm")} onClick={load}>Refresh</button>
        </div>
      </div>
      <div className={scrollX}><table className={tableCompact}>
        <thead><tr><th>When</th><th>User</th><th>Event</th><th>Details</th><th>Device</th><th>IP address</th></tr></thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.id}>
              <td>{formatDateTime(e.created_at)}</td>
              <td>{e.username || "—"}</td>
              <td><span className={e.success ? "" : "text-red-700"}>{EVENT_LABELS[e.event] || e.event}</span></td>
              <td className="text-muted">{e.detail}</td>
              <td>{describeDevice(e.user_agent)}</td>
              <td className="font-mono">{e.ip_address}</td>
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={6} className="text-muted">Nothing to show.</td></tr>}
        </tbody>
      </table></div>
    </section>
  );
}
