"""All settings are read from the .env file (see .env.example)."""
import os

from dotenv import load_dotenv

load_dotenv()


def _list(name: str, default: str) -> list[str]:
    raw = os.getenv(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


# MySQL (the same details you use to connect in MySQL Workbench)
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "npsb_dispute")

# Optional: set DATABASE_URL to use a different database (e.g. sqlite:///test.db)
DATABASE_URL = os.getenv("DATABASE_URL", "")

SMTP_HOST = os.getenv("SMTP_HOST", "localhost")
SMTP_PORT = int(os.getenv("SMTP_PORT", "1025"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_USE_TLS = os.getenv("SMTP_USE_TLS", "false").lower() == "true"
SMTP_MAX_ATTEMPTS = int(os.getenv("SMTP_MAX_ATTEMPTS", "3"))

MAIL_FROM = os.getenv("MAIL_FROM", "npsb-dispute@nagad.test")
REPLY_TO = os.getenv("REPLY_TO", "npsb-recon@nagad.test")
CC_EMAILS = _list("CC_EMAILS", "recon.lead@nagad.test,npsb.ops@nagad.test")

UNKNOWN_RESPONSE_CODES = set(_list("UNKNOWN_RESPONSE_CODES", "68,91,96"))
