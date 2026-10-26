"""All settings are read from the .env file (see .env.example)."""
import os
import secrets

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

# Login (JWT). Set JWT_SECRET to a long random string in .env, e.g. the output of:
#   python -c "import secrets; print(secrets.token_urlsafe(48))"
# Without it a random secret is used, so everyone is signed out when the server restarts.
JWT_SECRET = os.getenv("JWT_SECRET") or secrets.token_urlsafe(48)
JWT_SECRET_IS_RANDOM = not os.getenv("JWT_SECRET")
JWT_ISSUER = "npsb-email-automation"

# Short-lived access token (sent as "Authorization: Bearer ...") + long-lived refresh
# token (httpOnly cookie) that silently renews it.
ACCESS_TOKEN_MINUTES = int(os.getenv("ACCESS_TOKEN_MINUTES", "15"))
REFRESH_TOKEN_DAYS = int(os.getenv("REFRESH_TOKEN_DAYS", "1"))                 # normal sign-in
REFRESH_TOKEN_REMEMBER_DAYS = int(os.getenv("REFRESH_TOKEN_REMEMBER_DAYS", "30"))  # "Remember me"
# true when the app is served over HTTPS (the cookie is then only sent over HTTPS)
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"

# Brute-force protection
MAX_FAILED_LOGINS = int(os.getenv("MAX_FAILED_LOGINS", "5"))       # then the account is locked...
LOCKOUT_MINUTES = int(os.getenv("LOCKOUT_MINUTES", "15"))          # ...for this long
LOGIN_RATE_LIMIT_PER_MINUTE = int(os.getenv("LOGIN_RATE_LIMIT_PER_MINUTE", "10"))  # per IP address

# "Forgot password" emails link to this address (the frontend)
APP_BASE_URL = os.getenv("APP_BASE_URL", "http://localhost:5173").rstrip("/")
PASSWORD_RESET_MINUTES = int(os.getenv("PASSWORD_RESET_MINUTES", "30"))

# Set to false once everyone has an account, so strangers cannot sign up
# (signed-in users can still create accounts for others). The first account is always allowed.
ALLOW_REGISTRATION = os.getenv("ALLOW_REGISTRATION", "true").lower() == "true"

# Roles: "admin" or "user". Creating an admin account needs this code (only admins should know it).
ADMIN_SIGNUP_CODE = os.getenv("ADMIN_SIGNUP_CODE", "1234")

# Real email addresses only
EMAIL_DNS_CHECK = os.getenv("EMAIL_DNS_CHECK", "true").lower() == "true"     # domain must have a mail server
VERIFICATION_CODE_MINUTES = int(os.getenv("VERIFICATION_CODE_MINUTES", "15"))  # emailed 6-digit code
VERIFICATION_MAX_ATTEMPTS = 5                                                # wrong codes before it expires
VERIFICATION_RESEND_SECONDS = 60                                             # wait before sending another
