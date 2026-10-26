import { useEffect, useRef, useState } from "react";
import { api, formatAmount } from "../api";
import Modal from "../components/Modal";

// Users prepare and edit the emails here. Their "Send" puts them in Pending Mails, where an admin sends them.
export default function EmailsPage({ uploadId, config, onOpenPending }) {
  const [emails, setEmails] = useState([]);
  const [warnings, setWarnings] = useState([]);   // partners that got no email
  const [notices, setNotices] = useState([]);     // partners whose failed addresses were left out
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState("");            // "preparing" | "sending" | ""
  const [submitted, setSubmitted] = useState(0);   // > 0: show the "pending" pop-up
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
    setBusy("sending");
    setMessage(null);
    try {
      const data = await api.submitEmails(uploadId);
      setEmails(data.emails);
      setSubmitted(data.submitted);
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
  const draftCount = emails.filter(isDraft).length;

  return (
    <div className="page">
      <section className="card">
        <div className="row-between">
          <div>
            <h2>Prepared emails ({emails.length})</h2>
            <p className="muted small">
              One consolidated email per partner. Check and edit them, then press Send:
              they go to <b>Pending Mails</b> and an admin sends them to the partners.
            </p>
          </div>
          <div className="actions">
            <button className="btn" onClick={prepare} disabled={!!busy}>
              {busy === "preparing" ? "Refreshing..." : "Refresh previews"}
            </button>
            <button
              className="btn primary"
              onClick={send}
              disabled={!!busy || draftCount === 0 || hasUnsavedEdits}
              title={hasUnsavedEdits ? "Save or discard your edits first" : "Sends them to an admin for approval"}
            >
              {busy === "sending" ? "Sending..."
                : draftCount === 0 && emails.length ? "Nothing left to send"
                : `Send ${draftCount} email(s)`}
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
                  {e.is_edited && e.status !== "SENT" && <span className="badge gray">EDITED</span>}
                </td>
                <td className="small">
                  {e.status === "PENDING" && `Waiting for an admin (sent for approval by ${e.submitted_by_name})`}
                  {e.status === "SENDING" && `Being sent by ${e.sent_by_name}`}
                  {e.status === "SENT" && `Sent ${new Date(e.sent_at).toLocaleString()}${e.sent_by_name ? ` by ${e.sent_by_name}` : ""}`}
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

      {submitted > 0 && (
        <Modal
          title="Sent for approval"
          onClose={() => setSubmitted(0)}
          actions={<>
            <button className="btn" onClick={() => setSubmitted(0)}>OK</button>
            <button className="btn primary" onClick={() => { setSubmitted(0); onOpenPending(); }}>View Pending Mails</button>
          </>}
        >
          <p><b>{submitted} email(s) are now pending.</b></p>
          <p>An admin will review them and send them to the partners. You can follow them in the Pending Mails tab.</p>
        </Modal>
      )}
    </div>
  );
}

// Drafts: what the Send button sends for approval. PENDING / SENT / FAILED ones are with an admin or done.
const isDraft = (e) => e.status === "PREPARED";

export function StatusBadge({ status }) {
  const color = { SENT: "green", FAILED: "red", PREPARED: "blue", PENDING: "amber", SENDING: "blue" }[status] || "gray";
  return <span className={`badge ${color}`}>{status}</span>;
}

// Preview card with an Edit / Preview toggle. Edits stay a local draft
// until "Save changes"; the Preview tab shows the draft as it will be sent.
// canEdit: drafts can be edited by their user; emails waiting for approval only by admins.
export function EmailPreview({ email, config, locked, onSaved, onReset, onDirtyChange, canEdit = email.status === "PREPARED" }) {
  const [mode, setMode] = useState("preview");     // "preview" | "edit"
  const [draft, setDraft] = useState(null);         // { subject, body_html } while editing
  const [editorSeed, setEditorSeed] = useState(""); // HTML loaded into the editor when it opens
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editorRef = useRef(null);

  const isSent = !canEdit || email.status === "SENT";
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
              title={!isSent ? "Edit subject and body"
                : email.status === "SENT" ? "Sent emails cannot be edited"
                : email.status === "PREPARED" ? "Edit subject and body" : "Waiting for an admin: only admins can edit it now"}
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
