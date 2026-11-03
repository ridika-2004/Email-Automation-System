"""Server settings that admins change on the System Settings page instead of in backend/.env.

Each setting starts with its .env value. Once an admin saves it, it is stored in app_settings
(key "server.<NAME>") and applied to the running server at once: the code reads these values from
the config module every time it uses them. Passwords and the admin code are stored encrypted with a
key made from JWT_SECRET (if JWT_SECRET changes, they can no longer be read and the .env value is used).

Not here, because they can't change while the server runs: the database connection, JWT_SECRET,
APP_BASE_URL and COOKIE_SECURE.
"""
import base64
import hashlib
import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.orm import Session

from . import config, models

log = logging.getLogger("uvicorn.error")

PREFIX = "server."
HOST_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")
EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")


@dataclass(frozen=True)
class Field:
    name: str          # attribute of the config module, same as the .env name
    label: str
    kind: str          # text / host / email / user / int / bool / secret
    group: str
    help: str = ""
    low: int | None = None
    high: int | None = None
    required: bool = False


GROUPS = [
    ("smtp", "Mail server (sending)", "Every email, follow-up and sign-in code is sent through this server."),
    ("sending", "Sending retries", "What happens when the mail server can't be reached."),
    ("inbox", "Reading partner mail (inbox)",
     "The mailbox partners' replies and other mail are read from. Empty fields use the sending mailbox."),
    ("jobs", "Background jobs", ""),
    ("security", "Sign-up and security", ""),
]

