import { useEffect, useState } from "react";
import { api, formatDateTime } from "../api";
import { EmailView } from "./EmailHtml";
import { Alert, btnCls, card, cx, link } from "./ui";

const STATUS_LABELS = { not_received: "Awaiting reply", received: "Reply received", reconciled: "Reconciled" };
const PARTNER_KINDS = ["reply", "auto_reply", "bounce"];

// History of one email, oldest first: sent for approval, sent (or failed), follow-ups, every message
// from the partner (open one to read it), reply-status changes, notes and remarks.
// Admins can add notes to sent emails. Reloads when the email's status or follow-up count changes.
export default function EmailActivity({ email, isAdmin }) {
  const [events, setEvents] = useState(null);
  const [openEvent, setOpenEvent] = useState(null);
  const [messages, setMessages] = useState({}); // reply id -> the partner's message, once opened
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = () => api.emailEvents(email.id).then(setEvents).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [email.id, email.status, email.reply_status, email.followup_count]);

  function toggle(ev) {
    setOpenEvent((id) => (id === ev.id ? null : ev.id));
    if (ev.reply_id && !messages[ev.reply_id]) {
      api.getReply(ev.reply_id).then((r) => setMessages((all) => ({ ...all, [r.id]: r }))).catch((e) => setError(e.message));
    }
  }

  async function addNote(e) {
    e.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    setError("");
    try {
      await api.addEmailNote(email.id, note);
      setNote("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function download(replyId, attachment) {
    try {
      await api.downloadReplyAttachment(replyId, attachment);
    } catch (err) {
      setError(err.message);
    }
  }

  const replies = (events || []).filter((ev) => ev.kind === "reply").length;

  return (
    <section className={card}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-[15px] font-bold">Email history</h3>
        {events && (
          <span className="text-xs text-muted">
            {events.length} {events.length === 1 ? "entry" : "entries"} · {replies} {replies === 1 ? "reply" : "replies"} from the partner
          </span>
        )}
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {!events && !error && <p className="mt-2 text-xs text-muted">Loading...</p>}

      <ol className="mt-3.5">
        {(events || []).map((ev) => (
          <li key={`${ev.kind}-${ev.id}`} className={item}>
            <span className={cx(dot, DOT[ev.ok ? ev.kind : "failed"] || "bg-gray-400")} aria-hidden="true" />
            <div className="min-w-0">
              <div className="flex flex-wrap justify-between gap-x-3 text-sm">
                <TimelineTitle event={ev} />
                <span className="text-xs text-muted">{ev.created_by_name || "—"} · {formatDateTime(ev.created_at)}</span>
              </div>
              <Details event={ev} />
              {(ev.kind === "followup" || PARTNER_KINDS.includes(ev.kind)) && (
                <button type="button" className={link} onClick={() => toggle(ev)}>
                  {openEvent === ev.id ? "▾ Hide" : "▸ Show"} {ev.kind === "followup" ? "email" : "message"}
                </button>
              )}
              {openEvent === ev.id && ev.kind === "followup" && (
                <div className="mt-1.5">
                  <div className="text-xs"><b>Subject:</b> {ev.subject}</div>
                  <EmailView className="mt-1 max-h-[300px]" html={ev.body_html} />
                </div>
              )}
              {openEvent === ev.id && ev.reply_id && (
                messages[ev.reply_id] ? (
                  <PartnerMessage message={messages[ev.reply_id]} onDownload={(a) => download(ev.reply_id, a)} />
                ) : <div className="text-xs text-muted">Loading...</div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {events && events.length === 0 && <p className="text-xs text-muted">Nothing has happened to this email yet.</p>}

      {isAdmin && email.status === "SENT" && (
        <form className="mt-3 flex items-start gap-2 border-t border-line pt-3" onSubmit={addNote}>
          <textarea className="min-h-[38px] flex-1 resize-y rounded-md border border-line px-2.5 py-2 text-[13px] focus:border-brand focus:outline-none" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2}
            placeholder="Add a note, e.g. what the partner said on the phone…" aria-label="New note" />
          <button className={btnCls("default", "sm")} disabled={saving || !note.trim()}>{saving ? "Saving..." : "Add note"}</button>
        </form>
      )}
    </section>
  );
}

// One timeline entry: a coloured dot on a vertical line (no line after the last entry)
const item = "relative pb-3.5 pl-6 last:pb-0 before:absolute before:bottom-0 before:left-[5px] before:top-4 before:w-0.5 " +
  "before:bg-line last:before:hidden";
const dot = "absolute left-0 top-1 h-3 w-3 rounded-full border-2 border-white ring-1 ring-gray-300";
const DOT = {
  submitted: "bg-gray-500", sent: "bg-green-600", send_failed: "bg-red-900", followup: "bg-brand",
  reply: "bg-sky-500", auto_reply: "bg-gray-400", bounce: "bg-red-600",
  status: "bg-blue-500", note: "bg-amber-500", remarks: "bg-violet-500", failed: "bg-red-900",
};

function TimelineTitle({ event: ev }) {
  switch (ev.kind) {
    case "submitted": return <b>Sent for approval</b>;
    case "sent": return <b>Sent to the partner</b>;
    case "send_failed": return <b className="text-red-700">Sending failed</b>;
    case "followup": return ev.ok ? <b>Follow-up sent</b> : <b className="text-red-700">Follow-up failed</b>;
    case "reply": return <b className="text-sky-800">{ev.note}</b>;
    case "auto_reply": return <span><b>{ev.note}</b> <span className="text-xs text-muted">(doesn't count as a reply)</span></span>;
    case "bounce": return <b className="text-red-700">{ev.note}</b>;
    case "status": return <span>Marked as <b>{STATUS_LABELS[ev.reply_status] || ev.reply_status}</b></span>;
    case "note": return <b>Note</b>;
    case "remarks": return <b>{ev.note ? "Remarks updated" : "Remarks cleared"}</b>;
    default: return <b>{ev.kind}</b>;
  }
}

function Details({ event: ev }) {
  const recipients = ev.to.length > 0 && (
    <div className="text-xs text-muted">To {ev.to.join(", ")}{ev.cc.length > 0 && ` · CC ${ev.cc.join(", ")}`}</div>
  );
  if (ev.kind === "sent" || ev.kind === "followup") {
    return (
      <>
        {recipients}
        {ev.kind === "sent" && ev.note && <div className="text-xs text-muted">{ev.note}</div>}
        {ev.error && <div className="text-xs text-red-700">{ev.error}</div>}
      </>
    );
  }
  if (ev.kind === "send_failed") {
    return (
      <>
        {recipients}
        <div className="whitespace-pre-wrap break-words text-xs text-red-700">{ev.error}</div>
      </>
    );
  }
  if (PARTNER_KINDS.includes(ev.kind)) return ev.subject ? <div className="break-words text-xs text-muted">{ev.subject}</div> : null;
  if (ev.note && ["status", "note", "remarks"].includes(ev.kind)) {
    return <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-line bg-gray-50 px-2 py-1.5 text-[13px]">{ev.note}</p>;
  }
  return null;
}

function PartnerMessage({ message: m, onDownload }) {
  return (
    <div className="mt-1.5">
      <div className="text-xs text-muted">
        From {m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email} · received {formatDateTime(m.received_at)}
      </div>
      <EmailView className="mt-1 max-h-[300px]" html={m.body_html} />
      {m.attachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {m.attachments.map((a) => (
            <button key={a.id} type="button" className={btnCls("default", "sm")} onClick={() => onDownload(a)}>📎 {a.filename}</button>
          ))}
        </div>
      )}
    </div>
  );
}
