"""Reads partners' mail from the mailbox the emails are sent from (IMAP).

Two kinds of incoming partner mail are taken in, and kept apart:
  * Replies to our emails. A message is a reply when its In-Reply-To / References header holds the
    Message-ID of one of our emails or follow-ups (what every mail program sets when you press Reply),
    or, when those headers are missing, its subject is our email's subject (with "Re:" etc.) and it
    comes from one of that partner's addresses (or their domain). A reply sets the email to
    "Reply received". Automatic replies (out of office) and bounce messages are recognised: they are
    stored with the email but do not change its status.
  * Other mail from partners: messages from a partner's address (or domain) that don't answer any of
    our emails. They are stored with the partner, not with an email.
Everything else in the mailbox (personal mail, newsletters...) is left alone: only the headers are
looked at, the message is never downloaded, and the folder is opened read-only, so nothing is
marked as read in the mailbox either.

Each check only looks at messages that arrived since the last one (IMAP UIDs, kept in inbox_state).
The first check looks back to the oldest sent email, at most INBOX_FIRST_SCAN_DAYS days.
The mailbox settings are read at every check, so a change on the System Settings page applies at once.
"""
import imaplib
import logging
import re
import socket
import threading
from datetime import datetime, timedelta, timezone
from email import policy
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
from html import escape, unescape

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import config, models
from .database import SessionLocal
from .delivery import record_refused

log = logging.getLogger("uvicorn.error")

# created_by of the history entries added when a reply is found ("#" is not allowed in usernames)
INBOX_USER = "#inbox"

HEADER_FIELDS = ("MESSAGE-ID IN-REPLY-TO REFERENCES SUBJECT FROM AUTO-SUBMITTED X-AUTOREPLY X-AUTORESPOND "
                 "PRECEDENCE CONTENT-TYPE")
FETCH_BATCH = 200                    # headers of this many messages per request
MAX_MESSAGE_BYTES = 25 * 1024 * 1024  # bigger messages are stored without their attachments
MAX_BODY_CHARS = 2_000_000
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]  # IMAP dates are English

# What an incoming message is (email_replies.kind)
REPLY, AUTO_REPLY, BOUNCE, PARTNER_MAIL = "reply", "auto_reply", "bounce", "partner_mail"

_lock = threading.Lock()   # one check at a time ("Check now" while the timer runs)
_stop = threading.Event()
_wake = threading.Event()  # settings changed: check again now
status = {"last_run_at": None, "last_ok_at": None, "last_error": None, "last_found": 0, "next_run_at": None}


def configured() -> bool:
    return bool(config.imap_host() and config.imap_user() and config.imap_password())


def enabled() -> bool:
    return config.INBOX_ENABLED and configured()


def mailbox_name() -> str:
    return f"{config.imap_user()}@{config.imap_host()}/{config.IMAP_FOLDER}"


def status_dict() -> dict:
    return {**status, "enabled": enabled(), "switched_on": config.INBOX_ENABLED, "configured": configured(),
            "mailbox": config.imap_user() if configured() else None,
            "host": config.imap_host(), "folder": config.IMAP_FOLDER, "check_every_seconds": config.INBOX_CHECK_SECONDS}


# ---------------------------------------------------------------- matching a message to our emails

def norm_id(value: str) -> str:
    return value.strip().strip("<>").strip().lower()


def referenced_ids(in_reply_to: str, references: str) -> list[str]:
    """Message-IDs a message answers, the direct parent (In-Reply-To) first."""
    ids = re.findall(r"<([^<>\s]+)>", in_reply_to or "") + list(reversed(re.findall(r"<([^<>\s]+)>", references or "")))
    seen, out = set(), []
    for i in ids:
        i = norm_id(i)
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


SUBJECT_PREFIX = re.compile(r"^\s*((re|fw|fwd|aw|sv|wg|antw)\s*(\[\d+\])?\s*:\s*)+", re.I)


def norm_subject(subject: str) -> str:
    return re.sub(r"\s+", " ", SUBJECT_PREFIX.sub("", subject or "")).strip().lower()


def domain(address: str) -> str:
    return address.rsplit("@", 1)[-1].lower()


# Free mail providers: a partner using one of these is matched by its exact addresses only
PUBLIC_DOMAINS = {"gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com",
                  "icloud.com", "aol.com", "proton.me", "protonmail.com", "ymail.com"}


