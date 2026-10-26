import re
import smtplib
import time
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import make_msgid
from html import escape

from . import config, settings


# Mail types come from the TXN_DIRECTION column. One email per partner per mail type, worded as in
# docs/Email_Template.docx. Follow-ups of an email use the reminder wording.
MAIL_TYPES = {
    "inward": "Inward Transaction",
    "outward": "Outward Transaction",
}
# Older emails (before TXN_DIRECTION) could be an "Outward Reminder"; kept so they still show a name
MAIL_TYPE_NAMES = {**MAIL_TYPES, "outward_reminder": "Outward Reminder"}


def parse_direction(value: str) -> str | None:
    """TXN_DIRECTION 'Inward' / 'OUTWARD' / 'in' / 'Outward Transaction' -> 'inward' / 'outward', or None."""
    words = re.sub(r"[^a-z ]", " ", str(value).lower()).split()
    text = " ".join(w for w in words if w not in ("transaction", "transactions", "txn"))
    return {"inward": "inward", "in": "inward", "outward": "outward", "out": "outward"}.get(text)


SIGNATURE = "<p>Regards<br/>Reconciliation<br/>Nagad Limited</p>"
P = '<p style="margin:0 0 12px">'
WRAP = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.45">{}\n  ' + SIGNATURE + "\n</div>\n"


def _date_text(transactions: list) -> str:
    """'02 Sep 2026', or '02 Sep 2026 to 04 Sep 2026' when the transactions span several days."""
    dates = sorted(t.approval_date or t.txn_datetime.date() for t in transactions)
    first, last = dates[0].strftime("%d %b %Y"), dates[-1].strftime("%d %b %Y")
    return first if first == last else f"{first} to {last}"


def build_email(partner_name: str, mail_type: str, transactions: list) -> tuple[str, str]:
    """Return (subject, html_body) for one partner and mail type, worded as in docs/Email_Template.docx.
    The transactions go in an attached Excel file (transactions_xlsx), as the templates say."""
    dates = _date_text(transactions)

    if mail_type == "inward":
        subject = f"Successful at NAGAD but not found in OIC Settlement File - {partner_name} - Dated {dates}"
        text = f"""
  {P}Dear Concern</p>
  {P}Assalamualaikum.</p>
  {P}This is to bring to your kind attention that the attached NPSB Inward and Bangla QR Acquirer transactions
     dated {dates} were successfully processed at NAGAD\u2019s end; however, the transactions are not reflected
     in the Bangladesh Bank OIC Settlement File.</p>
  {P}As these transactions are not included in the settlement file, the corresponding settlement funds have not
     yet been received by NAGAD. This may result in a financial exposure if the matter remains unresolved.</p>
  {P}We would highly appreciate your support in investigating the matter on priority and identifying the reason
     for the transactions not being reflected in the OIC Settlement File. Kindly take the necessary corrective
     measures and arrange the corresponding settlement at the earliest possible time to minimize any potential
     financial impact.</p>
  {P}For your review and necessary action, please find attached the required transaction details.</p>"""
    else:  # outward
        subject = f"NPSB Outward Transactions - Claim Confirmation Required - {partner_name} - Dated {dates}"
        text = f"""
  {P}Dear Concern,</p>
  {P}Assalamualaikum.</p>
  {P}Please find attached a list of transactions. We would appreciate your review and feedback on these
     transactions. Kindly confirm whether there are any claims at your end.<br/>
     In the absence of any claim or observation, we will proceed with the necessary action from our end
     accordingly.</p>
  {P}<b>Kindly note that we are expecting your feedback within 5 working days. If we do not receive any feedback
     within this timeframe, we will consider that there is no claim from your end regarding these
     transactions.</b></p>
  {P}Your prompt feedback will help us complete the reconciliation process smoothly.</p>
  {P}Thank you for your continued cooperation and support.</p>"""

    return subject, WRAP.format(text)


# The attachment has the same columns as the uploaded file
ATTACHMENT_COLUMNS = ["NPSB_TXN_RRN", "APPROVAL_DATE", "APPROVAL_DATETIME", "TXN_TYPE", "TXN_ID",
                      "FIRST_TXN_STATUS_NAME", "TXN_AMOUNT", "FROMAC_NAME", "TOAC_TYPE", "ORG_TXN_STAN",
                      "KEY_ORG_NM", "NPSB_ORG_CODE", "TXN_DIRECTION"]


def transactions_xlsx(transactions: list) -> bytes:
    """The transactions of one email as an Excel file (the attachment), in the upload file's format."""
    import pandas as pd
    from .excel_parser import SHEET_NAME, to_xlsx

    rows = [[
        t.rrn,
        t.approval_date,  # a real date cell, as in the uploaded file
        t.approval_datetime_text or t.txn_datetime.strftime("%d-%b-%y %I.%M.%S.%f %p").upper(),
        t.txn_type, t.txn_id or "", t.status, float(t.amount), t.from_account_name or "", t.to_account_type or "",
        t.stan, t.partner_name, t.org_code, (t.mail_type or "").capitalize(),
    ] for t in sorted(transactions, key=lambda t: t.txn_datetime)]
    return to_xlsx(pd.DataFrame(rows, columns=ATTACHMENT_COLUMNS), SHEET_NAME)


