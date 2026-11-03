"""Email settings that admins change in the app (Email Configuration page).

Each setting starts with its .env default (config.py) and is stored in the app_settings table
once an admin saves it. Values are cached for a few seconds, so reading them is cheap.
"""
import json
import time
from datetime import datetime

from sqlalchemy.orm import Session

from . import config, models
from .database import SessionLocal

DEFAULTS = {
    # Sent emails with no reply and nothing sent for this many days are "Follow-up due"
    "followup_due_days": config.FOLLOWUP_DUE_DAYS,
    # Send the follow-up of a due email automatically (no admin needed)
    "auto_followup_enabled": config.AUTO_FOLLOWUP_ENABLED,
    # Stop sending automatic follow-ups once an email has had this many follow-ups in total
    "auto_followup_max": config.AUTO_FOLLOWUP_MAX,
    # Copied on every new email
    "cc_emails": config.CC_EMAILS,
}

_cache: dict = {}
_cache_at = 0.0
CACHE_SECONDS = 10


def _load(db: Session) -> dict:
    values = dict(DEFAULTS)
    for row in db.query(models.AppSetting).filter(models.AppSetting.key.in_(DEFAULTS)):
        values[row.key] = json.loads(row.value)
    return values


def current(db: Session | None = None) -> dict:
    """All settings: the saved values, and the .env default for the others."""
    global _cache, _cache_at
    if _cache and time.monotonic() - _cache_at < CACHE_SECONDS:
        return dict(_cache)
    if db is not None:
        _cache = _load(db)
    else:
        with SessionLocal() as own:
            _cache = _load(own)
    _cache_at = time.monotonic()
    return dict(_cache)


def get(name: str):
    return current()[name]


def last_change(db: Session) -> dict | None:
    row = db.query(models.AppSetting).filter(models.AppSetting.key.in_(DEFAULTS))         .order_by(models.AppSetting.updated_at.desc()).first()
    return {"by": row.updated_by, "at": row.updated_at.isoformat()} if row else None


def save(db: Session, values: dict, username: str) -> dict:
    """Store the given settings (only known keys) and return all of them."""
    global _cache_at
    now = datetime.now()
    for key, value in values.items():
        if key not in DEFAULTS:
            continue
        row = db.get(models.AppSetting, key)
        if row is None:
            row = models.AppSetting(key=key)
            db.add(row)
        row.value, row.updated_by, row.updated_at = json.dumps(value), username, now
    db.commit()
    _cache_at = 0.0
    return current(db)