class Matcher:
    """Our sent emails and the partners' addresses, loaded once per check: which email (if any) a
    message answers, and which partner (if any) sent it."""

    def __init__(self, db: Session):
        E, Ev = models.EmailDispatch, models.EmailEvent
        sent = db.query(E).filter(E.status == "SENT").all()
        self.by_id = {norm_id(d.message_id): d.id for d in sent if d.message_id}
        for dispatch_id, message_id in db.query(Ev.dispatch_id, Ev.message_id).filter(
                Ev.kind == "followup", Ev.message_id.isnot(None)):
            self.by_id[norm_id(message_id)] = dispatch_id
        self.dispatches = {d.id: d for d in sent}
        self.by_subject: dict[str, list[models.EmailDispatch]] = {}
        for d in sent:
            self.by_subject.setdefault(norm_subject(d.subject), []).append(d)
        self.ours = {a.lower() for a in (config.imap_user(), config.MAIL_FROM, config.SMTP_USER) if a}
        self.oldest_sent = min((d.sent_at for d in sent if d.sent_at), default=None)
        # partner addresses and domains (lowest partner id wins when two share an address)
        self.partner_by_address: dict[str, int] = {}
        self.partner_by_domain: dict[str, int] = {}
        own_domains = {domain(a) for a in self.ours}
        for pe in db.query(models.PartnerEmail).order_by(models.PartnerEmail.partner_id):
            address = pe.email.strip().lower()
            self.partner_by_address.setdefault(address, pe.partner_id)
            if domain(address) not in PUBLIC_DOMAINS | own_domains:
                self.partner_by_domain.setdefault(domain(address), pe.partner_id)

    def match(self, sender: str, subject: str, in_reply_to: str, references: str) -> tuple[models.EmailDispatch, str] | None:
        sender = sender.lower()
        if not sender or sender in self.ours:  # our own emails (copies, follow-ups)
            return None
        for ref in referenced_ids(in_reply_to, references):
            d = self.dispatches.get(self.by_id.get(ref))
            if d:
                # Nagad colleagues on CC answering in the thread are not the partner's reply
                if sender in {c.lower() for c in d.cc_emails.split(",") if c}:
                    return None
                return d, "thread"
        candidates = [d for d in self.by_subject.get(norm_subject(subject), []) if self._from_partner(d, sender)]
        if candidates:
            return max(candidates, key=lambda d: d.sent_at or datetime.min), "subject"
        return None

    def partner_for(self, sender: str) -> int | None:
        """The partner this address belongs to: one of its addresses, or its own (company) domain."""
        sender = sender.lower()
        if not sender or sender in self.ours:
            return None
        return self.partner_by_address.get(sender) or self.partner_by_domain.get(domain(sender))

    def _from_partner(self, d: models.EmailDispatch, sender: str) -> bool:
        addresses = {a.strip().lower() for a in d.to_emails.split(",") if a.strip()}
        addresses |= {e.email.lower() for e in d.partner.emails}
        if sender in addresses:
            return True
        # a partner on a free mail provider, or on our own domain: its exact addresses only
        domains = {domain(a) for a in addresses} - PUBLIC_DOMAINS - {domain(a) for a in self.ours}
        return domain(sender) in domains


AUTO_SUBJECT = re.compile(r"^\s*(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|autoreply|auto:)", re.I)
BOUNCE_SENDERS = {"mailer-daemon", "postmaster"}


def classify(headers, sender: str) -> str:
    """reply, auto_reply (out of office etc.) or bounce (delivery failure notice)."""
    if sender.split("@", 1)[0].lower() in BOUNCE_SENDERS:
        return BOUNCE
    content_type = str(headers["Content-Type"] or "").lower()
    if "multipart/report" in content_type and "delivery-status" in content_type:
        return BOUNCE
    auto_submitted = str(headers["Auto-Submitted"] or "").strip().lower()
    if auto_submitted and auto_submitted != "no":
        return AUTO_REPLY
    if headers["X-Autoreply"] or headers["X-Autorespond"]:
        return AUTO_REPLY
    if str(headers["Precedence"] or "").strip().lower() == "auto_reply":
        return AUTO_REPLY
    if AUTO_SUBJECT.match(str(headers["Subject"] or "")):
        return AUTO_REPLY
    return REPLY


# ---------------------------------------------------------------- reading the message

def first_address(value) -> tuple[str, str]:
    pairs = getaddresses([str(value or "")])
    return (pairs[0][0], pairs[0][1]) if pairs else ("", "")


def address_list(*values) -> str:
    return ",".join(a for _, a in getaddresses([str(v) for v in values if v]) if a)


