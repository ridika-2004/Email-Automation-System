import { useEffect, useState } from "react";
import { api, formatDateTime } from "../api";
import { Alert, btnCls, card, cx, h2, input, label, page } from "../components/ui";

const FIELDS = ["followup_due_days", "auto_followup_enabled", "auto_followup_max", "cc_emails", "reply_to"];

// The form keeps CC addresses as text (one per line) and numbers as strings while typing
const toForm = (s) => ({ ...pick(s), cc_emails: s.cc_emails.join("\n"),
  followup_due_days: String(s.followup_due_days), auto_followup_max: String(s.auto_followup_max) });
const fromForm = (f) => ({
  ...f,
  followup_due_days: Number(f.followup_due_days),
  auto_followup_max: Number(f.auto_followup_max),
  cc_emails: f.cc_emails.split(/[\n,;]+/).map((a) => a.trim()).filter(Boolean),
  reply_to: f.reply_to.trim(),
});
const pick = (s) => Object.fromEntries(FIELDS.map((k) => [k, s[k]]));

// Email settings: when a follow-up is due, automatic follow-ups, CC / Reply-To and the mail server.
// Everyone can see them; only admins can change them.
export default function EmailConfigPage({ isAdmin, onSaved }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(null);
  const [message, setMessage] = useState(null); // { type, text }
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const apply = (s) => { setSettings(s); setForm(toForm(s)); };
  useEffect(() => { api.emailSettings().then(apply).catch((e) => setMessage({ type: "error", text: e.message })); }, []);

  if (!form) return message ? <Alert type={message.type}>{message.text}</Alert> : <p className="text-muted">Loading...</p>;

  const dirty = JSON.stringify(fromForm(form)) !== JSON.stringify(fromForm(toForm(settings)));
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      apply(await api.saveEmailSettings(fromForm(form)));
      setMessage({ type: "success", text: "Email settings saved." });
      onSaved?.();
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRunning(true);
    setMessage(null);
    try {
      const { result, settings: s } = await api.runFollowupsNow();
      setSettings(s);
      setMessage(describeRun(result));
    } catch (err) {
      setMessage({ type: "error", text: err.message });
    } finally {
      setRunning(false);
    }
  }

  const auto = settings.auto_status;
  const minutes = Math.round(settings.check_every_seconds / 60);
  const disabled = !isAdmin || saving;

  return (
    <form className={page} onSubmit={save}>
      {!isAdmin && <Alert type="info" className="">Only admins can change these settings.</Alert>}
      {message && <Alert type={message.type} className="">{message.text}</Alert>}

      <section className={card}>
        <h2 className={h2}>Follow-up reminders</h2>
        <p className="mb-4 text-muted">
          A sent email still marked <b>Awaiting reply</b> becomes <b>Follow-up due</b> when nothing has been sent to the
          partner for the number of days below.
        </p>

        <div className="grid gap-4 min-[700px]:grid-cols-2">
          <label className={label}>
            Follow-up due after (days)
            <input className={input} type="number" min={1} max={90} required value={form.followup_due_days}
              onChange={set("followup_due_days")} disabled={disabled} />
            <small className="font-normal text-muted">Counted from the original email or the last follow-up. 1–90 days.</small>
          </label>
          <label className={label}>
            Follow-ups per email (at most)
            <input className={input} type="number" min={1} max={20} required value={form.auto_followup_max}
              onChange={set("auto_followup_max")} disabled={disabled} />
            <small className="font-normal text-muted">Automatic follow-ups stop once an email has had this many. You can still send more by hand.</small>
          </label>
        </div>

        <div className="mt-5 flex items-start gap-3 rounded-lg border border-line bg-gray-50 p-3.5">
          <Toggle checked={form.auto_followup_enabled} onChange={set("auto_followup_enabled")} disabled={disabled}
            id="auto-followup" />
          <div className="flex-1">
            <label htmlFor="auto-followup" className="font-semibold">Send follow-ups automatically</label>
            <p className="mt-0.5 text-[13px] text-muted">
              When an email becomes due, the standard reminder is sent to the partner in the same email thread, with the
              transactions attached again. It shows in the email's history as <i>Sent automatically</i>. Emails marked
              <i> Reply received</i> or <i>Reconciled</i> never get one. The server checks every {minutes} minute(s).
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[13px]">
          <div className="text-muted">
            <b className="text-ink">{settings.due_now}</b> email(s) due now
            {settings.auto_followup_enabled && <> · <b className="text-ink">{settings.auto_eligible_now}</b> will get an automatic follow-up at the next check</>}
            {auto.last_run_at && <> · last check {formatDateTime(auto.last_run_at)}</>}
            {auto.next_run_at && settings.auto_followup_enabled && <> · next {formatDateTime(auto.next_run_at)}</>}
          </div>
          {isAdmin && (
            <button type="button" className={btnCls("default", "sm")} onClick={runNow}
              disabled={running || !settings.auto_followup_enabled || dirty}
              title={dirty ? "Save your changes first" : !settings.auto_followup_enabled ? "Switch automatic follow-ups on first" : ""}>
              {running ? "Checking..." : "Send due follow-ups now"}
            </button>
          )}
        </div>
        {auto.last_result?.errors?.length > 0 && (
          <Alert type="warning" className="mt-3">
            Last check could not send:
            <ul>{auto.last_result.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            These are tried again after an hour.
          </Alert>
        )}
      </section>

      <section className={card}>
        <h2 className={h2}>Recipients</h2>
        <p className="mb-4 text-muted">Applied to emails prepared from now on. Emails already prepared or sent keep their recipients.</p>
        <div className="grid gap-4 min-[700px]:grid-cols-2">
          <label className={label}>
            CC on every email
            <textarea className={cx(input, "min-h-[96px] resize-y font-mono text-[13px]")} value={form.cc_emails}
              onChange={set("cc_emails")} disabled={disabled} placeholder="one address per line" />
            <small className="font-normal text-muted">One address per line (up to 20). Leave empty for no CC.</small>
          </label>
          <label className={label}>
            Reply-To address
            <input className={input} type="email" value={form.reply_to} onChange={set("reply_to")} disabled={disabled}
              placeholder={settings.smtp.mail_from} />
            <small className="font-normal text-muted">Partners' replies go here. Empty: replies go to the sender ({settings.smtp.mail_from}).</small>
          </label>
        </div>
      </section>

      <MailServerCard smtp={settings.smtp} isAdmin={isAdmin} />

      {isAdmin && (
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-white/95 px-4 py-3 shadow-card backdrop-blur">
          <span className="text-xs text-muted">
            {dirty ? "You have unsaved changes."
              : settings.updated_at ? `Last changed by ${settings.updated_by_name} · ${formatDateTime(settings.updated_at)}`
                : "Using the defaults from the server's .env file."}
          </span>
          <div className="flex gap-2">
            <button type="button" className={btnCls("default")} disabled={!dirty || saving}
              onClick={() => { setForm(toForm(settings)); setMessage(null); }}>Discard</button>
            <button className={btnCls("primary")} disabled={!dirty || saving}>{saving ? "Saving..." : "Save changes"}</button>
          </div>
        </div>
      )}
    </form>
  );
}

