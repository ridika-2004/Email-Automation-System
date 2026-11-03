import { useEffect, useRef, useState } from "react";
import { api, formatAmount, formatDateTime } from "../api";
import { EmailView } from "../components/EmailHtml";
import MailTypeBadge from "../components/MailTypeBadge";
import Modal from "../components/Modal";
import { Alert, Badge, btnCls, card, cx, h2, input, page } from "../components/ui";
import { daysAgo, replyLabel } from "./SentPage";

// Mail from partners, read from the sending mailbox by the backend (inbox.py), in two lists:
//   replies       - answers to our emails and follow-ups (also automatic replies and bounce notices)
//   partner_mail  - other mail from a partner's address that doesn't answer any of our emails
// New = not opened by you yet (each person has their own); the sidebar shows how many.
// summary: { unread, unread_replies, unread_partner_mail, total_replies, total_partner_mail, inbox, reply_to }
// from App, which checks it regularly; onChange(summary) tells App when reading changes the counts.
const CATEGORIES = [
  { id: "replies", label: "Replies to our emails", empty: "No replies from partners yet." },
  { id: "partner_mail", label: "Other mail from partners", empty: "No other mail from partners yet." },
];
const KIND_BADGE = {
  auto_reply: { color: "gray", text: "Automatic reply", title: "Out of office or similar: doesn't count as a reply" },
  bounce: { color: "red", text: "Delivery failure", title: "The partner's mail server could not deliver our email" },
};

