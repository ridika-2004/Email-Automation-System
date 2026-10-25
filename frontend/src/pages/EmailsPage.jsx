import { useEffect, useRef, useState } from "react";
import { api, formatAmount } from "../api";

export default function EmailsPage({ uploadId, config }) {
  const [emails, setEmails] = useState([]);
  const [warnings, setWarnings] = useState([]);   // partners that got no email
  const [notices, setNotices] = useState([]);     // partners whose failed addresses were left out
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState("");            // "preparing" | "sending" | ""
  const [message, setMessage] = useState(null);    // { type, text }
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);

  // Every time this page opens, (re)build the previews from the current partner config
  useEffect(() => {
    prepare();
  }, [uploadId]);

  async function prepare() {
    setBusy("preparing");
    setMessage(null);
    try {
      const data = await api.prepareEmails(uploadId);
      setEmails(data.emails);
      setWarnings(data.errors);
      setNotices(data.notices || []);
      setSelectedId((id) => id ?? data.emails[0]?.id ?? null);
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function send() {
    const count = emails.filter(isPending).length;
    if (!window.confirm(`Send ${count} email(s) now?`)) return;
    setBusy("sending");
    setMessage(null);
    try {
      const data = await api.sendEmails(uploadId);
      setEmails(data.emails);
      setMessage({
        type: data.failed ? "warning" : "success",
        text: `${data.sent} email(s) sent successfully, ${data.failed} failed.`,
      });
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  function selectEmail(id) {
    if (id === selectedId) return;
    if (hasUnsavedEdits && !window.confirm("You have unsaved edits. Discard them?")) return;
    setSelectedId(id);
  }

  function replaceEmail(updated) {
    setEmails((list) => list.map((e) => (e.id === updated.id ? updated : e)));
  }

  const selected = emails.find((e) => e.id === selectedId);
  const pendingCount = emails.filter(isPending).length;

  return (
    <div className="page">
      <section className="card">
        <div className="row-between">
          <div>
            <h2>Prepared emails ({emails.length})</h2>
            <p className="muted small">
              One consolidated email per partner. Sending through test SMTP{" "}
              <b>{config ? `${config.smtp_host}:${config.smtp_port}` : ""}</b>.
            </p>
          </div>
          <div className="actions">
            <button className="btn" onClick={prepare} disabled={!!busy}>
              {busy === "preparing" ? "Refreshing..." : "Refresh previews"}
            </button>
            <button
              className="btn primary"
              onClick={send}
              disabled={!!busy || pendingCount === 0 || hasUnsavedEdits}
              title={hasUnsavedEdits ? "Save or discard your edits first" : ""}
            >
              {busy === "sending" ? "Sending..."
                : pendingCount === 0 && emails.length ? "All emails sent"
                : `Send ${pendingCount} email(s)`}
            </button>
          </div>
        </div>

        {message && <div className={`alert ${message.type}`}>{message.text}</div>}

        {warnings.length > 0 && (
          <div className="alert error">
            <b>No email was prepared for these partners:</b>
            <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            <span className="small">Fix them in Partner Configuration, then click “Refresh previews”.</span>
          </div>
        )}

        {notices.length > 0 && (
          <div className="alert warning">
            <b>These addresses were left out because the mail server refused them before:</b>
            <ul>{notices.map((n) => <li key={n}>{n}</li>)}</ul>
            <span className="small">Correct or clear them in Partner Configuration, then click “Refresh previews”.</span>
          </div>
        )}

        <table className="table">
          <thead>
            <tr>
              <th>Partner</th><th>To</th><th className="num">Txns</th>
              <th className="num">Amount (BDT)</th><th>Status</th><th>Details</th>
            </tr>
          </thead>
          <tbody>
            {emails.map((e) => (
              <tr
                key={e.id}
                className={`clickable ${e.id === selectedId ? "selected" : ""}`}
                onClick={() => selectEmail(e.id)}
              >
                <td><b>{e.partner_name}</b> <span className="muted">({e.institution_code})</span></td>
                <td className="small">{e.to.join(", ")}</td>
                <td className="num">{e.txn_count}</td>
                <td className="num">{formatAmount(e.total_amount)}</td>
                <td>
                  <StatusBadge status={e.status} />{" "}
                  {e.is_edited && isPending(e) && <span className="badge gray">EDITED</span>}
                </td>
                <td className="small">
                  {e.status === "SENT" && `Sent ${new Date(e.sent_at).toLocaleString()}`}
                  {e.status === "FAILED" && <div className="text-red">{e.error}</div>}
                  {e.delivery_issues.map((i) => (
                    <div key={i.email} className="text-red" title={i.reason}>Refused: {i.email}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selected && (
        <EmailPreview
          key={selected.id}
          email={selected}
          config={config}
          locked={!!busy}
          onSaved={replaceEmail}
          onReset={prepare}
          onDirtyChange={setHasUnsavedEdits}
        />
      )}
    </div>
  );
}

// Emails the Send button will send. SENT ones are never sent again.
const isPending = (e) => e.status === "PREPARED" || e.status === "FAILED";

function StatusBadge({ status }) {
  const color = { SENT: "green", FAILED: "red", PREPARED: "blue" }[status] || "gray";
  return <span className={`badge ${color}`}>{status}</span>;
}

// Preview card with an Edit / Preview toggle. Edits stay a local draft
// until "Save changes"; the Preview tab shows the draft as it will be sent.
function EmailPreview({ email, config, locked, onSaved, onReset, onDirtyChange }) {
  const [mode, setMode] = useState("preview");     // "preview" | "edit"
  const [draft, setDraft] = useState(null);         // { subject, body_html } while editing
  const [editorSeed, setEditorSeed] = useState(""); // HTML loaded into the editor when it opens
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editorRef = useRef(null);

  const isSent = email.status === "SENT";
  const dirty = !!draft && (draft.subject !== email.subject || draft.body_html !== email.body_html);
  const shown = draft || email;

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChange(false), []);

  function openEditor() {
    const current = draft || { subject: email.subject, body_html: email.body_html };
    setDraft(current);
    setEditorSeed(current.body_html);
    setMode("edit");
  }

  // Make the iframe document editable (WYSIWYG) and copy every change into the draft
  function onEditorLoad() {
    const doc = editorRef.current?.contentDocument;
    if (!doc) {
      setError("Could not open the editor. Switch to Preview and back to Edit, or reload the page.");
      return;
    }
    doc.designMode = "on";
    doc.addEventListener("input", () => {
      setDraft((d) => ({ ...d, body_html: doc.body.innerHTML }));
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      onSaved(await api.editEmail(email.id, draft));
      setDraft(null);
      setMode("preview");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    setDraft(null);
    setMode("preview");
    setError("");
  }

  async function resetToGenerated() {
    if (!window.confirm("Throw away your manual edits and regenerate this email?")) return;
    setError("");
    try {
      await api.discardEmailEdits(email.id);
      onReset();
    } catch (e) {
      setError(e.message);
    }
  }

  return (
    <section className="card">
      <div className="row-between">
        <h2>
          Email {mode === "edit" ? "editor" : "preview"} — {email.partner_name}
          {dirty && <span className="muted small"> (unsaved changes)</span>}
        </h2>
        <div className="actions">
          {(mode === "edit" || dirty) && (
            <>
              <button className="btn small" onClick={discard} disabled={saving}>Discard</button>
              <button
                className="btn small primary"
                onClick={save}
                disabled={!dirty || saving || locked}
                title={dirty ? "" : "No changes to save yet"}
              >
                {saving ? "Saving..." : "Save changes"}
              </button>
            </>
          )}
          {!dirty && email.is_edited && !isSent && (
            <button className="btn small" onClick={resetToGenerated} disabled={locked}>
              Reset to generated
            </button>
          )}
          <div className="toggle">
            <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>
              Preview
            </button>
            <button
              className={mode === "edit" ? "active" : ""}
              onClick={openEditor}
              disabled={isSent}
              title={isSent ? "Sent emails cannot be edited" : "Edit subject and body"}
            >
              Edit
            </button>
          </div>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="email-meta">
        <div><span>From</span>{config?.mail_from}</div>
        <div><span>To</span>{email.to.join(", ")}</div>
        <div><span>CC</span>{email.cc.join(", ")}</div>
        <div>
          <span>Subject</span>
          {mode === "edit" ? (
            <input
              value={draft.subject}
              maxLength={300}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            />
          ) : (
            <b>{shown.subject}</b>
          )}
        </div>
      </div>

      {/* Different keys force a brand-new iframe on toggle: an iframe reused by React
          keeps its old sandbox and never fires onLoad, so it would not become editable */}
      {mode === "edit" ? (
        // allow-same-origin (no scripts) lets us switch the iframe into edit mode
        <iframe
          key="editor"
          ref={editorRef}
          className="email-body editing"
          title="Email body editor"
          srcDoc={editorSeed}
          sandbox="allow-same-origin"
          onLoad={onEditorLoad}
        />
      ) : (
        // iframe keeps the email's own styling separate from the app
        <iframe key="preview" className="email-body" title="Email body" srcDoc={shown.body_html} sandbox="" />
      )}
      {mode === "edit" && (
        <p className="muted small">Click in the email to edit. Ctrl+B / Ctrl+I / Ctrl+U for bold, italic, underline.</p>
      )}
    </section>
  );
}
