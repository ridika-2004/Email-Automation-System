import { useEffect, useRef, useState } from "react";
import { api, formatDateTime } from "../api";
import { EmailEditor, EmailView } from "../components/EmailHtml";
import MailTypeBadge, { MAIL_TYPE_LABELS } from "../components/MailTypeBadge";
import { Alert, badge, btnCls, card, checkLabel, cx, h2, input, label, page, table, scrollX } from "../components/ui";

// Users keep several templates per mail type here. The default one is used for new emails;
// another can be picked for each email on the Email Preview & Send page.

const MAIL_TYPES = ["inward", "outward"];
// Plain paragraphs: the backend adds the email's spacing when it builds the email
const STARTER_BODY =
  "<p>Dear Concern,</p><p>Assalamualaikum.</p><p>Please find attached the {{txn_count}} transaction(s) " +
  "dated {{date}}.</p><p>Thank you for your continued cooperation and support.</p>" +
  "<p>Regards<br/>Reconciliation<br/>Nagad Limited</p>";
const EMPTY_FORM = { name: "", mail_type: "inward", description: "", subject: "", body_html: STARTER_BODY, is_default: false };

// Values shown in the preview instead of the placeholders
const SAMPLE = { partner_name: "bKash", date: "02 Sep 2026", txn_count: "12", total_amount: "245,500.00" };
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The template with the sample values filled in, as a partner would see it
function fillSample(text, mailType, html) {
  const values = { ...SAMPLE, mail_type: MAIL_TYPE_LABELS[mailType] };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name) =>
    values[name] === undefined ? m : html ? escapeHtml(values[name]) : values[name]);
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState([]);
  const [placeholders, setPlaceholders] = useState([]);
  const [form, setForm] = useState(null);     // null = editor closed
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => api.listTemplates()
    .then((data) => { setTemplates(data.templates); setPlaceholders(data.placeholders); })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  function open(id, values) {
    setEditingId(id);
    setForm(values);
    setError("");
    setNotice("");
    window.scrollTo({ top: 0 });
  }
  const openNew = (mailType = "inward") => open(null, { ...EMPTY_FORM, mail_type: mailType });
  const openEdit = (t) => open(t.id, pick(t));
  const openCopy = (t) => open(null, { ...pick(t), name: `Copy of ${t.name}`.slice(0, 100), is_default: false });

  // Buttons in the list: one call, then show the new list
  async function run(action, success) {
    setError("");
    setNotice("");
    try {
      setTemplates(await action());
      setNotice(success);
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(t) {
    if (!window.confirm(`Delete the template "${t.name}"? Drafts that use it switch to the default template.`)) return;
    await run(() => api.deleteTemplate(t.id), `Template "${t.name}" deleted.`);
    if (editingId === t.id) setForm(null);
  }

  async function saved(list, name) {
    setTemplates(list);
    setForm(null);
    setNotice(`Template "${name}" saved. Emails that are not sent for approval yet use it the next time previews are refreshed.`);
  }

  return (
    <div className={page}>
      {form && (
        <TemplateEditor
          key={editingId ?? "new"}
          form={form}
          editingId={editingId}
          placeholders={placeholders}
          wasDefault={!!templates.find((t) => t.id === editingId)?.is_default}
          onSaved={saved}
          onCancel={() => setForm(null)}
        />
      )}

      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_320px]">
            <h2 className={h2}>Email templates</h2>
            <p className="text-xs text-muted">
              Keep a template for each case (first notice, urgent settlement, partner-specific wording...).
              The <b>default</b> template of a mail type is used for new emails; on <b>Email Preview & Send</b> you can
              pick another one for each email. Placeholders such as <code>{"{{partner_name}}"}</code> are filled in
              for every partner.
            </p>
          </div>
          <button className={btnCls("primary")} onClick={() => openNew()}>+ New template</button>
        </div>

        {notice && <Alert type="success">{notice}</Alert>}
        {error && !form && <Alert type="error">{error}</Alert>}

        {MAIL_TYPES.map((type) => {
          const list = templates.filter((t) => t.mail_type === type);
          return (
            <div key={type} className="mt-4">
              <div className="flex items-center justify-between">
                <MailTypeBadge type={type} className="!text-xs" />
                <button className={btnCls("link")} onClick={() => openNew(type)}>+ Add {MAIL_TYPE_LABELS[type]} template</button>
              </div>
              {list.length === 0 ? (
                <p className="my-3 text-xs text-muted">No templates yet: the standard wording is used.</p>
              ) : (
                <div className={scrollX}><table className={table}>
                  <thead>
                    <tr><th>Name</th><th>Subject</th><th>Last changed</th><th></th></tr>
                  </thead>
                  <tbody>
                    {list.map((t) => (
                      <tr key={t.id} className={t.id === editingId && form ? "!bg-rose-50" : ""}>
                        <td>
                          <b>{t.name}</b> {t.is_default && <span className={badge("green")}>Default</span>}
                          {t.description && <div className="text-xs text-muted">{t.description}</div>}
                        </td>
                        <td className="text-xs">{t.subject}</td>
                        <td className="whitespace-nowrap text-xs text-muted">
                          {formatDateTime(t.updated_at)}
                          {t.updated_by_name && <div>by {t.updated_by_name}</div>}
                        </td>
                        <td>
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <button className={btnCls("default", "sm")} onClick={() => openEdit(t)}>Edit</button>
                            <button className={btnCls("default", "sm")} onClick={() => openCopy(t)}>Duplicate</button>
                            {!t.is_default && (
                              <>
                                <button className={btnCls("default", "sm")}
                                  onClick={() => run(() => api.setDefaultTemplate(t.id), `"${t.name}" is now the default ${MAIL_TYPE_LABELS[type]} template.`)}>
                                  Make default
                                </button>
                                <button className={cx(btnCls("default", "sm"), "text-red-700")} onClick={() => remove(t)}>Delete</button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

const pick = ({ name, mail_type, description, subject, body_html, is_default }) =>
  ({ name, mail_type, description, subject, body_html, is_default });

// Edit / Preview switch button (as on the Email Preview page)
const toggleBtn = (active) => cx("px-3.5 py-1.5 text-[13px]", active ? "bg-brand text-white" : "bg-white hover:bg-gray-50");

function TemplateEditor({ form: initial, editingId, placeholders, wasDefault, onSaved, onCancel }) {
  const [form, setForm] = useState(initial);
  const [mode, setMode] = useState("edit");         // "edit" | "preview"
  const [lastField, setLastField] = useState("body"); // where a placeholder button inserts
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const subjectRef = useRef(null);
  const editorRef = useRef(null);

  const set = (changes) => setForm((f) => ({ ...f, ...changes }));


  function insert(name) {
    const text = `{{${name}}}`;
    if (lastField === "subject" || mode !== "edit") {
      const el = subjectRef.current;
      const start = el?.selectionStart ?? form.subject.length;
      const end = el?.selectionEnd ?? form.subject.length;
      set({ subject: form.subject.slice(0, start) + text + form.subject.slice(end) });
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + text.length, start + text.length); });
      return;
    }
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand("insertText", false, text);
    set({ body_html: editor.innerHTML });
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const list = editingId ? await api.updateTemplate(editingId, form) : await api.createTemplate(form);
      onSaved(list, form.name.trim());
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={card}>
      <h2 className={h2}>
        {editingId ? "Edit this template" : "New template"}
      </h2>
      <form onSubmit={save} className="flex flex-col gap-3">
        <div className="grid gap-3 min-[720px]:grid-cols-[2fr_1fr]">
          <label className={label}>
            Template name
            <input className={input} required maxLength={100} value={form.name} placeholder="e.g. Inward - Urgent settlement"
              onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className={label}>
            Mail type
            <select className={input} value={form.mail_type} disabled={wasDefault}
              title={wasDefault ? "Make another template the default before changing the mail type" : ""}
              onChange={(e) => set({ mail_type: e.target.value })}>
              {MAIL_TYPES.map((t) => <option key={t} value={t}>{MAIL_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
        </div>
        <label className={label}>
          When to use it <span className="font-normal text-muted">(optional)</span>
          <input className={input} maxLength={255} value={form.description} placeholder="e.g. Second notice for partners with a large amount"
            onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className={cx(checkLabel, "flex text-[13px]")}>
          <input type="checkbox" checked={form.is_default} disabled={wasDefault}
            onChange={(e) => set({ is_default: e.target.checked })} />
          Default {MAIL_TYPE_LABELS[form.mail_type]} template (used for new emails)
        </label>

        <div className="rounded-md border border-line bg-gray-50 px-3 py-2">
          <div className="mb-1.5 text-xs text-muted">
            Insert a placeholder into the {lastField === "subject" || mode !== "edit" ? "subject" : "body"} (at the cursor):
          </div>
          <div className="flex flex-wrap gap-1.5">
            {placeholders.map((p) => (
              <button key={p.name} type="button" title={p.description}
                className="rounded border border-line bg-white px-2 py-0.5 font-mono text-xs hover:border-brand hover:text-brand"
                onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p.name)}>
                {`{{${p.name}}}`}
              </button>
            ))}
          </div>
        </div>

        <label className={label}>
          Subject
          <input ref={subjectRef} className={input} required maxLength={300} value={form.subject}
            onFocus={() => setLastField("subject")}
            onChange={(e) => set({ subject: e.target.value })} />
          {mode === "preview" && <span className="font-normal text-muted">Preview: {fillSample(form.subject, form.mail_type, false)}</span>}
        </label>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] font-semibold">Body</span>
            <div className="inline-flex overflow-hidden rounded-md border border-line [&>button+button]:border-l [&>button+button]:border-line">
              <button type="button" className={toggleBtn(mode === "edit")} onClick={() => setMode("edit")}>Edit</button>
              <button type="button" className={toggleBtn(mode === "preview")} onClick={() => setMode("preview")}>Preview with sample data</button>
            </div>
          </div>
          {mode === "edit" ? (
            <EmailEditor key="editor" editorRef={editorRef} className="h-[420px]" label="Template body" html={form.body_html}
              onFocus={() => setLastField("body")} onChange={(html) => set({ body_html: html })} />
          ) : (
            <EmailView key="preview" className="h-[420px]" html={fillSample(form.body_html, form.mail_type, true)} />
          )}
          <p className="mt-1 text-xs text-muted">
            {mode === "edit"
              ? "Click in the email to edit. Ctrl+B / Ctrl+I / Ctrl+U for bold, italic, underline. The transactions are attached as an Excel file automatically."
              : `Sample values: ${Object.entries(SAMPLE).map(([k, v]) => `${k} = ${v}`).join(", ")}.`}
          </p>
        </div>

        {error && <Alert type="error">{error}</Alert>}

        <div className="flex flex-wrap gap-2">
          <button className={btnCls("primary")} disabled={saving}>{saving ? "Saving..." : "Save template"}</button>
          <button type="button" className={btnCls()} onClick={onCancel} disabled={saving}>Cancel</button>
        </div>
      </form>
    </section>
  );
}