def local_time(value: datetime) -> datetime:
    """The app stores local times without a zone (datetime.now())."""
    return value.astimezone().replace(tzinfo=None) if value.tzinfo else value


def text_of(html: str) -> str:
    html = re.sub(r"(?is)<(style|script|head)\b.*?</\1>", " ", html)
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", html))).strip()


def read_message(raw: bytes) -> dict:
    """Body (HTML), snippet and attachments of a downloaded message."""
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    body_part = msg.get_body(preferencelist=("html", "plain"))
    body_html, plain = "", ""
    if body_part is not None:
        try:
            content = body_part.get_content()
        except (LookupError, ValueError):  # unknown charset
            content = (body_part.get_payload(decode=True) or b"").decode("utf-8", errors="replace")
        if body_part.get_content_subtype() == "html":
            body_html = content
        else:
            plain = content
            body_html = f'<div style="white-space:pre-wrap">{escape(content)}</div>'
    attachments = []
    for part in msg.iter_attachments():
        filename = part.get_filename()
        if not filename or (part.get_content_maintype() == "image" and part.get_content_disposition() == "inline"):
            continue  # pictures inside the text (logos in signatures)
        data = part.get_payload(decode=True) or b""
        attachments.append({"filename": filename[:255], "content_type": part.get_content_type()[:100], "data": data})
    snippet = (re.sub(r"\s+", " ", plain).strip() if plain else text_of(body_html))[:300]
    return {"body_html": body_html[:MAX_BODY_CHARS], "snippet": snippet, "attachments": attachments}


# ---------------------------------------------------------------- IMAP

def fetch_parts(data) -> list[tuple[int, bytes, int]]:
    """(uid, literal, size) for each message of a UID FETCH answer. The UID / RFC822.SIZE can come
    before or after the literal, depending on the server."""
    out, i = [], 0
    while i < len(data):
        item = data[i]
        if isinstance(item, tuple):
            meta = item[0] + (data[i + 1] if i + 1 < len(data) and isinstance(data[i + 1], bytes) else b"")
            uid = re.search(rb"UID (\d+)", meta)
            size = re.search(rb"RFC822\.SIZE (\d+)", meta)
            if uid:
                out.append((int(uid.group(1)), item[1], int(size.group(1)) if size else 0))
        i += 1
    return out


def check(what: str, typ, data) -> None:
    if typ != "OK":
        raise RuntimeError(f"The mail server could not {what}: {data!r}"[:300])


def sign_in(host: str | None = None, port: int | None = None, user: str | None = None,
            password: str | None = None) -> imaplib.IMAP4:
    """Sign in to the mailbox: the settings in effect, or the given ones (System Settings test)."""
    host = host if host is not None else config.imap_host()
    port = port if port is not None else config.IMAP_PORT
    user = user if user is not None else config.imap_user()
    password = password if password is not None else config.imap_password()
    try:
        conn = imaplib.IMAP4_SSL(host, port, timeout=30)
    except (OSError, socket.timeout) as exc:
        raise RuntimeError(f"Could not reach the mail server {host}:{port}: {exc}")
    try:
        conn.login(user, password)
    except imaplib.IMAP4.error as exc:
        conn.shutdown()
        reason = exc.args[0] if exc.args else exc
        exc = reason.decode(errors="replace") if isinstance(reason, bytes) else reason
        hint = " For Gmail use the same 16-character app password as for sending." if "gmail" in host else ""
        raise RuntimeError(f"The mailbox refused the sign-in for {user}: {exc}.{hint}")
    return conn


def open_folder(conn: imaplib.IMAP4, folder: str) -> None:
    """Open a folder read-only: nothing is marked as read."""
    quoted = folder if folder.startswith('"') else f'"{folder}"'
    typ, _ = conn.select(quoted, readonly=True)
    if typ != "OK":
        raise RuntimeError(f"The folder {folder} was not found in the mailbox.")


def open_mailbox() -> imaplib.IMAP4:
    conn = sign_in()
    try:
        open_folder(conn, config.IMAP_FOLDER)
    except Exception:
        conn.logout()
        raise
    return conn


def test_connection(host: str, port: int, user: str, password: str, folder: str) -> None:
    """Sign in and open the folder, read-only, then sign out. Raises with a readable message."""
    if not (host and user and password):
        raise RuntimeError("The mailbox needs a server, a user and a password.")
    conn = sign_in(host, port, user, password)
    try:
        open_folder(conn, folder)
    finally:
        try:
            conn.logout()
        except Exception:
            pass