export default function RepliesPage({ summary, onChange, isAdmin, onOpenSettings }) {
  const [category, setCategory] = useState("replies");
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
    api.listReplies({ category, show, q: search.trim(), partner_id: partnerId })
      .then(setReplies)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => { api.listPartners().then(setPartners).catch(() => {}); }, []);
  // filters apply at once, typing waits until you pause, and new mail found by the backend shows up
  useEffect(() => { load(); }, [category, show, partnerId, summary?.total]);
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
      load();
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
      const parts = [
        result.replies && `${result.replies} ${result.replies === 1 ? "reply" : "replies"}`,
        result.partner_mail && `${result.partner_mail} other ${result.partner_mail === 1 ? "message" : "messages"}`,
      ].filter(Boolean);
      setMessage(parts.length
        ? { type: "success", text: `New from partners: ${parts.join(" and ")}.` }
        : { type: "info", text: "Nothing new from partners." });
      if (!result.found) load();
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setChecking(false);
    }
  }

  const inbox = summary?.inbox;
  const counts = {
    replies: { total: summary?.total_replies ?? 0, unread: summary?.unread_replies ?? 0 },
    partner_mail: { total: summary?.total_partner_mail ?? 0, unread: summary?.unread_partner_mail ?? 0 },
  };
  const current = counts[category];
  const filtered = q.trim() || partnerId;
  // Replies go to MAIL_FROM (Reply-To): if another mailbox is read, they are never seen here
  const replyToElsewhere = inbox?.enabled && inbox.mailbox && summary.reply_to
    && summary.reply_to.toLowerCase() !== inbox.mailbox.toLowerCase();

  return (
    <div className={page}>
      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_320px]">
            <h2 className={h2}>Mail from partners</h2>
            <p className="text-xs text-muted">
              Read from the sending mailbox. Only mail from partners' addresses is taken in: other mail is never opened.
              A reply to one of our emails sets its status to “Reply received”; automatic replies and delivery failures don't.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(summary?.unread ?? 0) > 0 && <button className={btnCls()} onClick={markAllRead}>Mark all as read</button>}
            {isAdmin && inbox?.enabled && (
              <button className={btnCls("primary")} onClick={checkNow} disabled={checking}>
                {checking ? "Checking..." : "Check mailbox now"}
              </button>
            )}
          </div>
        </div>

        <MailboxStatus inbox={inbox} isAdmin={isAdmin} onOpenSettings={onOpenSettings} />
        {replyToElsewhere && (
          <Alert type="warning">
            Partners' replies go to the sender <b>{summary.reply_to}</b>, but <b>{inbox.mailbox}</b> is read. Make the inbox
            user the same mailbox in System Settings (or leave it empty).
          </Alert>
        )}

        <div className="mt-3.5 flex flex-wrap gap-1 border-b border-line" role="tablist" aria-label="Kind of mail">
          {CATEGORIES.map((c) => (
            <button key={c.id} type="button" role="tab" aria-selected={category === c.id}
              onClick={() => { setCategory(c.id); setOpenId(null); }}
              className={cx("-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13px] font-semibold",
                category === c.id ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink")}>
              {c.label}
              <span className="text-xs font-normal text-muted">{counts[c.id].total}</span>
              {counts[c.id].unread > 0 && (
                <span className="min-w-[20px] rounded-full bg-brand px-1.5 text-center text-[11px] font-bold leading-5 text-white"
                  aria-label={`${counts[c.id].unread} new`}>{counts[c.id].unread}</span>
              )}
            </button>
          ))}
        </div>

        <div className="mb-1 mt-3.5 flex flex-wrap gap-2" role="tablist" aria-label="Show">
          {[{ id: "all", label: "All", count: current.total }, { id: "unread", label: "New", count: current.unread }].map((c) => (
            <button key={c.id} role="tab" aria-selected={show === c.id} onClick={() => setShow(c.id)}
              className={cx("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition-colors",
                show === c.id ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-gray-400")}>
              {c.label}
              <span className={cx("rounded-full px-2 py-px text-xs",
                show === c.id ? "bg-white/70 text-ink" : c.id === "unread" && c.count ? "bg-brand text-white" : "bg-gray-100")}>{c.count}</span>
            </button>
          ))}
        </div>

        <div className="my-3 flex flex-wrap items-center gap-2">
          <input type="search" className={cx(input, "min-w-0 flex-[1_1_260px]")} value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search partner, sender, subject or text…" aria-label="Search partner mail" />
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
            {filtered ? "Nothing matches these filters." : show === "unread" ? "Nothing new. You're all caught up."
              : CATEGORIES.find((c) => c.id === category).empty}
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
                      {r.mail_type && <MailTypeBadge type={r.mail_type} />}
                      {KIND_BADGE[r.kind] && <Badge color={KIND_BADGE[r.kind].color} title={KIND_BADGE[r.kind].title}>{KIND_BADGE[r.kind].text}</Badge>}
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

function MailboxStatus({ inbox, isAdmin, onOpenSettings }) {
  if (!inbox) return null;
  if (!inbox.enabled) {
    const reason = !inbox.configured ? "no mailbox is set up" : "reading is switched off";
    return (
      <Alert type="warning">
        Partner mail is not being read: {reason}.{" "}
        {isAdmin && onOpenSettings
          ? <button type="button" className="font-semibold underline" onClick={onOpenSettings}>Open System Settings</button>
          : "An admin can change this in System Settings."}
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

// One message: its text, attachments, and the email it answers (if any). Opening it marks it as read.
function ReplyModal({ id, onClose, onRead }) {
  const [reply, setReply] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getReply(id)
      .then((r) => { setReply(r); return api.replySummary(); })
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
    <Modal wide title={reply ? reply.subject : "Message"} onClose={onClose}
      actions={<>
        {reply && <button className={btnCls()} onClick={markNew} disabled={busy}>Mark as new</button>}
        <button className={btnCls("primary")} onClick={onClose}>Close</button>
      </>}>
      {error && <Alert type="error">{error}</Alert>}
      {!reply && !error && <p className="text-muted">Loading...</p>}
      {reply && (
        <div className="flex flex-col gap-3">
          {KIND_BADGE[reply.kind] && (
            <Alert type={reply.kind === "bounce" ? "error" : "info"} className="m-0">
              {reply.kind === "bounce"
                ? "Delivery failure: the partner's mail server could not deliver our email. Any address it names is flagged as refused on the Partners page."
                : "Automatic reply (out of office or similar). It doesn't change the email's reply status."}
            </Alert>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] [&_dd]:min-w-0 [&_dd]:break-words [&_dt]:text-muted">
            <dt>From</dt><dd><b>{reply.from_name || reply.from_email}</b>{reply.from_name && <span className="text-muted"> &lt;{reply.from_email}&gt;</span>}</dd>
            <dt>To</dt><dd>{reply.to.join(", ") || "—"}</dd>
            {reply.cc.length > 0 && <><dt>CC</dt><dd>{reply.cc.join(", ")}</dd></>}
            <dt>Received</dt><dd>{formatDateTime(reply.received_at)} <span className="text-muted">({daysAgo(reply.received_at)})</span></dd>
          </dl>

          {o ? (
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
          ) : (
            <div className="rounded-md border border-line bg-gray-50 px-3 py-2 text-xs">
              <span className="font-semibold text-muted">From partner</span> <b className="text-[13px]">{reply.partner_name}</b>
              <div className="text-muted">Not a reply to one of our emails: a new message from the partner's address.</div>
            </div>
          )}

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
