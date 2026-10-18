"""A fake SMTP server for testing. No email leaves your computer.

Run it in its own terminal:
    python test_mail_server.py

Every email the app "sends" is:
  * printed in this terminal (From / To / CC / Subject)
  * saved as an .html file in the "sent_emails" folder - double-click to open it in your browser
"""
import time
from datetime import datetime
from email import message_from_bytes, policy
from pathlib import Path

from aiosmtpd.controller import Controller

HOST, PORT = "localhost", 1025          # must match SMTP_HOST / SMTP_PORT in .env
OUTPUT_DIR = Path(__file__).parent / "sent_emails"


class SaveEmailHandler:
    async def handle_DATA(self, server, session, envelope):
        msg = message_from_bytes(envelope.content, policy=policy.default)
        html_part = msg.get_body(preferencelist=("html", "plain"))
        body = html_part.get_content() if html_part else ""

        OUTPUT_DIR.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        file = OUTPUT_DIR / f"{stamp}.html"
        header = (
            f"<p><b>From:</b> {msg['From']}<br><b>To:</b> {msg['To']}<br>"
            f"<b>CC:</b> {msg['Cc'] or ''}<br><b>Subject:</b> {msg['Subject']}</p><hr>"
        )
        file.write_text(header + body, encoding="utf-8")

        print(f"[{datetime.now():%H:%M:%S}] Email received")
        print(f"   To:      {msg['To']}")
        print(f"   CC:      {msg['Cc']}")
        print(f"   Subject: {msg['Subject']}")
        print(f"   Saved:   {file}\n")
        return "250 OK"


if __name__ == "__main__":
    controller = Controller(SaveEmailHandler(), hostname=HOST, port=PORT)
    controller.start()
    print(f"Test mail server running on {HOST}:{PORT}")
    print(f"Emails will be saved in: {OUTPUT_DIR}")
    print("Press Ctrl+C to stop.\n")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        controller.stop()