# ---------------------------------------------------------------- Message-IDs of older emails

RECOVER_WINDOW = timedelta(minutes=15)  # the Sent copy's Date vs. when the app recorded the send
_recover_tried: set[tuple[str, int]] = set()  # records already looked for (each is looked for once per run)
LIST_LINE = re.compile(rb'\((?P<flags>[^)]*)\) (?P<delim>"[^"]*"|NIL) (?P<name>.+)$')


def sent_folder(conn: imaplib.IMAP4) -> str | None:
    """The mailbox's Sent folder (the one flagged \\Sent; Gmail: "[Gmail]/Sent Mail")."""
    typ, folders = conn.list()
    names = []
    for line in folders or []:
        m = LIST_LINE.match(line) if isinstance(line, bytes) else None
        if m:
            name = m.group("name").decode(errors="replace")
            if b"\\sent" in m.group("flags").lower():
                return name
            names.append(name.strip('"'))
    return next((f'"{n}"' for n in ("[Gmail]/Sent Mail", "Sent", "Sent Items", "Sent Messages") if n in names), None)


def recover_message_ids(db: Session, conn: imaplib.IMAP4) -> int:
    """Emails and follow-ups sent before their Message-ID was saved: find their copies in the Sent folder
    (same subject, same recipient, sent within a few minutes) and save the Message-ID, so partners'
    replies to them are matched by their reply headers. Returns how many were found."""
    E, Ev = models.EmailDispatch, models.EmailEvent
    records = [("d", d.id, d, d.subject, d.to_emails, d.sent_at) for d in
               db.query(E).filter(E.status == "SENT", E.message_id.is_(None), E.sent_at.isnot(None))]
    records += [("e", e.id, e, e.subject, e.to_emails, e.created_at) for e in
                db.query(Ev).filter(Ev.kind == "followup", Ev.ok.is_(True), Ev.message_id.is_(None))]
    records = [r for r in records if (r[0], r[1]) not in _recover_tried and r[3]]
    if not records:
        return 0
    folder = sent_folder(conn)
    if folder is None:
        return 0
    open_folder(conn, folder)
    since = min(r[5] for r in records) - timedelta(days=1)
    typ, data = conn.uid("SEARCH", None, f"SINCE {since.day:02d}-{MONTHS[since.month - 1]}-{since.year}")
    check("search the Sent folder", typ, data)
    uids = (data[0] or b"").split()

    used = {norm_id(i) for (i,) in db.query(E.message_id).filter(E.message_id.isnot(None))}
    used |= {norm_id(i) for (i,) in db.query(Ev.message_id).filter(Ev.message_id.isnot(None))}
    copies = []  # (subject, recipients, sent at, message id)
    for start in range(0, len(uids), FETCH_BATCH):
        typ, data = conn.uid("FETCH", b",".join(uids[start:start + FETCH_BATCH]).decode(),
                             "(UID BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT TO CC DATE)])")
        check("read the Sent folder", typ, data)
        for _, header_bytes, _ in fetch_parts(data):
            h = BytesParser(policy=policy.default).parsebytes(header_bytes, headersonly=True)
            message_id = str(h["Message-ID"] or "").strip()
            try:
                sent_at = local_time(parsedate_to_datetime(str(h["Date"])))
            except (TypeError, ValueError):
                continue
            if not message_id or norm_id(message_id) in used:
                continue
            recipients = {a.lower() for a in address_list(h["To"], h["Cc"]).split(",") if a}
            copies.append((same_text(str(h["Subject"] or "")), recipients, sent_at, message_id))

    # closest in time first, so two sends of the same email (minutes apart) each get their own copy
    pairs = []
    for kind, rid, obj, subject, to, at in records:
        to_set = {a.strip().lower() for a in to.split(",") if a.strip()}
        for i, (c_subject, c_to, c_at, _) in enumerate(copies):
            gap = abs(c_at - at)
            if c_subject == same_text(subject) and to_set & c_to and gap <= RECOVER_WINDOW:
                pairs.append((gap, kind, rid, obj, i))
    found, done, taken = 0, set(), set()
    for gap, kind, rid, obj, i in sorted(pairs, key=lambda p: p[0]):
        if (kind, rid) in done or i in taken:
            continue
        obj.message_id = copies[i][3][:255]
        done.add((kind, rid))
        taken.add(i)
        found += 1
    db.commit()
    _recover_tried.update((r[0], r[1]) for r in records)
    if found:
        log.info("Inbox: recovered the Message-ID of %s earlier emails from %s", found, folder)
    return found


