import { useEffect, useState } from "react";
import { api, formatDateTime } from "../api";
import { Alert, btnCls, card, cx, h2, input, page } from "../components/ui";
import { Toggle } from "./EmailConfigPage";

// Admins only: the server settings that used to be edited in backend/.env (mail server, inbox,
// retries, background jobs, sign-up and security). Saved changes apply at once, without a restart.
// A change to the mail server or the mailbox is tested first; if the test fails nothing is saved,
// unless the admin chooses "Save anyway". Passwords are never shown: type a new one to change it.

const TESTABLE = { smtp: "smtp", inbox: "imap" };

export default function SystemSettingsPage({ onSaved }) {
  const [data, setData] = useState(null);      // from the server
  const [form, setForm] = useState({});        // name -> value being edited (secrets: "" = unchanged)
  const [resets, setResets] = useState([]);    // names going back to their .env value
  const [error, setError] = useState("");
  const [message, setMessage] = useState(null);
  const [failed, setFailed] = useState(null);  // connection test failed on save: { problems }
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState("");  // group being tested
  const [tests, setTests] = useState({});      // group -> { type, text }

  function apply(next) {
    setData(next);
    setForm(Object.fromEntries(next.groups.flatMap((g) => g.fields).map((f) => [f.name, f.kind === "secret" ? "" : f.value])));
    setResets([]);
    setFailed(null);
  }

  useEffect(() => { api.serverSettings().then(apply).catch((e) => setError(e.message)); }, []);

  if (error && !data) return <Alert type="error">{error}</Alert>;
  if (!data) return <p className="text-muted">Loading...</p>;

  const fields = data.groups.flatMap((g) => g.fields);
  const original = Object.fromEntries(fields.map((f) => [f.name, f]));
  const isChanged = (f) => (f.kind === "secret" ? form[f.name] !== "" : String(form[f.name]) !== String(f.value));
  const changes = () => Object.fromEntries(fields.filter((f) => isChanged(f) && !resets.includes(f.name))
    .map((f) => [f.name, f.kind === "int" ? String(form[f.name]).trim() : form[f.name]]));
  const dirty = Object.keys(changes()).length > 0 || resets.length > 0;

  const set = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setResets((r) => r.filter((n) => n !== name));
    setMessage(null);
    setFailed(null);
  };
  const reset = (f) => {
    setResets((r) => [...r.filter((n) => n !== f.name), f.name]);
    setForm((v) => ({ ...v, [f.name]: f.kind === "secret" ? "" : f.env_value }));
    setMessage(null);
    setFailed(null);
  };

  async function save(force = false) {
    setSaving(true);
    setMessage(null);
    try {
      const next = await api.saveServerSettings(changes(), resets, force);
      apply(next);
      setTests({});
      setMessage(next.changed.length
        ? { type: "success", text: `Saved and applied: ${next.changed.map((n) => original[n]?.label || n).join(", ")}.` }
        : { type: "info", text: "Nothing changed." });
      onSaved?.();
    } catch (e) {
      if (e.code === "test_failed") setFailed(e.message);
      else setMessage({ type: "error", text: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function test(group) {
    setTesting(group);
    setTests((t) => ({ ...t, [group]: null }));
    try {
      const r = await api.testServerSettings(TESTABLE[group], changes());
      setTests((t) => ({ ...t, [group]: { type: "success", text: r.message } }));
    } catch (e) {
      setTests((t) => ({ ...t, [group]: { type: "error", text: e.message } }));
    } finally {
      setTesting("");
    }
  }

  return (
    <div className={page}>
      <Alert type="info" className="m-0">
        These settings used to be edited in <code>backend/.env</code>. Saved changes apply at once, without a restart.
        The database connection, <code>JWT_SECRET</code>, <code>APP_BASE_URL</code> and <code>COOKIE_SECURE</code> stay in
        <code> .env</code>.
      </Alert>
      {!data.secrets_survive_restart && (
        <Alert type="warning" className="m-0">
          <code>JWT_SECRET</code> is not set in <code>backend/.env</code>: passwords saved here can't be read after the server
          restarts (the <code>.env</code> value is used then). Set <code>JWT_SECRET</code> to keep them.
        </Alert>
      )}

      {data.groups.map((g) => (
        <section key={g.id} className={card}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-[1_1_320px]">
              <h2 className={h2}>{g.title}</h2>
              {g.description && <p className="text-xs text-muted">{g.description}</p>}
            </div>
            {TESTABLE[g.id] && (
              <button type="button" className={btnCls("default", "sm")} onClick={() => test(g.id)} disabled={!!testing}
                title="Sign in with the values on this page (also unsaved ones). Nothing is sent or saved.">
                {testing === g.id ? "Testing..." : "Test connection"}
              </button>
            )}
          </div>
          {tests[g.id] && <Alert type={tests[g.id].type}>{tests[g.id].text}</Alert>}

          <div className="mt-3 grid gap-x-6 gap-y-4 min-[760px]:grid-cols-2">
            {g.fields.map((f) => (
              <SettingField key={f.name} field={f} value={form[f.name]} onChange={(v) => set(f.name, v)}
                changed={isChanged(f) && !resets.includes(f.name)} resetting={resets.includes(f.name)}
                onReset={() => reset(f)} />
            ))}
          </div>
        </section>
      ))}

      <div className="sticky bottom-0 -mx-1 flex flex-col gap-2 rounded-lg border border-line bg-white/95 px-4 py-3 shadow-card backdrop-blur">
        {failed && (
          <Alert type="error" className="m-0">
            {failed} Check the values, or save anyway if the server is down for now.
          </Alert>
        )}
        {message && <Alert type={message.type} className="m-0">{message.text}</Alert>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-muted">{dirty ? "You have unsaved changes." : "No unsaved changes."}</span>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnCls()} onClick={() => { apply(data); setMessage(null); }} disabled={!dirty || saving}>
              Discard
            </button>
            {failed && (
              <button type="button" className={btnCls()} onClick={() => save(true)} disabled={saving}>Save anyway</button>
            )}
            <button type="button" className={btnCls("primary")} onClick={() => save(false)} disabled={!dirty || saving}>
              {saving ? "Testing and saving..." : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingField({ field: f, value, onChange, changed, resetting, onReset }) {
  const [show, setShow] = useState(false);
  const id = `setting-${f.name}`;
  const source = resetting
    ? <span className="text-amber-700">Back to the .env value when saved</span>
    : f.source === "portal"
      ? <>Changed here{f.updated_by_name ? ` by ${f.updated_by_name}` : ""}{f.updated_at ? ` · ${formatDateTime(f.updated_at)}` : ""}</>
      : "From .env";

  return (
    <div className={cx("min-w-0", f.kind === "bool" && "min-[760px]:col-span-2")}>
      {f.kind === "bool" ? (
        <div className="flex items-start gap-3">
          <Toggle id={id} checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          <label htmlFor={id} className="text-[13px] font-semibold">
            {f.label}
            {f.help && <span className="block text-xs font-normal text-muted">{f.help}</span>}
          </label>
        </div>
      ) : (
        <>
          <label htmlFor={id} className="mb-1 block text-[13px] font-semibold">
            {f.label}{f.required && <span className="text-brand"> *</span>}
          </label>
          <div className="flex gap-2">
            <input id={id} className={cx(input, changed && "border-amber-400")}
              type={f.kind === "secret" ? (show ? "text" : "password") : f.kind === "int" ? "number" : f.kind === "email" ? "email" : "text"}
              min={f.low ?? undefined} max={f.high ?? undefined} value={value ?? ""} spellCheck={false}
              autoComplete={f.kind === "secret" ? "new-password" : "off"}
              placeholder={f.kind === "secret" ? (f.is_set ? "Saved. Type a new one to change it" : "Not set") : ""}
              onChange={(e) => onChange(e.target.value)} />
            {f.kind === "secret" && (
              <button type="button" className={cx(btnCls("default", "sm"), "shrink-0")} onClick={() => setShow((s) => !s)}>
                {show ? "Hide" : "Show"}
              </button>
            )}
          </div>
          {f.help && <p className="mt-1 text-xs text-muted">{f.help}</p>}
        </>
      )}
      {f.unreadable && (
        <p className="mt-1 text-xs text-red-700">The saved value can't be read (JWT_SECRET changed?). Enter it again.</p>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
        <span>{source}</span>
        {f.source === "portal" && !resetting && (
          <button type="button" className="font-semibold text-brand hover:underline" onClick={onReset}
            title={f.kind === "secret" ? "Use the password from backend/.env" : `.env value: ${f.env_value === "" ? "(empty)" : String(f.env_value)}`}>
            Use the .env value
          </button>
        )}
      </p>
    </div>
  );
}
