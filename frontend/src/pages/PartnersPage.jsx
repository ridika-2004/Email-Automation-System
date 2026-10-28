import { useEffect, useState } from "react";
import { api, formatDateTime } from "../api";
import { Alert, badge, btnCls, card, checkLabel, formCls, h2, input, page, table, scrollX } from "../components/ui";

const EMPTY_FORM = { name: "", is_active: true, emails: [{ email: "", is_active: true }] };

export default function PartnersPage({ isAdmin }) {
  const [partners, setPartners] = useState([]);
  const [form, setForm] = useState(null);     // null = form closed
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = () => api.listPartners().then(setPartners).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  function openNew() {
    setEditingId(null);
    setForm(structuredClone(EMPTY_FORM));
    setError("");
  }

  function openEdit(p) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      is_active: p.is_active,
      emails: p.emails.length
        ? p.emails.map(({ email, is_active, problem, problem_at }) => ({ email, is_active, problem, problem_at, clear_problem: false }))
        : [{ email: "", is_active: true }],
    });
    setError("");
  }

  // --- small helpers to change the email list inside the form
  const setEmail = (index, changes) =>
    setForm({ ...form, emails: form.emails.map((e, i) => (i === index ? { ...e, ...changes } : e)) });
  const addEmail = () => setForm({ ...form, emails: [...form.emails, { email: "", is_active: true }] });
  const removeEmail = (index) => setForm({ ...form, emails: form.emails.filter((_, i) => i !== index) });

  async function save(e) {
    e.preventDefault();
    setError("");
    const payload = { ...form, emails: form.emails.filter((x) => x.email.trim() !== "") };
    try {
      if (editingId) await api.updatePartner(editingId, payload);
      else await api.createPartner(payload);
      setNotice(`Partner "${payload.name}" saved.`);
      setForm(null);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleActive(p) {
    await api.updatePartner(p.id, { ...p, is_active: !p.is_active });
    load();
  }

  return (
    <div className={page}>
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_320px]">
            <h2 className={h2}>Partners</h2>
            <p className="text-xs text-muted">
              Rows of an uploaded file go to the partner whose name matches their KEY_ORG_NM.
              Only active partners with at least one active email address receive emails. Addresses marked
              Refused were rejected by the mail server and are left out until you fix or clear them.
              {!isAdmin && <b> Only admins can add or change partners.</b>}
            </p>
          </div>
          {isAdmin && <button className={btnCls("primary")} onClick={openNew}>+ Add partner</button>}
        </div>

        {notice && <Alert type="success">{notice}</Alert>}

        <div className={scrollX}><table className={table}>
          <thead>
            <tr><th>Name (KEY_ORG_NM)</th><th>Recipient emails</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {partners.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b></td>
                <td>
                  {p.emails.length === 0 && <span className="text-xs text-red-700">No email configured</span>}
                  {p.emails.map((e) => (
                    <div key={e.id} className={e.is_active ? "text-xs" : "text-xs text-muted line-through"}>
                      {e.email} {!e.is_active && "(inactive)"} <ProblemBadge email={e} />
                    </div>
                  ))}
                </td>
                <td>
                  <span className={badge(p.is_active ? "green" : "gray")}>{p.is_active ? "Active" : "Inactive"}</span>
                </td>
                <td className="flex flex-wrap gap-2">
                  {isAdmin && (
                    <>
                      <button className={btnCls("default", "sm")} onClick={() => openEdit(p)}>Edit</button>
                      <button className={btnCls("default", "sm")} onClick={() => toggleActive(p)}>
                        {p.is_active ? "Deactivate" : "Activate"}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      {form && isAdmin && (
        <section className={card}>
          <h2 className={h2}>{editingId ? "Edit partner" : "Add partner"}</h2>
          <form onSubmit={save} className={formCls}>
            <label>
              Partner name
              <input className={input} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. bKash" />
              <small className="text-muted">Exactly as in the KEY_ORG_NM column of the file (upper / lower case doesn't matter).</small>
            </label>
            <label className={checkLabel}>
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Partner is active
            </label>

            <div>
              <div className="mb-1.5 text-[13px] font-semibold">Recipient emails</div>
              {form.emails.map((em, i) => (
                <div key={i} className="mb-1.5 flex items-center gap-2 [&>input[type=email]]:flex-1">
                  <input className={input} type="email" placeholder="name@partner.com" value={em.email}
                    onChange={(e) => setEmail(i, { email: e.target.value, problem: null, clear_problem: true })} />
                  <label className={checkLabel}>
                    <input type="checkbox" checked={em.is_active} onChange={(e) => setEmail(i, { is_active: e.target.checked })} />
                    Active
                  </label>
                  <button type="button" className={btnCls("default", "sm")} onClick={() => removeEmail(i)}>Remove</button>
                  {em.problem && !em.clear_problem && (
                    <>
                      <ProblemBadge email={em} />
                      <button type="button" className={btnCls("default", "sm")} title="Use this address again (e.g. the mailbox was fixed)"
                        onClick={() => setEmail(i, { clear_problem: true })}>Clear</button>
                    </>
                  )}
                </div>
              ))}
              <button type="button" className={btnCls("default", "sm")} onClick={addEmail}>+ Add email</button>
              <p className="text-xs text-muted">New addresses are checked: the domain must exist and accept mail.</p>
            </div>

            {error && <Alert type="error">{error}</Alert>}

            <div className="flex flex-wrap gap-2">
              <button className={btnCls("primary")}>Save</button>
              <button type="button" className={btnCls()} onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}

// "Refused" for an address the mail server rejected
function ProblemBadge({ email }) {
  if (!email.problem) return null;
  return <span className={badge("red")} title={`${email.problem} (${formatDateTime(email.problem_at)})`}>Refused</span>;
}