def same_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


# ---------------------------------------------------------------- the check

def scan() -> dict:
    """Look for new partner mail once. Returns {"found", "replies", "partner_mail", "checked", "recovered"};
    raises when the mailbox can't be read."""
    with _lock, SessionLocal() as db:
        status["last_run_at"] = datetime.now().isoformat(timespec="seconds")
        try:
            result = _scan(db)
        except Exception as exc:
            status["last_error"] = str(exc)[:500]
            raise
        status.update(last_ok_at=status["last_run_at"], last_error=None, last_found=result["found"])
        if result["found"]:
            log.info("Inbox: %s new partner messages (%s replies)", result["found"], result["replies"])
        return result


def _scan(db: Session) -> dict:
    result = {"found": 0, "replies": 0, "partner_mail": 0, "checked": 0, "recovered": 0}
    if not configured():
        raise RuntimeError("Reading partner mail is not set up: fill in the mailbox on the System Settings page.")
    if not config.INBOX_ENABLED:
        raise RuntimeError("Reading partner mail is switched off on the System Settings page.")
    has_sent = db.query(models.EmailDispatch.id).filter_by(status="SENT").first() is not None
    if not has_sent and not db.query(models.PartnerEmail.id).first():
        return result  # nothing to match yet

    conn = sign_in()
    try:
        if has_sent:
            result["recovered"] = recover_message_ids(db, conn)
            if result["recovered"]:  # read the inbox again from the start: earlier replies can now be matched
                db.query(models.InboxState).filter_by(mailbox=mailbox_name()).delete()
                db.commit()
        matcher = Matcher(db)
        open_folder(conn, config.IMAP_FOLDER)
        uidvalidity = int((conn.response("UIDVALIDITY")[1] or [b"0"])[0] or 0)
        state = db.get(models.InboxState, mailbox_name())
        if state is None or state.uidvalidity != uidvalidity:  # first check, or the folder was rebuilt
            state = state or models.InboxState(mailbox=mailbox_name())
            state.uidvalidity, state.last_uid = uidvalidity, 0
            db.add(state)
            db.commit()
            since = datetime.now() - timedelta(days=config.INBOX_FIRST_SCAN_DAYS)
            if matcher.oldest_sent:
                since = max(since, matcher.oldest_sent - timedelta(days=1))
            criteria = f"SINCE {since.day:02d}-{MONTHS[since.month - 1]}-{since.year}"
        else:
            criteria = f"UID {state.last_uid + 1}:*"
        typ, data = conn.uid("SEARCH", None, criteria)
        check("search the mailbox", typ, data)
        # "UID n:*" also returns the newest message when there is nothing newer than n
        uids = sorted(u for u in map(int, (data[0] or b"").split()) if u > state.last_uid)
        result["checked"] = len(uids)

        for start in range(0, len(uids), FETCH_BATCH):
            batch = uids[start:start + FETCH_BATCH]
            typ, data = conn.uid("FETCH", ",".join(map(str, batch)), f"(UID RFC822.SIZE BODY.PEEK[HEADER.FIELDS ({HEADER_FIELDS})])")
            check("read message headers", typ, data)
            for uid, header_bytes, size in fetch_parts(data):
                headers = BytesParser(policy=policy.default).parsebytes(header_bytes, headersonly=True)
                _, sender = first_address(headers["From"])
                kind = classify(headers, sender)
                hit = matcher.match(sender, str(headers["Subject"] or ""), str(headers["In-Reply-To"] or ""),
                                    str(headers["References"] or ""))
                if hit:
                    d, matched_by = hit
                    partner_id = d.partner_id
                else:
                    partner_id = matcher.partner_for(sender)
                    if partner_id is None or kind == BOUNCE:
                        continue  # not partner mail: never downloaded
                    d, matched_by = None, "sender"
                    if kind == REPLY:
                        kind = PARTNER_MAIL
                message_id = norm_id(str(headers["Message-ID"] or "")) or f"imap-{uidvalidity}-{uid}@{config.imap_host()}"
                if db.query(models.EmailReply.id).filter_by(message_id=message_id[:255]).first():
                    continue
                if save_message(db, conn, uid, size, message_id[:255], d, matched_by, kind, partner_id):
                    result["found"] += 1
                    result["replies" if d else "partner_mail"] += 1
            state.last_uid = max(state.last_uid, batch[-1])
            db.commit()
        db.commit()
        return result
    finally:
        try:
            conn.logout()
        except Exception:
            pass