FIELDS = [
    Field("SMTP_HOST", "Server", "host", "smtp", "e.g. smtp.gmail.com", required=True),
    Field("SMTP_PORT", "Port", "int", "smtp", "587 with STARTTLS", 1, 65535),
    Field("SMTP_USE_TLS", "Use STARTTLS encryption", "bool", "smtp", "On for Gmail and most real servers"),
    Field("SMTP_USER", "User", "user", "smtp", "The mailbox that signs in. Empty: no sign-in (test mail server)"),
    Field("SMTP_PASSWORD", "Password", "secret", "smtp", "For Gmail: a 16-character app password, without spaces"),
    Field("MAIL_FROM", "Sender address", "email", "smtp",
          "Shown as From; partners' replies come back here. Keep it the same as the user", required=True),
    Field("SMTP_MAX_ATTEMPTS", "Attempts per email", "int", "sending", "Before the email is marked FAILED", 1, 10),
    Field("SMTP_RETRY_SECONDS", "Wait between attempts (seconds)", "int", "sending", "", 0, 300),
    Field("INBOX_ENABLED", "Read partner mail", "bool", "inbox", "Off: the mailbox is not checked"),
    Field("IMAP_HOST", "IMAP server", "host", "inbox", "Empty: imap.gmail.com when sending through Gmail"),
    Field("IMAP_PORT", "Port", "int", "inbox", "993 (SSL)", 1, 65535),
    Field("IMAP_USER", "User", "user", "inbox", "Empty: the sending user"),
    Field("IMAP_PASSWORD", "Password", "secret", "inbox", "Empty: the sending password"),
    Field("IMAP_FOLDER", "Folder", "text", "inbox", "Usually INBOX", required=True),
    Field("INBOX_CHECK_SECONDS", "Check every (seconds)", "int", "inbox", "", 30, 86400),
    Field("INBOX_FIRST_SCAN_DAYS", "First check looks back (days)", "int", "inbox", "", 1, 365),
    Field("AUTO_FOLLOWUP_CHECK_SECONDS", "Look for due follow-ups every (seconds)", "int", "jobs",
          "Automatic follow-ups themselves are switched on in Email Configuration", 30, 86400),
    Field("ALLOW_REGISTRATION", "Anyone can create an account", "bool", "security",
          "Off: only admins add accounts (the first account is always allowed)"),
    Field("ADMIN_SIGNUP_CODE", "Admin code", "secret", "security", "Needed to create an admin account", 4, 100),
    Field("EMAIL_DNS_CHECK", "Check that email domains accept mail", "bool", "security", "For accounts and partner addresses"),
    Field("MAX_FAILED_LOGINS", "Wrong passwords before the account locks", "int", "security", "", 1, 50),
    Field("LOCKOUT_MINUTES", "Lock for (minutes)", "int", "security", "", 1, 1440),
    Field("LOGIN_RATE_LIMIT_PER_MINUTE", "Sign-in attempts per minute from one address", "int", "security", "", 1, 1000),
    Field("VERIFICATION_CODE_MINUTES", "Emailed code valid for (minutes)", "int", "security", "", 1, 120),
    Field("PASSWORD_RESET_MINUTES", "Password reset link valid for (minutes)", "int", "security", "", 5, 1440),
    Field("ACCESS_TOKEN_MINUTES", "Session token lifetime (minutes)", "int", "security",
          "Renewed silently while the app is open", 1, 120),
    Field("REFRESH_TOKEN_DAYS", "Stay signed in for (days)", "int", "security", "Without \"Keep me signed in\"", 1, 30),
    Field("REFRESH_TOKEN_REMEMBER_DAYS", "\"Keep me signed in\" lasts (days)", "int", "security", "", 1, 365),
]
BY_NAME = {f.name: f for f in FIELDS}
SMTP_FIELDS = {"SMTP_HOST", "SMTP_PORT", "SMTP_USE_TLS", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"}
IMAP_FIELDS = {"INBOX_ENABLED", "IMAP_HOST", "IMAP_PORT", "IMAP_USER", "IMAP_PASSWORD", "IMAP_FOLDER"}

# The .env values, kept before anything is changed
ENV_VALUES = {f.name: getattr(config, f.name) for f in FIELDS}
_unreadable: set[str] = set()  # stored secrets that could not be decrypted


class SettingsError(ValueError):
    pass


# ---------------------------------------------------------------- encryption of secrets

def _fernet() -> Fernet:
    key = hashlib.sha256(("npsb-server-settings:" + config.JWT_SECRET).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def _encrypt(value: str) -> str:
    return "enc:" + _fernet().encrypt(value.encode()).decode()


def _decrypt(stored: str) -> str:
    if not stored.startswith("enc:"):
        raise InvalidToken()
    return _fernet().decrypt(stored[4:].encode()).decode()


# ---------------------------------------------------------------- reading and checking values

def clean(field: Field, value):
    """The value as stored, or SettingsError with a readable message."""
    label = field.label
    if field.kind == "bool":
        if not isinstance(value, bool):
            raise SettingsError(f"{label}: choose on or off.")
        return value
    if field.kind == "int":
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            raise SettingsError(f"{label}: enter a whole number.")
        try:
            number = int(str(value).strip())
        except ValueError:
            raise SettingsError(f"{label}: enter a whole number.")
        if (field.low is not None and number < field.low) or (field.high is not None and number > field.high):
            raise SettingsError(f"{label}: must be between {field.low} and {field.high}.")
        return number
    if not isinstance(value, str):
        raise SettingsError(f"{label}: enter text.")
    value = value.strip()
    if field.kind == "secret":
        if field.low and len(value) < field.low:
            raise SettingsError(f"{label}: at least {field.low} characters.")
        if len(value) > 500:
            raise SettingsError(f"{label}: too long.")
        return value
    if not value:
        if field.required:
            raise SettingsError(f"{label}: can't be empty.")
        return ""
    if field.kind == "host" and not HOST_RE.match(value):
        raise SettingsError(f"{label}: '{value}' is not a server name (e.g. smtp.gmail.com).")
    if field.kind == "email" and not EMAIL_RE.match(value):
        raise SettingsError(f"{label}: '{value}' is not an email address.")
    if field.kind in ("user", "text") and (len(value) > 254 or re.search(r"\s", value) and field.kind == "user"):
        raise SettingsError(f"{label}: '{value}' is not valid.")
    return value


def _rows(db: Session) -> dict[str, models.AppSetting]:
    return {r.key[len(PREFIX):]: r for r in db.query(models.AppSetting).filter(models.AppSetting.key.like(PREFIX + "%"))
            if r.key[len(PREFIX):] in BY_NAME}


def load(db: Session) -> None:
    """At startup: apply every saved setting to the running server."""
    _unreadable.clear()
    for name, row in _rows(db).items():
        field = BY_NAME[name]
        try:
            value = json.loads(row.value)
            value = _decrypt(value) if field.kind == "secret" else clean(field, value)
        except (InvalidToken, ValueError, TypeError):
            _unreadable.add(name)
            setattr(config, name, ENV_VALUES[name])
            log.warning("System Settings: the saved %s can't be read; using the .env value", name)
            continue
        setattr(config, name, value)


def effective(changes: dict | None = None, resets: set[str] = frozenset()) -> dict:
    """The values in effect, with the given changes / resets applied (nothing is saved)."""
    values = {f.name: getattr(config, f.name) for f in FIELDS}
    for name in resets:
        values[name] = ENV_VALUES[name]
    values.update(changes or {})
    return values


def imap_values(v: dict) -> dict:
    """The mailbox that would be read with these values (empty fields: the sending mailbox)."""
    host = v["IMAP_HOST"] or ("imap.gmail.com" if v["SMTP_HOST"].strip().lower() == "smtp.gmail.com" else "")
    return {"host": host, "port": v["IMAP_PORT"], "user": v["IMAP_USER"] or v["SMTP_USER"],
            "password": v["IMAP_PASSWORD"] or v["SMTP_PASSWORD"], "folder": v["IMAP_FOLDER"]}


def parse_changes(values: dict, resets: list[str]) -> tuple[dict, set[str]]:
    unknown = [k for k in list(values) + list(resets) if k not in BY_NAME]
    if unknown:
        raise SettingsError(f"Unknown setting: {', '.join(unknown)}.")
    changes = {name: clean(BY_NAME[name], value) for name, value in values.items()}
    return changes, set(resets) - set(changes)


def save(db: Session, changes: dict, resets: set[str], username: str) -> list[str]:
    """Store and apply. Returns the names that actually changed."""
    rows = _rows(db)
    now = datetime.now()
    changed = []
    for name in resets:
        if name in rows:
            db.delete(rows[name])
            changed.append(name)
        setattr(config, name, ENV_VALUES[name])
        _unreadable.discard(name)
    for name, value in changes.items():
        field = BY_NAME[name]
        if getattr(config, name) == value and name in rows and name not in _unreadable:
            continue
        stored = json.dumps(_encrypt(value) if field.kind == "secret" else value)
        row = rows.get(name)
        if row is None:
            row = models.AppSetting(key=PREFIX + name)
            db.add(row)
        row.value, row.updated_by, row.updated_at = stored, username, now
        setattr(config, name, value)
        _unreadable.discard(name)
        changed.append(name)
    db.commit()
    return changed


def to_dict(db: Session, names: dict[str, str]) -> dict:
    """Everything the System Settings page shows. Secrets are never sent, only whether they are set."""
    rows = _rows(db)
    out = []
    for group, title, description in GROUPS:
        fields = []
        for f in (f for f in FIELDS if f.group == group):
            row = rows.get(f.name)
            source = "portal" if row is not None and f.name not in _unreadable else "env"
            item = {"name": f.name, "label": f.label, "kind": f.kind, "help": f.help, "low": f.low, "high": f.high,
                    "required": f.required, "source": source, "unreadable": f.name in _unreadable,
                    "updated_by_name": names.get(row.updated_by, row.updated_by) if row else None,
                    "updated_at": row.updated_at.isoformat() if row else None}
            current, env = getattr(config, f.name), ENV_VALUES[f.name]
            if f.kind == "secret":
                item.update(is_set=bool(current), env_is_set=bool(env))
            else:
                item.update(value=current, env_value=env)
            fields.append(item)
        out.append({"id": group, "title": title, "description": description, "fields": fields})
    return {"groups": out, "secrets_survive_restart": not config.JWT_SECRET_IS_RANDOM}


def usernames(db: Session) -> list[str]:
    return [r.updated_by for r in _rows(db).values() if r.updated_by]
