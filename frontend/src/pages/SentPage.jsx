import { Fragment, useEffect, useRef, useState } from "react";
import { api, formatAmount, formatDateTime } from "../api";
import EmailActivity from "../components/EmailActivity";
import FollowUpModal from "../components/FollowUpModal";
import MailTypeBadge from "../components/MailTypeBadge";
import { EmailPreview } from "./EmailsPage";
import { Alert, badge, btnCls, card, chevron, cx, expandedCell, h2, input, num, page, rowCls, table, scrollX } from "../components/ui";

// Reply-status chip (filter) and select / badge colours
const CHIP_ACTIVE = {
  all: "border-ink bg-ink text-white",
  not_received: "border-gray-500 bg-gray-100",
  due: "border-amber-500 bg-amber-100 text-amber-800",
  received: "border-blue-500 bg-blue-100 text-blue-800",
  reconciled: "border-green-500 bg-green-100 text-green-800",
};
const chipCls = (id, active) => cx(
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors",
  active ? CHIP_ACTIVE[id] : "border-line bg-white text-ink hover:border-gray-400",
);
const REPLY_COLORS = {
  not_received: "border-gray-300 bg-gray-100 text-gray-700",
  received: "border-blue-300 bg-blue-100 text-blue-800",
  reconciled: "border-green-300 bg-green-100 text-green-800",
};
const replyCls = (status) => cx("inline-block rounded-full border px-2.5 py-1 text-xs font-semibold", REPLY_COLORS[status]);

export const REPLY_STATUSES = [
  { id: "not_received", label: "Awaiting reply" },
  { id: "received", label: "Reply received" },
  { id: "reconciled", label: "Reconciled" },
];
export const replyLabel = (id) => REPLY_STATUSES.find((s) => s.id === id)?.label || id;

