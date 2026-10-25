import smtplib
import time
from dataclasses import dataclass, field
from email.message import EmailMessage
from html import escape

from . import config


def mask_account(value: str) -> str:
    value = str(value)
    if len(value) <= 6:
        return "*" * len(value)
    return value[:3] + "*" * (len(value) - 6) + value[-3:]


def build_email(partner_name: str, transactions: list) -> tuple[str, str]:
    """Return (subject, html_body) for one partner."""
    count = len(transactions)
    total = sum(float(t.amount) for t in transactions)
    dates = sorted(t.txn_datetime for t in transactions)
    date_range = dates[0].strftime("%d %b %Y")
    if dates[-1].date() != dates[0].date():
        date_range += " - " + dates[-1].strftime("%d %b %Y")

    subject = f"NPSB Clarification Request - {partner_name} - {count} transaction(s) with unknown response ({date_range})"

    cell = "border:1px solid #ccc;padding:6px;"
    rows_html = ""
    for i, t in enumerate(transactions, start=1):
        values = [
            str(i),
            t.txn_datetime.strftime("%d-%m-%Y %H:%M:%S"),
            escape(t.rrn),
            escape(t.stan),
            f"{float(t.amount):,.2f}",
            mask_account(t.source_account),
            mask_account(t.beneficiary_account),
            escape(t.txn_type),
            escape(t.response_code),
            escape(t.nagad_status),
        ]
        rows_html += "<tr>" + "".join(f'<td style="{cell}">{v}</td>' for v in values) + "</tr>"

    body = f"""
<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
  <p>Dear {escape(partner_name)} Team,</p>
  <p>Greetings from Nagad.</p>
  <p>The following <b>{count}</b> NPSB transaction(s), totalling <b>BDT {total:,.2f}</b>,
     received an unknown response code and are still pending at Nagad.
     Kindly confirm the final status of each transaction at your end
     (Success / Failed / Reversed) so that we can complete reconciliation.</p>
  <table style="border-collapse:collapse;font-size:13px">
    <thead style="background:#f4f4f4">
      <tr>
        <th style="{cell}">#</th><th style="{cell}">Date &amp; Time</th>
        <th style="{cell}">RRN</th><th style="{cell}">STAN</th>
        <th style="{cell}">Amount (BDT)</th><th style="{cell}">Source</th>
        <th style="{cell}">Beneficiary</th><th style="{cell}">Type</th>
        <th style="{cell}">Resp. Code</th><th style="{cell}">Status at Nagad</th>
      </tr>
    </thead>
    <tbody>{rows_html}</tbody>
  </table>
  <p>Please reply to this email with your findings at your earliest convenience.</p>
  <p>Regards,<br/>Reconciliation &amp; Dispute Management Team<br/>Nagad</p>
</div>
"""
    return subject, body


@dataclass
class SendResult:
    attempts: int
    refused: dict[str, str] = field(default_factory=dict)  # address -> reason, for recipients the server refused


class RecipientsRefused(RuntimeError):
    """The server refused every recipient (permanent: not retried)."""

    def __init__(self, refused: dict[str, str]):
        super().__init__("Recipient refused: " + "; ".join(f"{a} ({r})" for a, r in refused.items()))
        self.refused = refused


def _reason(code, text) -> str:
    text = text.decode(errors="replace") if isinstance(text, bytes) else str(text)
    return f"{code} {text}".strip()[:250]


def send_email(to: list[str], cc: list[str], subject: str, html_body: str) -> SendResult:
    """Send one email. The server may accept some recipients and refuse others: those are in
    SendResult.refused instead of being dropped silently.

    Retries on temporary errors (e.g. server down); raises RecipientsRefused when every
    recipient is refused and RuntimeError on any other final failure.
    """
    msg = EmailMessage()
    msg["From"] = config.MAIL_FROM
    msg["To"] = ", ".join(to)
    if cc:
        msg["Cc"] = ", ".join(cc)
    msg["Reply-To"] = config.REPLY_TO
    msg["Subject"] = subject
    msg.set_content("This email contains an HTML table. Please view it in an HTML capable mail client.")
    msg.add_alternative(html_body, subtype="html")

    last_error = None
    for attempt in range(1, config.SMTP_MAX_ATTEMPTS + 1):
        try:
            with smtplib.SMTP(config.SMTP_HOST, config.SMTP_PORT, timeout=15) as smtp:
                if config.SMTP_USE_TLS:
                    smtp.starttls()
                if config.SMTP_USER:
                    smtp.login(config.SMTP_USER, config.SMTP_PASSWORD)
                refused = smtp.send_message(msg)  # {address: (code, message)} for refused recipients
            return SendResult(attempt, {addr: _reason(*answer) for addr, answer in refused.items()})
        except smtplib.SMTPRecipientsRefused as exc:  # permanent, no retry
            raise RecipientsRefused({addr: _reason(*answer) for addr, answer in exc.recipients.items()})
        except Exception as exc:  # connection problems etc. -> try again
            last_error = exc
            if attempt < config.SMTP_MAX_ATTEMPTS:
                time.sleep(2)

    raise RuntimeError(f"Failed after {config.SMTP_MAX_ATTEMPTS} attempt(s): {last_error}")