EVENT_NOTES = {
    REPLY: "Reply from {who}",
    AUTO_REPLY: "Automatic reply from {who}",
    BOUNCE: "Delivery failure notice from {who}",
}


def save_message(db: Session, conn: imaplib.IMAP4, uid: int, size: int, message_id: str,
                 d: models.EmailDispatch | None, matched_by: str, kind: str, partner_id: int | None) -> bool:
    """Download one partner message and store it. A reply (not an automatic one) sets its email to
    "Reply received"; a bounce flags the address it names as refused."""
    whole = size <= MAX_MESSAGE_BYTES
    part = "BODY.PEEK[]" if whole else "BODY.PEEK[HEADER]"
    typ, data = conn.uid("FETCH", str(uid), f"(UID INTERNALDATE {part})")
    check("download a message", typ, data)
    parts = fetch_parts(data)
    if not parts:
        return False
    raw = parts[0][1]
    msg = BytesParser(policy=policy.default).parsebytes(raw, headersonly=not whole)
    content = read_message(raw) if whole else {
        "body_html": "<p><i>This message is too large to show here. Open it in the mailbox.</i></p>",
        "snippet": "(too large to show)", "attachments": []}

    try:
        received = local_time(parsedate_to_datetime(str(msg["Date"])))
    except (TypeError, ValueError):
        received = None
    if received is None:
        stamp = re.search(rb'INTERNALDATE "([^"]+)"', b" ".join(x[0] if isinstance(x, tuple) else x for x in data))
        received = local_time(datetime.strptime(stamp.group(1).decode(), "%d-%b-%Y %H:%M:%S %z")) if stamp else datetime.now()

    name, sender = first_address(msg["From"])
    reply = models.EmailReply(
        dispatch_id=d.id if d else None, partner_id=partner_id, kind=kind, message_id=message_id,
        from_email=sender.lower()[:254], from_name=name[:200],
        to_emails=address_list(msg["To"]), cc_emails=address_list(msg["Cc"]),
        subject=str(msg["Subject"] or "(no subject)")[:500], body_html=content["body_html"],
        snippet=content["snippet"], matched_by=matched_by, received_at=received,
        attachments=[models.EmailReplyAttachment(filename=a["filename"], content_type=a["content_type"],
                                                 size=len(a["data"]), content=a["data"]) for a in content["attachments"]],
    )
    db.add(reply)
    try:
        db.flush()
    except IntegrityError:  # stored by another check at the same moment
        db.rollback()
        return False
    if d is not None:
        who = f"{name} <{sender}>" if name else sender
        # in the history after the email it answers, even if the sender's clock is wrong
        at = max(received, d.sent_at) if d.sent_at else received
        db.add(models.EmailEvent(dispatch_id=d.id, kind=kind, reply_id=reply.id, subject=reply.subject[:300],
                                 note=EVENT_NOTES[kind].format(who=who), created_by=INBOX_USER, created_at=at))
        if kind == REPLY and d.reply_status == "not_received":  # never overrides Reconciled
            d.reply_status, d.reply_status_by, d.reply_status_at = "received", INBOX_USER, datetime.now()
            db.add(models.EmailEvent(dispatch_id=d.id, kind="status", reply_status="received",
                                     note="Set automatically: the partner's reply was found in the mailbox.",
                                     created_by=INBOX_USER))
        if kind == BOUNCE:
            failed = [a for _, a in getaddresses([str(msg["X-Failed-Recipients"] or "")]) if a]
            for address in failed:
                record_refused(d, address, "Bounced: the mail server could not deliver it")
    db.commit()
    return True


def loop() -> None:
    """Background thread: check the mailbox every INBOX_CHECK_SECONDS (at once after a settings change)."""
    while not _stop.is_set():
        if enabled():
            try:
                scan()
            except Exception as exc:
                log.warning("Inbox check failed: %s", exc)
            status["next_run_at"] = (datetime.now() + timedelta(seconds=config.INBOX_CHECK_SECONDS)).isoformat(timespec="seconds")
        else:
            status["next_run_at"] = None
        _wake.wait(config.INBOX_CHECK_SECONDS)
        _wake.clear()


def wake() -> None:
    """The mailbox settings changed: check again now, with the new settings."""
    _wake.set()


def stop() -> None:
    _stop.set()
    _wake.set()


def utc_to_local(value: datetime) -> datetime:
    """users.created_at is stored in UTC; replies use local time."""
    return value.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)