// "today", "yesterday", "5 days ago"
export function daysAgo(iso) {
  if (!iso) return "";
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

// Every sent email. Search, filter and sort; open one with ▸ to read it and see its follow-up history.
// Admins track replies here: set the reply status, send follow-ups and add notes.
export default function SentPage({ config, isAdmin }) {
  const [emails, setEmails] = useState([]);
  const [summary, setSummary] = useState(null);
  const [partners, setPartners] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [followUp, setFollowUp] = useState(null);   // email being followed up (composer open)
  const [savingId, setSavingId] = useState(null);   // email whose reply status is being saved
  const [q, setQ] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [sort, setSort] = useState("newest");
  const [dateFrom, setDateFrom] = useState(""); // "YYYY-MM-DD", both days included
  const [dateTo, setDateTo] = useState("");
  const [reply, setReply] = useState("");       // "" = all, a reply status, or "due"

  function load(search = q) {
    setLoading(true);
    setError("");
    const filters = { q: search.trim(), partner_id: partnerId, date_from: dateFrom, date_to: dateTo };
    Promise.all([api.sentEmails({ ...filters, sort, reply }), api.sentSummary(filters)])
      .then(([list, counts]) => { setEmails(list); setSummary(counts); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    api.listPartners().then(setPartners).catch(() => {});
  }, []);
  // filters apply at once; typing waits until you pause
  useEffect(() => { load(); }, [partnerId, sort, dateFrom, dateTo, reply]);
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) { typed.current = true; return; } // first render: already loaded above
    const t = setTimeout(() => load(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filtered = q.trim() || partnerId || dateFrom || dateTo || reply;
  const clear = () => { setQ(""); setPartnerId(""); setDateFrom(""); setDateTo(""); setReply(""); };
  const replaceEmail = (updated) => setEmails((list) => list.map((e) => (e.id === updated.id ? updated : e)));

  async function changeStatus(email, status) {
    setSavingId(email.id);
    setMessage(null);
    try {
      replaceEmail(await api.setReplyStatus(email.id, status));
      api.sentSummary({ q: q.trim(), partner_id: partnerId, date_from: dateFrom, date_to: dateTo }).then(setSummary).catch(() => {});
      setMessage({ type: "success", text: `${email.partner_name}: marked as “${replyLabel(status)}”.` });
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setSavingId(null);
    }
  }

  function followUpSent(updated, refused) {
    setFollowUp(null);
    replaceEmail(updated);
    load();
    setMessage(refused.length
      ? { type: "warning", text: `Follow-up sent to ${updated.partner_name}, but the mail server refused: ${refused.join(", ")}.` }
      : { type: "success", text: `Follow-up sent to ${updated.partner_name}.` });
  }

  const chips = summary && [
    { id: "", label: "All", count: summary.total },
    { id: "not_received", label: "Awaiting reply", count: summary.not_received },
    { id: "due", label: "Follow-up due", count: summary.due, tone: "due",
      title: `No reply and nothing sent for ${summary.due_after_days}+ days` },
    { id: "received", label: "Reply received", count: summary.received },
    { id: "reconciled", label: "Reconciled", count: summary.reconciled },
  ];
  const columns = isAdmin ? 10 : 9;

  return (
    <div className={page}>
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_320px]">
            <h2 className={h2}>Sent mails ({emails.length})</h2>
            <p className="text-xs text-muted">
              Emails already sent to partners, from every uploaded file. Open one with ▸ to read it and see its follow-up history.
              {isAdmin && " Set the reply status as replies come in, and follow up where needed."}
            </p>
          </div>
          <button className={btnCls()} onClick={() => load()}>Refresh</button>
        </div>

        {chips && (
          <div className="mb-1 mt-3.5 flex flex-wrap gap-2" role="tablist" aria-label="Filter by reply status">
            {chips.map((c) => (
              <button key={c.id || "all"} role="tab" aria-selected={reply === c.id} title={c.title}
                className={chipCls(c.tone || c.id || "all", reply === c.id)}
                onClick={() => setReply(c.id)}>
                {c.label}{" "}
                <span className={cx("rounded-full px-2 py-px text-xs",
                  reply === c.id ? "bg-white/70" : c.tone === "due" ? "bg-amber-100 text-amber-800" : "bg-gray-100")}>{c.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className="my-3 flex flex-wrap items-center gap-2">
          <input type="search" className={cx(input, "min-w-0 flex-[1_1_260px]")} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search partner, subject, address, file, remarks or sender…" aria-label="Search sent mails" />
          <select className={cx(input, "w-auto")} value={partnerId} onChange={(e) => setPartnerId(e.target.value)} aria-label="Filter by partner">
            <option value="">All partners</option>
            {[...partners].sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[13px] text-muted">
            From
            <input className={cx(input, "w-auto")} type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label className="flex items-center gap-1.5 text-[13px] text-muted">
            To
            <input className={cx(input, "w-auto")} type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <select className={cx(input, "w-auto")} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort by date">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
          {filtered && <button className={btnCls("default", "sm")} onClick={clear}>Clear filters</button>}
        </div>

        {message && <Alert type={message.type}>{message.text}</Alert>}
        {error && <Alert type="error">{error}</Alert>}
        {!emails.length && !error && !loading && (
          <p className="text-muted">{filtered ? "No sent mails match these filters." : "No emails have been sent yet."}</p>
        )}

        {emails.length > 0 && (
          <div className={scrollX}><table className={table}>
            <thead>
              <tr>
                <th /><th>Partner</th><th>File</th><th className={num}>Txns</th><th className={num}>Amount (BDT)</th>
                <th>Sent</th><th>Reply status</th>
                <th title="Filled in automatically: follow-ups sent, when the last one went out, and whether one is due">Follow-up log</th>
                <th>Remarks</th>{isAdmin && <th />}
              </tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <Fragment key={e.id}>
                  <tr className={rowCls(openId === e.id)}
                    onClick={() => setOpenId((id) => (id === e.id ? null : e.id))}>
                    <td className={chevron} aria-label={openId === e.id ? "Hide email" : "Show email"}>
                      {openId === e.id ? "▾" : "▸"}
                    </td>
                    <td><b>{e.partner_name}</b>
                      <div><MailTypeBadge type={e.mail_type} /></div>
                      <div className="text-xs text-muted">{e.to.join(", ")}</div>
                      {e.delivery_issues.map((i) => (
                        <div key={i.email} className="text-xs text-red-700" title={i.reason}>Refused: {i.email}</div>
                      ))}
                    </td>
                    <td className="text-xs">{e.upload_filename} <span className="text-muted">#{e.upload_id}</span></td>
                    <td className={num}>{e.txn_count}</td>
                    <td className={num}>{formatAmount(e.total_amount)}</td>
                    <td className="text-xs">{formatDateTime(e.sent_at)}
                      <div className="text-muted">by <span title={e.sent_by || ""}>{e.sent_by_name || "—"}</span></div></td>
                    <td className="text-xs" onClick={(ev) => isAdmin && ev.stopPropagation()}>
                      {isAdmin ? (
                        <select className={cx(replyCls(e.reply_status), "cursor-pointer pr-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand")} value={e.reply_status}
                          disabled={savingId === e.id} aria-label={`Reply status for ${e.partner_name}`}
                          onChange={(ev) => changeStatus(e, ev.target.value)}>
                          {REPLY_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                        </select>
                      ) : (
                        <span className={replyCls(e.reply_status)}>{replyLabel(e.reply_status)}</span>
                      )}
                      {e.reply_status_by_name && (
                        <div className="text-muted" title={formatDateTime(e.reply_status_at)}>
                          by {e.reply_status_by_name} · {daysAgo(e.reply_status_at)}
                        </div>
                      )}
                    </td>
                    <td className="text-xs">
                      {e.followup_count > 0
                        ? <>{e.followup_count} sent<div className="text-muted" title={formatDateTime(e.last_followup_at)}>last {daysAgo(e.last_followup_at)}</div></>
                        : <span className="text-muted">None</span>}
                      {e.followup_due && <div><span className={badge("amber")} title={`No reply for ${summary?.due_after_days ?? 3}+ days`}>Follow-up due</span></div>}
                    </td>
                    <td className="min-w-[170px] max-w-[260px] text-xs" onClick={(ev) => isAdmin && ev.stopPropagation()}>
                      <RemarksCell email={e} isAdmin={isAdmin} onSaved={replaceEmail} />
                    </td>
                    {isAdmin && (
                      <td className={num} onClick={(ev) => ev.stopPropagation()}>
                        {e.reply_status === "reconciled"
                          ? <span className="text-xs text-muted" title="Reconciled emails are closed">Closed</span>
                          : <button className={btnCls("default", "sm")} onClick={() => setFollowUp(e)}>Follow up</button>}
                      </td>
                    )}
                  </tr>
                  {openId === e.id && (
                    <tr>
                      <td colSpan={columns} className={expandedCell}>
                        <EmailActivity email={e} isAdmin={isAdmin} />
                        <EmailPreview email={e} config={config} locked canEdit={false}
                          onSaved={() => {}} onReset={() => {}} onDirtyChange={() => {}} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      {followUp && (
        <FollowUpModal email={followUp} onClose={() => setFollowUp(null)} onSent={followUpSent} />
      )}
    </div>
  );
}

// Remarks cell: everyone reads; admins click to edit in place (Enter saves, Shift+Enter new line, Esc cancels)
function RemarksCell({ email, isAdmin, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(email.remarks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const by = email.remarks && email.remarks_by_name ? `${email.remarks_by_name} · ${formatDateTime(email.remarks_at)}` : "";

  if (!isAdmin) {
    return email.remarks ? <div className="whitespace-pre-wrap break-words" title={by}>{email.remarks}</div> : <span className="text-muted">—</span>;
  }

  function start() {
    setValue(email.remarks);
    setError("");
    setEditing(true);
  }

  async function save() {
    if (value.trim() === email.remarks) { setEditing(false); return; }
    setSaving(true);
    setError("");
    try {
      onSaved(await api.setRemarks(email.id, value));
      setEditing(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
  }

  if (editing) {
    return (
      <div>
        <textarea className="w-full resize-y rounded-md border border-brand px-2 py-1.5 text-xs shadow-focus focus:outline-none" autoFocus value={value} maxLength={500} rows={3} disabled={saving}
          onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown}
          aria-label={`Remarks for ${email.partner_name}`} placeholder="Type remarks…" />
        {error && <div className="text-red-700">{error}</div>}
        <div className="mt-1 flex items-center justify-end gap-1.5">
          <span className="mr-auto text-[11px] text-muted">{value.length}/500</span>
          <button type="button" className={btnCls("default", "sm")} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          <button type="button" className={btnCls("primary", "sm")} onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" onClick={start}
      className={cx("group relative line-clamp-3 w-full cursor-text whitespace-pre-wrap break-words rounded-md border border-dashed",
        "border-transparent bg-transparent py-1.5 pl-2 pr-6 text-left text-xs hover:border-gray-400 hover:bg-gray-50",
        "focus-visible:border-gray-400 focus-visible:bg-gray-50 focus-visible:outline-none", !email.remarks && "italic text-muted")}
      title={by ? `Last edited by ${by}. Click to edit` : "Click to add remarks"}>
      {email.remarks || "Add remarks…"}
      <span className={cx("absolute right-1.5 top-1 text-muted transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
        email.remarks ? "opacity-0" : "opacity-100")} aria-hidden="true">✎</span>
    </button>
  );
}
