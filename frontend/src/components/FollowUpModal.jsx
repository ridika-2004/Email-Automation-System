import { useEffect, useState } from "react";
import { api, formatDateTime } from "../api";
import { EmailEditor } from "./EmailHtml";
import Modal from "./Modal";
import { Alert, btnCls, input } from "./ui";

const splitAddresses = (text) => text.split(/[,;\s]+/).map((a) => a.trim()).filter(Boolean);
const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

// Write and send a follow-up for a sent email. Starts from a ready-made draft (reminder, or request
// for missing details when the partner already replied); recipients, subject and body can be changed.
// Sending asks for confirmation first.
export default function FollowUpModal({ email, onClose, onSent }) {
  const [draft, setDraft] = useState(null);       // { number, to, cc, subject, body_html } from the server
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.followupDraft(email.id)
      .then((d) => { setDraft(d); setTo(d.to.join(", ")); setCc(d.cc.join(", ")); setSubject(d.subject); setBody(d.body_html); })
      .catch((e) => setError(e.message));
  }, [email.id]);

  const toList = splitAddresses(to);
  const ccList = splitAddresses(cc);
  const badAddress = [...toList, ...ccList].find((a) => !EMAIL_RE.test(a));
  const problem = !toList.length ? "Add at least one recipient."
    : badAddress ? `“${badAddress}” is not a valid email address.`
    : !subject.trim() ? "The subject is empty." : "";

  async function send() {
    setSending(true);
    setError("");
    try {
      const result = await api.sendFollowup(email.id, { to: toList, cc: ccList, subject, body_html: body });
      onSent(result.email, result.refused);
    } catch (e) {
      setError(e.message);
      setConfirming(false);
    } finally {
      setSending(false);
    }
  }

  const close = () => { if (!sending) onClose(); };

  return (
    <Modal
      wide
      title={draft ? `Follow-up ${draft.number > 1 ? `#${draft.number} ` : ""}to ${email.partner_name}` : `Follow-up to ${email.partner_name}`}
      onClose={close}
      actions={confirming ? (
        <>
          <span className="mr-auto text-sm font-semibold">Send this follow-up to {toList.length + ccList.length} recipient(s) now?</span>
          <button className={btnCls()} onClick={() => setConfirming(false)} disabled={sending}>Back</button>
          <button className={btnCls("primary")} onClick={send} disabled={sending}>{sending ? "Sending..." : "Send now"}</button>
        </>
      ) : (
        <>
          <button className={btnCls()} onClick={close}>Cancel</button>
          <button className={btnCls("primary")} onClick={() => setConfirming(true)} disabled={!draft || !!problem}
            title={problem}>Send follow-up</button>
        </>
      )}
    >
      <p className="text-xs text-muted">
        Original email sent {formatDateTime(email.sent_at)} · {email.followup_count} follow-up(s) so far ·
        reply status: <b>{{ not_received: "Awaiting reply", received: "Reply received" }[email.reply_status]}</b>.
        It is sent as a reply in the same email thread.
      </p>
      {error && <Alert type="error">{error}</Alert>}
      {!draft && !error && <p className="text-muted">Preparing the follow-up…</p>}
      {draft && (
        <div className="flex flex-col gap-2.5 [&_label]:flex [&_label]:flex-col [&_label]:gap-1 [&_label]:text-[13px] [&_label]:font-semibold">
          <label>To<input className={input} value={to} onChange={(e) => setTo(e.target.value)} disabled={confirming} /></label>
          <label>CC<input className={input} value={cc} onChange={(e) => setCc(e.target.value)} disabled={confirming} /></label>
          <label>Subject<input className={input} value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} disabled={confirming} /></label>
          <div>
            <div className="mb-1.5 text-[13px] font-semibold">Message <span className="text-xs text-muted">(click in the email to edit; replace the highlighted text)</span></div>
            {/* The body is edited in place (WYSIWYG), like the email editor on the Email Preview page */}
            <EmailEditor className="h-[340px]" label="Follow-up message" html={draft.body_html} onChange={setBody} />
          </div>
          {problem && <p className="text-xs text-red-700">{problem}</p>}
        </div>
      )}
    </Modal>
  );
}