function describeRun(r) {
  if (!r.enabled) return { type: "info", text: "Automatic follow-ups are off." };
  if (!r.sent && !r.failed) return { type: "info", text: "No follow-ups were due." };
  const text = `${r.sent} follow-up(s) sent${r.failed ? `, ${r.failed} failed` : ""}.`;
  return { type: r.failed ? "warning" : "success", text };
}

// Mail server details come from the server's .env file; admins can send a test email
function MailServerCard({ smtp, isAdmin }) {
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  async function sendTest() {
    setSending(true);
    setResult(null);
    try {
      const r = await api.sendTestEmail(to);
      setResult({ type: "success", text: r.message });
    } catch (err) {
      setResult({ type: "error", text: err.message });
    } finally {
      setSending(false);
    }
  }

  const rows = [
    ["Server", `${smtp.host}:${smtp.port}`],
    ["Encryption", smtp.use_tls ? "STARTTLS" : "None"],
    ["Sign-in", smtp.user || "None"],
    ["Sender (From)", smtp.mail_from],
    ["Attempts per email", smtp.max_attempts],
  ];

  return (
    <section className={card}>
      <h2 className={h2}>Mail server</h2>
      <p className="mb-3 text-muted">Set in the server's <code>backend/.env</code> file (SMTP_*). Restart the backend after changing it.</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {isAdmin && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="text-[13px] font-semibold">Send a test email</div>
          <div className="mt-1.5 flex max-w-[520px] gap-2">
            <input className={input} type="email" value={to} onChange={(e) => setTo(e.target.value)}
              placeholder="you@example.com" aria-label="Test email address" />
            <button type="button" className={cx(btnCls("default"), "shrink-0")} onClick={sendTest} disabled={sending || !to.trim()}>
              {sending ? "Sending..." : "Send test"}
            </button>
          </div>
          {result && <Alert type={result.type} className="mt-3">{result.text}</Alert>}
        </div>
      )}
    </section>
  );
}

function Toggle({ id, checked, onChange, disabled }) {
  return (
    <label className="relative mt-0.5 inline-flex shrink-0 cursor-pointer">
      <input id={id} type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={onChange} disabled={disabled} />
      <span aria-hidden="true" className={cx(
        "h-6 w-11 rounded-full transition-colors peer-focus-visible:shadow-focus peer-disabled:opacity-50",
        checked ? "bg-brand" : "bg-gray-300",
      )} />
      <span aria-hidden="true" className={cx(
        "pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
        checked && "translate-x-5",
      )} />
    </label>
  );
}
