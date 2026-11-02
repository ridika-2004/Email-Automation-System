import { useEffect, useRef, useState } from "react";
import { api, formatAmount, formatDateTime } from "../api";
import { EmailView } from "../components/EmailHtml";
import MailTypeBadge from "../components/MailTypeBadge";
import Modal from "../components/Modal";
import { Alert, Badge, btnCls, card, cx, h2, input, page } from "../components/ui";
import { daysAgo, replyLabel } from "./SentPage";

// Partners' replies to our emails, read from the sending mailbox by the backend (inbox.py).
// New = not opened by you yet (each person has their own); the sidebar shows how many.
// summary: { unread, total, inbox, reply_to } from App, which checks it regularly; onChange(summary)
// tells App when reading changes the count.
export default function RepliesPage({ summary, onChange, isAdmin }) {
  const [replies, setReplies] = useState([]);
  const [partners, setPartners] = useState([]);
  const [show, setShow] = useState("all");
  const [q, setQ] = useState("");
  const [partnerId, setPartnerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState(null);
  const [checking, setChecking] = useState(false);
  const [openId, setOpenId] = useState(null);

  function load(search = q) {
    setLoading(true);
    setError("");
    api.listReplies({ show, q: search.trim(), partner_id: partnerId })
      .then(setReplies)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { api.listPartners().then(setPartners).catch(() => {}); }, []);
  // filters apply at once, typing waits until you pause, and new replies found by the backend show up
  useEffect(() => { load(); }, [show, partnerId, summary?.total]);
  const typed = useRef(false);
  useEffect(() => {
    if (!typed.current) { typed.current = true; return; }
    const t = setTimeout(() => load(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const setRead = (id, isRead) => setReplies((list) => list.map((r) => (r.id === id ? { ...r, is_read: isRead } : r)));

  async function markAllRead() {
    setMessage(null);
    try {
      onChange(await api.markAllRepliesRead());
      setReplies((list) => (show === "unread" ? [] : list.map((r) => ({ ...r, is_read: true }))));
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    }
  }

  async function checkNow() {
    setChecking(true);
    setMessage(null);
    try {
      const { result, summary: next } = await api.checkInboxNow();
      onChange(next);
      setMessage(result.found
        ? { type: "success", text: `${result.found} new ${result.found === 1 ? "reply" : "replies"} found.` }
        : { type: "info", text: "No new replies from partners." });
      if (!result.found) load();
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setChecking(false);
    }
  }

  const inbox = summary?.inbox;
  const unread = summary?.unread ?? 0;
  const filtered = q.trim() || partnerId;
  // Replies go to MAIL_FROM (Reply-To): if IMAP_USER reads another mailbox, they are never seen here
  const replyToElsewhere = inbox?.enabled && summary.reply_to && summary.reply_to.toLowerCase() !== inbox.mailbox.toLowerCase();

  return (
    <div className={page}>
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_320px]">
            <h2 className={h2}>Partner replies ({summary?.total ?? replies.length})</h2>
            <p className="text-xs text-muted">
              Replies from partners to the emails and follow-ups we sent. Only replies to our emails are read from the
              mailbox: other mail is never opened. A reply also sets the email's status to “Reply received”.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {unread > 0 && <button className={btnCls()} onClick={markAllRead}>Mark all as read</button>}
            {isAdmin && inbox?.enabled && (
              <button className={btnCls("primary")} onClick={checkNow} disabled={checking}>
                {checking ? "Checking..." : "Check mailbox now"}
              </button>
            )}
          </div>
        </div>

        <MailboxStatus inbox={inbox} />
        {replyToElsewhere && (
          <Alert type="warning">
            Partners' replies go to the sender <b>{summary.reply_to}</b> (MAIL_FROM), but replies are read from{" "}
            <b>{inbox.mailbox}</b>. Make IMAP_USER / IMAP_PASSWORD in backend/.env that same mailbox (or remove them).
          </Alert>
        )}

        <div className="mb-1 mt-3.5 flex flex-wrap gap-2" role="tablist" aria-label="Show">
          {[{ id: "all", label: "All", count: summary?.total }, { id: "unread", label: "New", count: unread }].map((c) => (
            <button key={c.id} role="tab" aria-selected={show === c.id} onClick={() => setShow(c.id)}
              className={cx("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors",
                show === c.id ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-gray-400")}>
              {c.label}
              <span className={cx("rounded-full px-2 py-px text-xs",
                show === c.id ? "bg-white/70 text-ink" : c.id === "unread" && c.count ? "bg-brand text-white" : "bg-gray-100")}>{c.count ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="my-3 flex flex-wrap items-center gap-2">
          <input type="search" className={cx(input, "min-w-0 flex-[1_1_260px]")} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search partner, sender, subject or text…" aria-label="Search replies" />
          <select className={cx(input, "w-auto max-[640px]:w-full")} value={partnerId} onChange={(e) => setPartnerId(e.target.value)} aria-label="Filter by partner">
            <option value="">All partners</option>
            {[...partners].sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {filtered && <button className={btnCls("default", "sm")} onClick={() => { setQ(""); setPartnerId(""); }}>Clear filters</button>}
        </div>

        {message && <Alert type={message.type}>{message.text}</Alert>}
        {error && <Alert type="error">{error}</Alert>}
        {!replies.length && !error && !loading && (
          <p className="py-6 text-center text-muted">
            {filtered ? "No replies match these filters." : show === "unread" ? "No new replies. You're all caught up." : "No replies from partners yet."}
          </p>
        )}

        {replies.length > 0 && (
          <ul className="divide-y divide-line rounded-md border border-line">
            {replies.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setOpenId(r.id)}
                  className={cx("flex w-full gap-3 px-3 py-2.5 text-left hover:bg-gray-50 focus-visible:bg-gray-50 focus-visible:outline-none",
                    !r.is_read && "bg-rose-50/60")}>
                  <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", r.is_read ? "bg-transparent" : "bg-brand")}
                    aria-label={r.is_read ? undefined : "New"} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={cx("text-sm", r.is_read ? "font-semibold" : "font-bold")}>{r.partner_name}</span>
                      <MailTypeBadge type={r.mail_type} />
                      <span className="min-w-0 truncate text-xs text-muted">{r.from_name ? `${r.from_name} <${r.from_email}>` : r.from_email}</span>
                    </span>
                    <span className={cx("mt-0.5 block truncate text-[13px]", !r.is_read && "font-semibold")}>{r.subject}</span>
                    <span className="block truncate text-xs text-muted">{r.snippet}</span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-muted">
                    <span className="block" title={formatDateTime(r.received_at)}>{shortDate(r.received_at)}</span>
                    {r.attachments.length > 0 && (
                      <span className="mt-1 block" title={r.attachments.map((a) => a.filename).join(", ")}>📎 {r.attachments.length}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {openId && (
        <ReplyModal id={openId} onClose={() => setOpenId(null)}
          onRead={(isRead, next) => { setRead(openId, isRead); if (next) onChange(next); }} />
      )}
    </div>
  );
}

// "10:15" today, "Oct 27" this year, "27/10/2025" before
function shortDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString();
}

function MailboxStatus({ inbox }) {
  if (!inbox) return null;
  if (!inbox.enabled) {
    return (
      <Alert type="warning">
        Replies are not being read: no mailbox is set up. Set IMAP_HOST (e.g. imap.gmail.com) in backend/.env and restart
        the backend. It signs in with SMTP_USER / SMTP_PASSWORD unless IMAP_USER / IMAP_PASSWORD are set.
      </Alert>
    );
  }
  const every = inbox.check_every_seconds >= 120 ? `${Math.round(inbox.check_every_seconds / 60)} minutes` : `${inbox.check_every_seconds} seconds`;
  return (
    <>
      <p className="mt-2 text-xs text-muted">
        Reading <b className="text-ink">{inbox.mailbox}</b> ({inbox.folder}) every {every}
        {inbox.last_ok_at ? <> · last checked {formatDateTime(inbox.last_ok_at)}</> : " · not checked yet"}
      </p>
      {inbox.last_error && (
        <Alert type="error">
          The last mailbox check failed{inbox.last_run_at ? ` (${formatDateTime(inbox.last_run_at)})` : ""}: {inbox.last_error}
        </Alert>
      )}
    </>
  );
}

// One reply: its text, attachments and the email it answers. Opening it marks it as read.
function ReplyModal({ id, onClose, onRead }) {
  const [reply, setReply] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getReply(id)
      .then((r) => { setReply(r); onRead(true); return api.replySummary(); })
      .then((next) => onRead(true, next))
      .catch((e) => setError(e.message));
  }, [id]);

  async function markNew() {
    setBusy(true);
    try {
      onRead(false, await api.setReplyRead(id, false));
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  async function download(a) {
    setError("");
    try {
      await api.downloadReplyAttachment(id, a);
    } catch (e) {
      setError(e.message);
    }
  }

  const o = reply?.original;
  return (
    <Modal wide title={reply ? reply.subject : "Reply"} onClose={onClose}
      actions={<>
        {reply && <button className={btnCls()} onClick={markNew} disabled={busy}>Mark as new</button>}
        <button className={btnCls("primary")} onClick={onClose}>Close</button>
      </>}>
      {error && <Alert type="error">{error}</Alert>}
      {!reply && !error && <p className="text-muted">Loading...</p>}
      {reply && (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted">
            <dt>From</dt><dd><b>{reply.from_name || reply.from_email}</b>{reply.from_name && <span className="text-muted"> &lt;{reply.from_email}&gt;</span>}</dd>
            <dt>To</dt><dd>{reply.to.join(", ") || "—"}</dd>
            {reply.cc.length > 0 && <><dt>CC</dt><dd>{reply.cc.join(", ")}</dd></>}
            <dt>Received</dt><dd>{formatDateTime(reply.received_at)} <span className="text-muted">({daysAgo(reply.received_at)})</span></dd>
          </dl>

          <div className="rounded-md border border-line bg-gray-50 px-3 py-2 text-xs">
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="font-semibold text-muted">In reply to our email to</span>
              <b className="text-[13px]">{reply.partner_name}</b>
              <MailTypeBadge type={reply.mail_type} />
              <Badge color={o.reply_status === "reconciled" ? "green" : o.reply_status === "received" ? "blue" : "gray"}>
                {replyLabel(o.reply_status)}
              </Badge>
            </div>
            <div className="break-words">“{o.subject}”</div>
            <div className="text-muted">
              Sent {formatDateTime(o.sent_at)} to {o.to.join(", ")} · {o.txn_count} transactions · BDT {formatAmount(o.total_amount)} · file #{o.upload_id}
            </div>
            {reply.matched_by === "subject" && (
              <div className="mt-1 text-amber-800">
                Matched by its subject and sender (the reply did not say which email it answers): check it is about this email.
              </div>
            )}
          </div>

          <EmailView className="max-h-[50vh] min-h-[160px]" html={reply.body_html} />

          {reply.attachments.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase text-muted">Attachments ({reply.attachments.length})</div>
              <div className="flex flex-wrap gap-2">
                {reply.attachments.map((a) => (
                  <button key={a.id} type="button" className={btnCls("default", "sm")} onClick={() => download(a)} title="Download">
                    📎 {a.filename} <span className="text-muted">({fileSize(a.size)})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
