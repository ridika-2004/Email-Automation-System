import { useEffect, useRef, useState } from "react";
import { api, formatAmount } from "../api";
import MailTypeBadge, { MAIL_TYPE_LABELS } from "../components/MailTypeBadge";
import Modal from "../components/Modal";
import { Alert, badge, btnCls, card, cx, h2, link, num, page, rowCls, table } from "../components/ui";

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
  const [templates, setTemplates] = useState([]); // Email Templates: one can be picked per email

  // Every time this page opens, (re)build the previews from the current partner config
  useEffect(() => {
    prepare();
  }, [uploadId]);
  useEffect(() => {
    api.listTemplates().then((data) => setTemplates(data.templates)).catch(() => setTemplates([]));
  }, []);

  async function prepare(chosenTemplates) {
    setBusy("preparing");
    setMessage(null);
    try {
      const data = await api.prepareEmails(uploadId, chosenTemplates);
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

  // One template for every draft of a mail type
  async function chooseTemplate(mailType, templateId) {
    const edited = emails.filter((e) => isDraft(e) && e.mail_type === mailType && e.is_edited).length;
    if (edited && !window.confirm(`${edited} ${MAIL_TYPE_LABELS[mailType]} email(s) were edited by hand. Replace the edits with this template?`)) return;
    await prepare({ [mailType]: templateId });
  }

  const selected = emails.find((e) => e.id === selectedId);
  const draftCount = emails.filter(isDraft).length;
  const templateName = (id) => templates.find((t) => t.id === id)?.name;
  // Mail types that have drafts, in the template bar
  const draftTypes = Object.keys(MAIL_TYPE_LABELS).filter((type) => emails.some((e) => isDraft(e) && e.mail_type === type));

  return (
    <div className={page}>
      <section className={card}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className={h2}>Prepared emails ({emails.length})</h2>
            <p className="text-xs text-muted">
              One email per partner and mail type, with its transactions attached as an Excel file. Check and edit them, then press Send:
              they go to <b>Pending Mails</b> and an admin sends them to the partners.
            </p>
          </div>
          <div className="flex gap-2">
            <button className={btnCls()} onClick={() => prepare()} disabled={!!busy}>
              {busy === "preparing" ? "Refreshing..." : "Refresh previews"}
            </button>
            <button
              className={btnCls("primary")}
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

        {draftTypes.length > 0 && templates.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border border-line bg-gray-50 px-3 py-2.5">
            <span className="text-[13px] font-semibold">Template</span>
            {draftTypes.map((type) => {
              const drafts = emails.filter((e) => isDraft(e) && e.mail_type === type);
              const ids = new Set(drafts.map((e) => e.template_id));
              const value = ids.size === 1 ? [...ids][0] ?? "" : "";
              return (
                <label key={type} className="flex items-center gap-2 text-[13px]">
                  <MailTypeBadge type={type} />
                  <select
                    className="rounded border border-line bg-white px-2 py-1 text-[13px] focus:border-brand focus:outline-none disabled:opacity-60"
                    value={value}
                    disabled={!!busy || hasUnsavedEdits}
                    title={hasUnsavedEdits ? "Save or discard your edits first" : `Used for all ${drafts.length} ${MAIL_TYPE_LABELS[type]} email(s)`}
                    onChange={(e) => chooseTemplate(type, Number(e.target.value))}
                  >
                    {value === "" && <option value="">{ids.size > 1 ? "Different per email" : "Standard wording"}</option>}
                    {templates.filter((t) => t.mail_type === type).map((t) => (
                      <option key={t.id} value={t.id}>{t.name}{t.is_default ? " (default)" : ""}</option>
                    ))}
                  </select>
                </label>
              );
            })}
            <span className="text-xs text-muted">Applies to every email of that type not yet sent for approval. Change a single email in its preview below.</span>
          </div>
        )}

        {message && <Alert type={message.type}>{message.text}</Alert>}

        {warnings.length > 0 && (
          <Alert type="error">
            <b>No email was prepared for these partners:</b>
            <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            <span className="text-xs">Fix them in Partner Configuration, then click “Refresh previews”.</span>
          </Alert>
        )}

        {notices.length > 0 && (
          <Alert type="warning">
            <b>These addresses were left out because the mail server refused them before:</b>
            <ul>{notices.map((n) => <li key={n}>{n}</li>)}</ul>
            <span className="text-xs">Correct or clear them in Partner Configuration, then click “Refresh previews”.</span>
          </Alert>
        )}

        <table className={table}>
          <thead>
            <tr>
              <th>Partner</th><th>Mail Type</th><th>Template</th><th>To</th><th className={num}>Txns</th>
              <th className={num}>Amount (BDT)</th><th>Status</th><th>Details</th>
            </tr>
          </thead>
          <tbody>
            {emails.map((e) => (
              <tr
                key={e.id}
                className={rowCls(e.id === selectedId)}
                onClick={() => selectEmail(e.id)}
              >
                <td><b>{e.partner_name}</b></td>
                <td><MailTypeBadge type={e.mail_type} /></td>
                <td className="text-xs">{templateName(e.template_id) || <span className="text-muted">Standard wording</span>}</td>
                <td className="text-xs">{e.to.join(", ")}</td>
                <td className={num}>{e.txn_count}</td>
                <td className={num}>{formatAmount(e.total_amount)}</td>
                <td>
                  <StatusBadge status={e.status} />{" "}
                  {e.is_edited && e.status !== "SENT" && <span className={badge("gray")}>EDITED</span>}
                </td>
                <td className="text-xs">
                  {e.status === "PENDING" && `Waiting for an admin (sent for approval by ${e.submitted_by_name})`}
                  {e.status === "SENDING" && `Being sent by ${e.sent_by_name}`}
                  {e.status === "SENT" && `Sent ${new Date(e.sent_at).toLocaleString()}${e.sent_by_name ? ` by ${e.sent_by_name}` : ""}`}
                  {e.status === "FAILED" && <div className="text-red-700">{e.error}</div>}
                  {e.delivery_issues.map((i) => (
                    <div key={i.email} className="text-red-700" title={i.reason}>Refused: {i.email}</div>
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
          templates={templates}
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
            <button className={btnCls()} onClick={() => setSubmitted(0)}>OK</button>
            <button className={btnCls("primary")} onClick={() => { setSubmitted(0); onOpenPending(); }}>View Pending Mails</button>
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

// Preview / Edit switch button
const toggleBtn = (active) => cx("px-3.5 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-50",
  active ? "bg-brand text-white" : "bg-white hover:enabled:bg-gray-50");

export function StatusBadge({ status }) {
  const color = { SENT: "green", FAILED: "red", PREPARED: "blue", PENDING: "amber", SENDING: "blue" }[status] || "gray";
  return <span className={badge(color)}>{status}</span>;
}

// Preview card with an Edit / Preview toggle. Edits stay a local draft
// until "Save changes"; the Preview tab shows the draft as it will be sent.
// canEdit: drafts can be edited by their user; emails waiting for approval only by admins.
// templates (Email Templates): when given, a draft can be rebuilt from another template of its mail type.
export function EmailPreview({ email, config, templates, locked, onSaved, onReset, onDirtyChange, canEdit = email.status === "PREPARED" }) {
  const [mode, setMode] = useState("preview");     // "preview" | "edit"
  const [draft, setDraft] = useState(null);         // { subject, body_html } while editing
  const [editorSeed, setEditorSeed] = useState(""); // HTML loaded into the editor when it opens
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editorRef = useRef(null);

  const isSent = !canEdit || email.status === "SENT";
  const dirty = !!draft && (draft.subject !== email.subject || draft.body_html !== email.body_html);
  const shown = draft || email;
  const choices = (templates || []).filter((t) => t.mail_type === email.mail_type);
  const canPickTemplate = choices.length > 0 && canEdit && email.status === "PREPARED";

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

  async function downloadAttachment() {
    try {
      await api.downloadAttachment(email.id, `${email.partner_name} - ${email.mail_type_label}.xlsx`.replace(/[^\w.\- ]/g, "_"));
    } catch (e) {
      setError(e.message);
    }
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

  async function applyTemplate(templateId) {
    if (email.is_edited && !window.confirm("Replace your manual edits with this template?")) return;
    setError("");
    try {
      onSaved(await api.applyTemplate(email.id, templateId));
    } catch (e) {
      setError(e.message);
    }
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
    <section className={card}>
      <div className="flex items-start justify-between gap-3">
        <h2 className={h2}>
          Email {mode === "edit" ? "editor" : "preview"} — {email.partner_name} <MailTypeBadge type={email.mail_type} className="ml-1.5 !text-xs" />
          {dirty && <span className="text-xs text-muted"> (unsaved changes)</span>}
        </h2>
        <div className="flex gap-2">
          {(mode === "edit" || dirty) && (
            <>
              <button className={btnCls("default", "sm")} onClick={discard} disabled={saving}>Discard</button>
              <button
                className={btnCls("primary", "sm")}
                onClick={save}
                disabled={!dirty || saving || locked}
                title={dirty ? "" : "No changes to save yet"}
              >
                {saving ? "Saving..." : "Save changes"}
              </button>
            </>
          )}
          {!dirty && email.is_edited && !isSent && (
            <button className={btnCls("default", "sm")} onClick={resetToGenerated} disabled={locked}>
              Reset to generated
            </button>
          )}
          <div className="inline-flex overflow-hidden rounded-md border border-line [&>button+button]:border-l [&>button+button]:border-line">
            <button className={toggleBtn(mode === "preview")} onClick={() => setMode("preview")}>
              Preview
            </button>
            <button
              className={toggleBtn(mode === "edit")}
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

      {error && <Alert type="error">{error}</Alert>}

      <div className="mb-3 rounded-md border border-line [&>div:last-child]:border-b-0 [&>div>span:first-child]:inline-block [&>div>span:first-child]:w-[70px] [&>div>span:first-child]:text-muted [&>div]:border-b [&>div]:border-line [&>div]:px-3 [&>div]:py-2">
        {canPickTemplate && (
          <div>
            <span>Template</span>
            <select
              className="max-w-[calc(100%-80px)] rounded border border-line bg-white px-2 py-1 text-[13px] focus:border-brand focus:outline-none disabled:opacity-60"
              value={email.template_id ?? ""}
              disabled={locked || mode === "edit" || dirty}
              title={mode === "edit" || dirty ? "Save or discard your edits first" : "Rebuild this email from another template"}
              onChange={(e) => applyTemplate(Number(e.target.value))}
            >
              {!choices.some((t) => t.id === email.template_id) && <option value="">Standard wording</option>}
              {choices.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.is_default ? " (default)" : ""}</option>
              ))}
            </select>
            {email.is_edited && <span className="!w-auto pl-2 text-xs text-muted">edited by hand after applying it</span>}
          </div>
        )}
        <div><span>From</span>{config?.mail_from}</div>
        <div><span>To</span>{email.to.join(", ")}</div>
        <div><span>CC</span>{email.cc.join(", ")}</div>
        <div>
          <span>Attached</span>
          <button type="button" className={cx(link, "text-[13px]")} onClick={downloadAttachment} title="Download the attached Excel file">
            📎 Transactions ({email.txn_count}).xlsx
          </button>
        </div>
        <div>
          <span>Subject</span>
          {mode === "edit" ? (
            <input
              className="w-[calc(100%-80px)] rounded border border-line px-2 py-1 focus:border-brand focus:outline-none"
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
          className={cx("h-[520px] w-full rounded-md border border-line bg-white", "outline outline-2 -outline-offset-1 outline-brand")}
          title="Email body editor"
          srcDoc={editorSeed}
          sandbox="allow-same-origin"
          onLoad={onEditorLoad}
        />
      ) : (
        // iframe keeps the email's own styling separate from the app
        <iframe key="preview" className={"h-[520px] w-full rounded-md border border-line bg-white"} title="Email body" srcDoc={shown.body_html} sandbox="" />
      )}
      {mode === "edit" && (
        <p className="text-xs text-muted">Click in the email to edit. Ctrl+B / Ctrl+I / Ctrl+U for bold, italic, underline.</p>
      )}
    </section>
  );
}
