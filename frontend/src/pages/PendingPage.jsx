import { Fragment, useEffect, useRef, useState } from "react";
import { api, formatAmount, formatDateTime } from "../api";
import MailTypeBadge from "../components/MailTypeBadge";
import Modal from "../components/Modal";
import { EmailPreview, StatusBadge } from "./EmailsPage";
import { Alert, badge, btnCls, card, chevron, expandedCell, h2, num, page, rowCls, table } from "../components/ui";

// Emails users sent for approval (PENDING) and ones whose sending failed (FAILED), from every upload.
// Everyone can see them; admins tick the ones to send, and can edit them first.
export default function PendingPage({ config, isAdmin }) {
  const [emails, setEmails] = useState([]);
  const [selected, setSelected] = useState(() => new Set()); // ids ticked for sending
  const [openId, setOpenId] = useState(null);       // row expanded with the preview
  const [dirtyId, setDirtyId] = useState(null);     // row with unsaved edits
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  function show(list) {
    setEmails(list);
    setSelected((s) => new Set(list.filter((e) => s.has(e.id) && e.status !== "SENDING").map((e) => e.id))); // forget rows that left
  }
  const load = () => api.pendingEmails().then(show).catch((e) => setMessage({ type: "error", text: e.message }));
  useEffect(() => { load(); }, []);

  function toggleOpen(id) {
    if (dirtyId && dirtyId !== id && !window.confirm("You have unsaved edits. Discard them?")) return;
    setOpenId((current) => (current === id ? null : id));
  }

  function toggleSelected(id) {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // emails another admin is sending right now cannot be ticked
  const selectable = emails.filter((e) => e.status !== "SENDING");
  const allSelected = selectable.length > 0 && selected.size === selectable.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((e) => e.id)));
  const chosen = emails.filter((e) => selected.has(e.id));

  async function sendConfirmed() {
    setConfirming(false);
    setBusy(true);
    setMessage(null);
    try {
      const data = await api.sendSelected([...selected]);
      show(data.emails);
      setSelected(new Set());
      setOpenId(null);
      const skipped = data.skipped.length ? ` Skipped: ${data.skipped.join("; ")}.` : "";
      setMessage({
        type: data.failed || data.skipped.length ? "warning" : "success",
        text: `${data.sent} email(s) sent${data.failed ? `, ${data.failed} failed (still listed below)` : ""}. Sent emails are in Sent Mails.${skipped}`,
      });
    } catch (e) {
      setMessage({ type: "error", text: e.message });
      load(); // another admin may have sent some of them
    } finally {
      setBusy(false);
    }
  }

  const replaceEmail = (updated) => setEmails((list) => list.map((e) => (e.id === updated.id ? updated : e)));
  const columns = isAdmin ? 8 : 7;

  return (
    <div className={page}>
      <section className={card}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className={h2}>Pending mails ({emails.length})</h2>
            <p className="text-xs text-muted">
              Emails sent for approval, from every uploaded file.{" "}
              {isAdmin ? "Tick the ones to send. Open one with ▸ to preview or edit it first." : "An admin reviews and sends them."}
            </p>
          </div>
          <div className="flex gap-2">
            <button className={btnCls()} onClick={load} disabled={busy}>Refresh</button>
            {isAdmin && (
              <button className={btnCls("primary")} disabled={busy || !selected.size || !!dirtyId}
                title={dirtyId ? "Save or discard your edits first" : !selected.size ? "Tick the emails to send" : ""}
                onClick={() => setConfirming(true)}>
                {busy ? "Sending..." : allSelected ? `Send all (${selected.size})` : `Send selected (${selected.size})`}
              </button>
            )}
          </div>
        </div>

        {message && <Alert type={message.type}>{message.text}</Alert>}
        {!emails.length && <p className="text-muted">No pending mails.</p>}

        {emails.length > 0 && (
          <table className={table}>
            <thead>
              <tr>
                {isAdmin && (
                  <th className="w-8 !text-center">
                    <SelectAll checked={allSelected} partial={selected.size > 0 && !allSelected} onChange={toggleAll} />
                  </th>
                )}
                <th /><th>Partner</th><th>File</th><th className={num}>Txns</th><th className={num}>Amount (BDT)</th>
                <th>Sent for approval</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {emails.map((e) => (
                <Fragment key={e.id}>
                  <tr className={rowCls(openId === e.id)} onClick={() => toggleOpen(e.id)}>
                    {isAdmin && (
                      <td className="w-8 !text-center [&>input]:h-4 [&>input]:w-4 [&>input]:cursor-pointer [&>input]:accent-brand" onClick={(ev) => ev.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggleSelected(e.id)}
                          disabled={e.status === "SENDING"} aria-label={`Select email to ${e.partner_name}`} />
                      </td>
                    )}
                    <td className={chevron} aria-label={openId === e.id ? "Hide email" : "Show email"}>
                      {openId === e.id ? "▾" : "▸"}
                    </td>
                    <td><b>{e.partner_name}</b>
                      <div><MailTypeBadge type={e.mail_type} /></div>
                      <div className="text-xs text-muted">{e.to.join(", ")}</div></td>
                    <td className="text-xs">{e.upload_filename} <span className="text-muted">#{e.upload_id}</span></td>
                    <td className={num}>{e.txn_count}</td>
                    <td className={num}>{formatAmount(e.total_amount)}</td>
                    <td className="text-xs"><span title={e.submitted_by || ""}>{e.submitted_by_name || "—"}</span>
                      <div className="text-muted">{formatDateTime(e.submitted_at)}</div></td>
                    <td>
                      <StatusBadge status={e.status} />{" "}
                      {e.is_edited && <span className={badge("gray")}>EDITED</span>}
                      {e.status === "FAILED" && <div className="text-xs text-red-700">{e.error}</div>}
                      {e.status === "SENDING" && <div className="text-xs text-muted">Being sent by {e.sent_by_name}</div>}
                    </td>
                  </tr>
                  {openId === e.id && (
                    <tr>
                      <td colSpan={columns} className={expandedCell}>
                        <EmailPreview
                          email={e}
                          config={config}
                          locked={busy}
                          canEdit={isAdmin && e.status !== "SENDING"}
                          onSaved={replaceEmail}
                          onReset={load}
                          onDirtyChange={(dirty) => setDirtyId((id) => (dirty ? e.id : id === e.id ? null : id))}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {confirming && (
        <Modal
          title={`Send ${chosen.length} email(s)?`}
          onClose={() => setConfirming(false)}
          actions={<>
            <button className={btnCls()} onClick={() => setConfirming(false)}>Cancel</button>
            <button className={btnCls("primary")} onClick={sendConfirmed}>Send now</button>
          </>}
        >
          <p>These emails go out to the partners now. This can't be undone.</p>
          <ul className="mt-2 max-h-60 list-disc overflow-y-auto pl-[18px] [&>li]:my-1 [&>li]:break-words">
            {chosen.map((e) => (
              <li key={e.id}>
                <b>{e.partner_name}</b> → {e.to.join(", ")}
                <span className="text-xs text-muted"> · {e.txn_count} txn(s), BDT {formatAmount(e.total_amount)}</span>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

// Header checkbox: ticked = all, dash = some
function SelectAll({ checked, partial, onChange }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = partial; }, [partial]);
  return <input ref={ref} type="checkbox" className="h-4 w-4 cursor-pointer accent-brand" checked={checked} onChange={onChange} aria-label="Select all emails" title="Select all" />;
}