def attachment_name(partner_name: str, mail_type: str, transactions: list) -> str:
    """'Successful_at_Nagad_not_found_in_OIC_bKash_Dated_02-09-2026.xlsx' (inward) or
    'NPSB_Outward_Transactions_Rocket_Dated_02-09-2026.xlsx' (outward)."""
    first = min(t.approval_date or t.txn_datetime.date() for t in transactions).strftime("%d-%m-%Y")
    kind = "Successful_at_Nagad_not_found_in_OIC" if mail_type == "inward" else "NPSB_Outward_Transactions"
    partner = re.sub(r"[^A-Za-z0-9]+", "_", partner_name).strip("_")
    return f"{kind}_{partner}_Dated_{first}.xlsx"


def build_followup(mail_type: str, original_subject: str, sent_at, txn_count: int, total: float,
                   reply_status: str, number: int) -> tuple[str, str]:
    """Default follow-up for a sent email: (subject, html_body). The admin edits it before sending.
    The transactions are attached again.

    No reply yet -> the reminder from docs/Email_Template.docx (outward), or a settlement reminder (inward).
    Reply received -> thanks, and a request for what is still missing.
    """
    subject = original_subject if original_subject.lower().startswith("re:") else f"Re: {original_subject}"
    sent_on = sent_at.strftime("%d %b %Y") if sent_at else "earlier"
    summary = f"<b>{txn_count}</b> transaction(s) totalling <b>BDT {total:,.2f}</b>"

    if reply_status == "received":
        text = f"""
  {P}Dear Concern,</p>
  {P}Assalamualaikum.</p>
  {P}Thank you for your reply to our email of {sent_on} regarding {summary}.</p>
  {P}To complete the reconciliation, we still need the following from your end:</p>
  <p style="margin:0 0 12px;background:#fff7d6;padding:6px 8px">[Describe what is still needed, e.g. the status of RRN ...]</p>
  {P}The transaction details are attached again for your reference.</p>"""
    elif mail_type == "inward":
        text = f"""
  {P}Dear Concern,</p>
  {P}Assalamualaikum.</p>
  {P}This is a soft reminder{f" (follow-up {number})" if number > 1 else ""} regarding our email of {sent_on}
     about {summary} that were successfully processed at NAGAD\u2019s end but are not reflected in the
     Bangladesh Bank OIC Settlement File. We have not yet received the corresponding settlement or your feedback.</p>
  {P}Kindly arrange the settlement at the earliest possible time to minimize any potential financial impact.
     The transaction details are attached again for your reference.</p>"""
    else:  # outward: the "Outward Reminder" template
        text = f"""
  {P}Dear Concern.</p>
  {P}Assalamualaikum.</p>
  {P}This is a soft reminder, if we didn\u2019t get any feedback from your end within COB today, we will assuming
     that there are no claim from your end. So, we will be proceeding with necessary action from our end.</p>"""
    return subject, WRAP.format(text)


@dataclass
class SendResult:
    attempts: int
    refused: dict[str, str] = field(default_factory=dict)  # address -> reason, for recipients the server refused
    message_id: str = ""                                   # Message-ID header, so replies can join the thread


class RecipientsRefused(RuntimeError):
    """The server refused every recipient (permanent: not retried)."""

    def __init__(self, refused: dict[str, str]):
        super().__init__("Recipient refused: " + "; ".join(f"{a} ({r})" for a, r in refused.items()))
        self.refused = refused


def _reason(code, text) -> str:
    text = text.decode(errors="replace") if isinstance(text, bytes) else str(text)
    return f"{code} {text}".strip()[:250]


def send_email(to: list[str], cc: list[str], subject: str, html_body: str, in_reply_to: str | None = None,
               attachments: list[tuple[str, bytes]] | None = None) -> SendResult:
    """Send one email. The server may accept some recipients and refuse others: those are in
    SendResult.refused instead of being dropped silently. in_reply_to: Message-ID of an earlier
    email, so this one shows in the same conversation (follow-ups). attachments: (file name, .xlsx bytes).

    Retries on temporary errors (e.g. server down); raises RecipientsRefused when every
    recipient is refused and RuntimeError on any other final failure.
    """
    msg = EmailMessage()
    msg["From"] = config.MAIL_FROM
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    reply_to = settings.get("reply_to")
    if reply_to:
        msg["Reply-To"] = reply_to
    msg["Subject"] = subject
    msg["Message-ID"] = make_msgid(domain=config.MAIL_FROM.rsplit("@", 1)[-1])
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content("Please view this email in an HTML capable mail client.")
    msg.add_alternative(html_body, subtype="html")
    for filename, data in attachments or []:
        msg.add_attachment(data, maintype="application",
                           subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename=filename)

    last_error = None
    for attempt in range(1, config.SMTP_MAX_ATTEMPTS + 1):
        try:
            with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=15) as smtp:
                if config.SMTP_USE_TLS:
                    smtp.starttls()
                if config.SMTP_USER:
                    smtp.login(config.SMTP_USER, config.SMTP_PASSWORD)
                refused = smtp.send_message(msg)  # {address: (code, message)} for refused recipients
            return SendResult(attempt, {addr: _reason(*answer) for addr, answer in refused.items()}, msg["Message-ID"])
        except smtplib.SMTPRecipientsRefused as exc:  # permanent, no retry
            raise RecipientsRefused({addr: _reason(*answer) for addr, answer in exc.recipients.items()})
        except Exception as exc:  # connection problems etc. -> try again
            last_error = exc
            if attempt < config.SMTP_MAX_ATTEMPTS:
                time.sleep(2)

    raise RuntimeError(f"Failed after {config.SMTP_MAX_ATTEMPTS} attempt(s): {last_error}")
