import { useEffect, useState } from "react";
import { api, formatDateTime } from "../api";
import { EmailView } from "./EmailHtml";
import { Alert, btnCls, card, cx, link } from "./ui";

const STATUS_LABELS = { not_received: "Awaiting reply", received: "Reply received", reconciled: "Reconciled" };

// Follow-up history of one sent email: reply-status changes, follow-ups (open one to read it) and notes.
// Admins can add notes. Reloads when the email's status or follow-up count changes.
export default function EmailActivity({ email, isAdmin }) {
  const [events, setEvents] = useState(null);
  const [openEvent, setOpenEvent] = useState(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = () => api.emailEvents(email.id).then(setEvents).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [email.id, email.reply_status, email.followup_count]);

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

  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-[15px] font-bold">Follow-up history</h3>
        <span className="text-xs text-muted">
          Sent for approval by {email.submitted_by_name || "—"} · {formatDateTime(email.submitted_at)}
        </span>
      </div>

      {error && <Alert type="error">{error}</Alert>}

      {isAdmin && (
        <form className="mb-1 mt-3 flex items-start gap-2" onSubmit={addNote}>
          <textarea className="min-h-[38px] flex-1 resize-y rounded-md border border-line px-2.5 py-2 text-[13px] focus:border-brand focus:outline-none" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2}
            placeholder="Add a note, e.g. what the partner said on the phone…" aria-label="New note" />
          <button className={btnCls("default", "sm")} disabled={saving || !note.trim()}>{saving ? "Saving..." : "Add note"}</button>
        </form>
      )}

      <ol className="mt-3.5">
        {(events || []).map((ev) => (
          <li key={ev.id} className={item}>
            <span className={cx(dot, DOT[ev.ok ? ev.kind : "failed"])} aria-hidden="true" />
            <div>
              <div className="flex flex-wrap justify-between gap-3 text-sm">
                <TimelineTitle event={ev} />
                <span className="text-xs text-muted">{ev.created_by_name} · {formatDateTime(ev.created_at)}</span>
              </div>
              {ev.note && <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-line bg-gray-50 px-2 py-1.5 text-[13px]">{ev.note}</p>}
              {ev.kind === "followup" && (
                <>
                  <div className="text-xs text-muted">To {ev.to.join(", ")}{ev.cc.length > 0 && ` · CC ${ev.cc.join(", ")}`}</div>
                  {ev.error && <div className="text-xs text-red-700">{ev.error}</div>}
                  <button type="button" className={link} onClick={() => setOpenEvent((id) => (id === ev.id ? null : ev.id))}>
                    {openEvent === ev.id ? "▾ Hide email" : "▸ Show email"}
                  </button>
                  {openEvent === ev.id && (
                    <div className="mt-1.5">
                      <div className="text-xs"><b>Subject:</b> {ev.subject}</div>
                      <EmailView className="mt-1 h-[300px]" html={ev.body_html} />
                    </div>
                  )}
                </>
              )}
            </div>
          </li>
        ))}
        <li className={item}>
          <span className={cx(dot, DOT.sent)} aria-hidden="true" />
          <div>
            <div className="flex flex-wrap justify-between gap-3 text-sm">
              <b>Original email sent</b>
              <span className="text-xs text-muted">{email.sent_by_name || "—"} · {formatDateTime(email.sent_at)}</span>
            </div>
          </div>
        </li>
      </ol>
      {events && events.length === 0 && (
        <p className="text-xs text-muted">No follow-up activity yet{isAdmin ? ": set the reply status or send a follow-up." : "."}</p>
      )}
    </section>
  );
}

// One timeline entry: a coloured dot on a vertical line (no line after the last entry)
const item = "relative pb-3.5 pl-6 last:pb-0 before:absolute before:bottom-0 before:left-[5px] before:top-4 before:w-0.5 " +
  "before:bg-line last:before:hidden";
const dot = "absolute left-0 top-1 h-3 w-3 rounded-full border-2 border-white ring-1 ring-gray-300";
const DOT = {"status": "bg-blue-500", "followup": "bg-brand", "note": "bg-amber-500", "remarks": "bg-violet-500", "failed": "bg-red-900", "sent": "bg-green-600"};

function TimelineTitle({ event }) {
  if (event.kind === "status") return <span>Marked as <b>{STATUS_LABELS[event.reply_status] || event.reply_status}</b></span>;
  if (event.kind === "note") return <b>Note</b>;
  if (event.kind === "remarks") return <b>{event.note ? "Remarks updated" : "Remarks cleared"}</b>;
  return event.ok ? <b>Follow-up sent</b> : <b className="text-red-700">Follow-up failed</b>;
}
