import { useEffect, useState } from "react";
import { api, formatDateTime } from "../api";

const EMPTY_FORM = { institution_code: "", name: "", is_active: true, emails: [{ email: "", is_active: true }] };

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
      institution_code: p.institution_code,
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
    <div className="page">
      <section className="card">
        <div className="row-between">
          <div>
            <h2>Partners</h2>
            <p className="muted small">
              Only active partners with at least one active email address receive emails. Addresses marked
              Refused were rejected by the mail server and are left out until you fix or clear them.
              {!isAdmin && <b> Only admins can add or change partners.</b>}
            </p>
          </div>
          {isAdmin && <button className="btn primary" onClick={openNew}>+ Add partner</button>}
        </div>

        {notice && <div className="alert success">{notice}</div>}

        <table className="table">
          <thead>
            <tr><th>Code</th><th>Name</th><th>Recipient emails</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {partners.map((p) => (
              <tr key={p.id}>
                <td>{p.institution_code}</td>
                <td><b>{p.name}</b></td>
                <td>
                  {p.emails.length === 0 && <span className="text-red small">No email configured</span>}
                  {p.emails.map((e) => (
                    <div key={e.id} className={e.is_active ? "small" : "small inactive-email"}>
                      {e.email} {!e.is_active && "(inactive)"} <ProblemBadge email={e} />
                    </div>
                  ))}
                </td>
                <td>
                  <span className={`badge ${p.is_active ? "green" : "gray"}`}>{p.is_active ? "Active" : "Inactive"}</span>
                </td>
                <td className="actions">
                  {isAdmin && (
                    <>
                      <button className="btn small" onClick={() => openEdit(p)}>Edit</button>
                      <button className="btn small" onClick={() => toggleActive(p)}>
                        {p.is_active ? "Deactivate" : "Activate"}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {form && isAdmin && (
        <section className="card">
          <h2>{editingId ? "Edit partner" : "Add partner"}</h2>
          <form onSubmit={save} className="form">
            <label>
              Institution code
              <input required value={form.institution_code} onChange={(e) => setForm({ ...form, institution_code: e.target.value })} />
            </label>
            <label>
              Partner name
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
              Partner is active
            </label>

            <div>
              <div className="label">Recipient emails</div>
              {form.emails.map((em, i) => (
                <div key={i} className="email-row">
                  <input type="email" placeholder="name@partner.com" value={em.email}
                    onChange={(e) => setEmail(i, { email: e.target.value, problem: null, clear_problem: true })} />
                  <label className="checkbox">
                    <input type="checkbox" checked={em.is_active} onChange={(e) => setEmail(i, { is_active: e.target.checked })} />
                    Active
                  </label>
                  <button type="button" className="btn small" onClick={() => removeEmail(i)}>Remove</button>
                  {em.problem && !em.clear_problem && (
                    <>
                      <ProblemBadge email={em} />
                      <button type="button" className="btn small" title="Use this address again (e.g. the mailbox was fixed)"
                        onClick={() => setEmail(i, { clear_problem: true })}>Clear</button>
                    </>
                  )}
                </div>
              ))}
              <button type="button" className="btn small" onClick={addEmail}>+ Add email</button>
              <p className="muted small">New addresses are checked: the domain must exist and accept mail.</p>
            </div>

            {error && <div className="alert error">{error}</div>}

            <div className="actions">
              <button className="btn primary">Save</button>
              <button type="button" className="btn" onClick={() => setForm(null)}>Cancel</button>
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
  return <span className="badge red" title={`${email.problem} (${formatDateTime(email.problem_at)})`}>Refused</span>;
}
