import { Fragment, useEffect, useRef, useState } from "react";
import { api, formatAmount, formatDateTime } from "../api";
import { EmailPreview } from "./EmailsPage";

// Every sent email. Search, filter by partner and sort by date; open one with ▸ to read it as it was sent.
export default function SentPage({ config }) {
  const [emails, setEmails] = useState([]);
  const [partners, setPartners] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [sort, setSort] = useState("newest");
  const [dateFrom, setDateFrom] = useState(""); // "YYYY-MM-DD", both days included
  const [dateTo, setDateTo] = useState("");

  function load(search = q) {
    setLoading(true);
    setError("");
    api.sentEmails({ q: search.trim(), partner_id: partnerId, sort, date_from: dateFrom, date_to: dateTo })
      .then(setEmails)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    api.listPartners().then(setPartners).catch(() => {});
  }, []);
  // partner, dates and sort apply at once; typing waits until you pause
  useEffect(() => { load(); }, [partnerId, sort, dateFrom, dateTo]);
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) { typed.current = true; return; } // first render: already loaded above
    const t = setTimeout(() => load(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filtered = q.trim() || partnerId || dateFrom || dateTo;
  const clear = () => { setQ(""); setPartnerId(""); setDateFrom(""); setDateTo(""); };

  return (
    <div className="page">
      <section className="card">
        <div className="row-between">
          <div>
            <h2>Sent mails ({emails.length})</h2>
            <p className="muted small">Emails already sent to partners, from every uploaded file. Open one with ▸ to read it.</p>
          </div>
          <button className="btn" onClick={() => load()}>Refresh</button>
        </div>

        <div className="filters">
          <input type="search" className="filter-search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search partner, subject, address, file or sender…" aria-label="Search sent mails" />
          <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} aria-label="Filter by partner">
            <option value="">All partners</option>
            {[...partners].sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.institution_code})</option>
            ))}
          </select>
          <label className="filter-date">
            From
            <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="filter-date">
            To
            <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by date">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
          {filtered && <button className="btn small" onClick={clear}>Clear filters</button>}
        </div>

        {error && <div className="alert error">{error}</div>}
        {!emails.length && !error && !loading && (
          <p className="muted">{filtered ? "No sent mails match your search." : "No emails have been sent yet."}</p>
        )}

        {emails.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th /><th>Partner</th><th>File</th><th className="num">Txns</th><th className="num">Amount (BDT)</th>
                <th>Sent</th><th>Sent for approval</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <Fragment key={e.id}>
                  <tr className={`clickable ${openId === e.id ? "selected" : ""}`}
                    onClick={() => setOpenId((id) => (id === e.id ? null : e.id))}>
                    <td className="chevron" aria-label={openId === e.id ? "Hide email" : "Show email"}>
                      {openId === e.id ? "▾" : "▸"}
                    </td>
                    <td><b>{e.partner_name}</b> <span className="muted">({e.institution_code})</span>
                      <div className="small muted">{e.to.join(", ")}</div>
                      {e.delivery_issues.map((i) => (
                        <div key={i.email} className="small text-red" title={i.reason}>Refused: {i.email}</div>
                      ))}
                    </td>
                    <td className="small">{e.upload_filename} <span className="muted">#{e.upload_id}</span></td>
                    <td className="num">{e.txn_count}</td>
                    <td className="num">{formatAmount(e.total_amount)}</td>
                    <td className="small">{formatDateTime(e.sent_at)}
                      <div className="muted">by <span title={e.sent_by || ""}>{e.sent_by_name || "—"}</span></div></td>
                    <td className="small"><span title={e.submitted_by || ""}>{e.submitted_by_name || "—"}</span>
                      <div className="muted">{formatDateTime(e.submitted_at)}</div></td>
                  </tr>
                  {openId === e.id && (
                    <tr className="expanded-row">
                      <td colSpan={7}>
                        <EmailPreview email={e} config={config} locked canEdit={false}
                          onSaved={() => {}} onReset={() => {}} onDirtyChange={() => {}} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
