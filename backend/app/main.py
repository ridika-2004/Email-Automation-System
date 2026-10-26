"""FastAPI app: all API endpoints live in this file.

Flow:
  1. POST /api/uploads                     -> upload & validate file                      (users)
  2. GET  /api/uploads/{id}                -> unknown transactions grouped by partner     (users)
  3. POST /api/uploads/{id}/prepare-emails -> build one email per partner (preview/edit)  (users)
  4. POST /api/uploads/{id}/submit         -> PREPARED -> PENDING: waits for an admin     (users)
  5. GET  /api/pending-emails              -> every PENDING / FAILED email                (everyone)
  6. POST /api/pending-emails/send         -> send the ticked pending emails              (admins)
  7. GET  /api/sent-emails                 -> sent emails: search, partner filter, sort    (everyone)
  8. Follow-up of sent emails: reply status, follow-up emails, notes, history           (admins change, everyone reads)
  9. GET/PUT /api/email-settings           -> follow-up days, automatic follow-ups, CC, Reply-To (admins change)

Automatic follow-ups: when switched on, a background thread sends the follow-up of every email
that is due (see run_auto_followups), as the "system" user.

Every endpoint here needs a signed-in user (JWT). Changing partners and sending emails also
need the admin role. Sign-in, sessions and password recovery live in auth.py; user management
(admins only) in users.py.
"""
import json
import logging
import re
import threading
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from sqlalchemy import and_, func, inspect, or_, text, update
from sqlalchemy.orm import Session, object_session

from . import auth, config, models, settings, users
from .database import Base, SessionLocal, create_database_if_missing, engine, get_db
from .email_check import validate_real_email
from .email_service import (
    MAIL_TYPE_NAMES, MAIL_TYPES, RecipientsRefused, attachment_name, build_email, build_followup, send_email,
    transactions_xlsx,
)
from .excel_parser import FileValidationError, build_template, parse_transactions, split_rows, to_xlsx
from .seed import seed_partners

app = FastAPI(title="NPSB Dispute Email Automation")

# All app endpoints are registered on this router, which rejects requests without a valid token
api = APIRouter(dependencies=[Depends(auth.get_current_user)])

app.add_middleware(
    CORSMiddleware,
    allow_origins=[config.APP_BASE_URL],
    allow_credentials=True,              # the refresh token is an httpOnly cookie
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_database_if_missing()             # create the MySQL database if needed
    Base.metadata.create_all(bind=engine)   # create tables if they don't exist
    add_missing_columns()
    if config.JWT_SECRET_IS_RANDOM:
        print("WARNING: JWT_SECRET is not set in .env - everyone is signed out when the server restarts.")
    with SessionLocal() as db:
        seed_partners(db)                    # add demo partners on first run
    threading.Thread(target=auto_followup_loop, name="auto-followups", daemon=True).start()


@app.on_event("shutdown")
def on_shutdown():
    _stop.set()


# Columns added after a table was first created: (table, column, SQL type + default).
# create_all() never changes existing tables, so these are added on startup when missing.
LATER_COLUMNS = [
    ("email_dispatches", "is_edited", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("uploads", "file_content", "LONGBLOB NULL"),
    ("partner_emails", "problem", "VARCHAR(255) NULL"),
    ("partner_emails", "problem_at", "DATETIME NULL"),
    ("email_dispatches", "delivery_issues", "TEXT NULL"),
    ("email_dispatches", "submitted_by", "VARCHAR(30) NULL"),
    ("email_dispatches", "submitted_at", "DATETIME NULL"),
    ("email_dispatches", "sent_by", "VARCHAR(30) NULL"),
    ("email_dispatches", "sending_since", "DATETIME NULL"),
    ("email_dispatches", "message_id", "VARCHAR(255) NULL"),
    ("email_dispatches", "reply_status", "VARCHAR(20) NOT NULL DEFAULT 'not_received'"),
    ("email_dispatches", "reply_status_by", "VARCHAR(30) NULL"),
    ("email_dispatches", "reply_status_at", "DATETIME NULL"),
    ("email_dispatches", "followup_count", "INT NOT NULL DEFAULT 0"),
    ("email_dispatches", "last_followup_at", "DATETIME NULL"),
    ("email_dispatches", "remarks", "TEXT NULL"),
    ("email_dispatches", "remarks_by", "VARCHAR(30) NULL"),
    ("email_dispatches", "remarks_at", "DATETIME NULL"),
    ("transactions", "mail_type", "VARCHAR(20) NULL"),
    ("email_dispatches", "mail_type", "VARCHAR(20) NOT NULL DEFAULT 'outward'"),  # older emails were outward
    # the "Final_Report_for_DMS_Claim" file format
    ("transactions", "approval_date", "DATE NULL"),
    ("transactions", "approval_datetime_text", "VARCHAR(40) NULL"),
    ("transactions", "txn_id", "VARCHAR(40) NULL"),
    ("transactions", "from_account_name", "VARCHAR(150) NULL"),
    ("transactions", "to_account_type", "VARCHAR(40) NULL"),
    ("users", "email", "VARCHAR(254) NULL"),
    ("users", "full_name", "VARCHAR(100) NOT NULL DEFAULT ''"),
    ("users", "email_verified", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("users", "email_verified_at", "DATETIME NULL"),
    ("users", "pending_email", "VARCHAR(254) NULL"),
    ("users", "token_version", "INT NOT NULL DEFAULT 0"),
    ("users", "failed_login_count", "INT NOT NULL DEFAULT 0"),
    ("users", "locked_until", "DATETIME NULL"),
    ("users", "last_login_at", "DATETIME NULL"),
    ("users", "password_changed_at", "DATETIME NULL"),
    ("users", "updated_at", "DATETIME NULL"),
    ("users", "role", "VARCHAR(10) NOT NULL DEFAULT 'user'"),  # existing accounts become "user"
]
# Columns that are no longer used: (table, column). Removed on startup when present.
REMOVED_COLUMNS: list[tuple[str, str]] = [
    # not in the file format any more (response codes, account numbers) / partners are matched by name
    ("transactions", "response_code"),
    ("transactions", "is_unknown"),
    ("transactions", "source_account"),
    ("transactions", "beneficiary_account"),
    ("uploads", "unknown_rows"),
    ("partners", "institution_code"),
]
# Columns that hold longer values now: (table, column, SQL type). MySQL only.
WIDENED_COLUMNS = [
    ("transactions", "txn_type", "VARCHAR(80) NOT NULL"),
    ("transactions", "nagad_status", "VARCHAR(40) NOT NULL"),
]


def add_missing_columns():
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl in LATER_COLUMNS:
            if column not in {c["name"] for c in inspector.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
        # users.email must be unique (the index is created separately so this also works on SQLite)
        has_unique_email = (
            any(ix["column_names"] == ["email"] and ix["unique"] for ix in inspector.get_indexes("users"))
            or any(uc["column_names"] == ["email"] for uc in inspector.get_unique_constraints("users"))
        )
        if not has_unique_email:
            conn.execute(text("CREATE UNIQUE INDEX ux_users_email ON users (email)"))
    drop_removed_columns()
    upgrade_dispatch_unique_key()
    widen_columns()


def drop_removed_columns():
    """Drop REMOVED_COLUMNS one by one; a failure is reported but does not stop the server."""
    inspector = inspect(engine)
    for table, column in REMOVED_COLUMNS:
        if column not in {c["name"] for c in inspector.get_columns(table)}:
            continue
        try:
            with engine.begin() as conn:
                conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
            print(f"Removed column {table}.{column} (no longer used).")
        except Exception as exc:
            print(f"WARNING: could not remove column {table}.{column}: {exc}")


def widen_columns():
    if engine.dialect.name != "mysql":
        return
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl in WIDENED_COLUMNS:
            current = next((c for c in inspector.get_columns(table) if c["name"] == column), None)
            length = getattr(current["type"], "length", None) if current else None
            if length is not None and length < int(ddl.split("(")[1].split(")")[0]):
                conn.execute(text(f"ALTER TABLE {table} MODIFY {column} {ddl}"))


def upgrade_dispatch_unique_key():
    """One email per partner AND mail type: replace the old unique key (upload_id, partner_id) with
    (upload_id, partner_id, mail_type). The new key is added first, so the foreign key on upload_id
    always has an index (MySQL needs one)."""
    if engine.dialect.name != "mysql":
        return  # SQLite test databases are created with the new key
    inspector = inspect(engine)
    keys = inspector.get_unique_constraints("email_dispatches") + \
        [ix for ix in inspector.get_indexes("email_dispatches") if ix.get("unique")]
    old = {k["name"] for k in keys if k["column_names"] == ["upload_id", "partner_id"]}
    has_new = any(k["column_names"] == ["upload_id", "partner_id", "mail_type"] for k in keys)
    try:
        with engine.begin() as conn:
            if not has_new:
                conn.execute(text("ALTER TABLE email_dispatches ADD UNIQUE KEY ux_dispatch_upload_partner_type "
                                  "(upload_id, partner_id, mail_type)"))
            for name in old:
                conn.execute(text(f"ALTER TABLE email_dispatches DROP INDEX `{name}`"))
    except Exception as exc:
        print(f"WARNING: could not update the unique key of email_dispatches ({exc}). "
              "A partner with two mail types in one file may fail to prepare.")


# ---------------------------------------------------------------- helpers

def partner_to_dict(p: models.Partner) -> dict:
    return {
        "id": p.id,
        "name": p.name,
        "is_active": p.is_active,
        "emails": [{
            "id": e.id, "email": e.email, "is_active": e.is_active, "problem": e.problem,
            "problem_at": e.problem_at.isoformat() if e.problem_at else None,
        } for e in p.emails],
    }


# created_by of automatic follow-ups. "#" is not allowed in usernames, so no account can have it.
SYSTEM_USER = "#auto"


def user_names(db: Session, usernames) -> dict[str, str]:
    """username -> full name (the username itself when no name is set)."""
    wanted = {u for u in usernames if u}
    if not wanted:
        return {}
    rows = db.query(models.User.username, models.User.full_name).filter(models.User.username.in_(wanted)).all()
    return {SYSTEM_USER: "Sent automatically", **{username: full_name or username for username, full_name in rows}}


def dispatches_to_dicts(db: Session, dispatches: list[models.EmailDispatch]) -> list[dict]:
    names = user_names(db, [n for d in dispatches for n in (d.submitted_by, d.sent_by, d.reply_status_by, d.remarks_by)])
    return [dispatch_to_dict(d, names) for d in dispatches]


def dispatch_to_dict(d: models.EmailDispatch, names: dict[str, str] | None = None) -> dict:
    if names is None:
        names = user_names(object_session(d), [d.submitted_by, d.sent_by, d.reply_status_by, d.remarks_by])
    return {
        "id": d.id,
        "partner_name": d.partner.name,
        "to": d.to_emails.split(","),
        "cc": [c for c in d.cc_emails.split(",") if c],
        "subject": d.subject,
        "body_html": d.body_html,
        "is_edited": d.is_edited,
        "txn_count": d.txn_count,
        "total_amount": float(d.total_amount),
        "status": d.status,
        "attempts": d.attempts,
        "error": d.error,
        "sent_at": d.sent_at.isoformat() if d.sent_at else None,
        "delivery_issues": issues_of(d),
        "upload_id": d.upload_id,
        "upload_filename": d.upload.filename,
        "mail_type": d.mail_type,
        "mail_type_label": MAIL_TYPE_NAMES.get(d.mail_type, d.mail_type),
        "submitted_by": d.submitted_by,
        "submitted_by_name": names.get(d.submitted_by, d.submitted_by),
        "submitted_at": d.submitted_at.isoformat() if d.submitted_at else None,
        "sent_by": d.sent_by,                 # while SENDING: the admin sending it right now
        "sent_by_name": names.get(d.sent_by, d.sent_by),
        # follow-up
        "reply_status": d.reply_status,
        "reply_status_by_name": names.get(d.reply_status_by, d.reply_status_by),
        "reply_status_at": d.reply_status_at.isoformat() if d.reply_status_at else None,
        "followup_count": d.followup_count,
        "last_followup_at": d.last_followup_at.isoformat() if d.last_followup_at else None,
        "followup_due": followup_due(d),
        "remarks": d.remarks or "",
        "remarks_by_name": names.get(d.remarks_by, d.remarks_by),
        "remarks_at": d.remarks_at.isoformat() if d.remarks_at else None,
    }


def followup_due(d: models.EmailDispatch) -> bool:
    """Sent, no reply, and nothing sent to the partner for "followup_due_days" (Email Configuration)."""
    last_contact = d.last_followup_at or d.sent_at
    return (d.status == "SENT" and d.reply_status == "not_received" and last_contact is not None
            and last_contact < datetime.now() - timedelta(days=settings.get("followup_due_days")))


def issues_of(dispatch: models.EmailDispatch) -> list[dict]:
    return json.loads(dispatch.delivery_issues) if dispatch.delivery_issues else []


def record_refused(dispatch: models.EmailDispatch, address: str, reason: str) -> None:
    """The mail server refused this recipient: note it on the email, and flag the partner's
    address so it is left out of new emails until someone fixes or clears it."""
    address = address.strip().lower()
    now = datetime.now()
    issues = [i for i in issues_of(dispatch) if i["email"] != address]
    issues.append({"email": address, "reason": reason, "at": now.isoformat(timespec="seconds")})
    dispatch.delivery_issues = json.dumps(issues)
    for partner_email in dispatch.partner.emails:
        if partner_email.email.strip().lower() == address:
            partner_email.problem = f"Refused: {reason}"[:255]
            partner_email.problem_at = now


MAIL_TYPE_ORDER = list(MAIL_TYPES)


def name_key(name: str) -> str:
    """Partners and KEY_ORG_NM are matched by name, ignoring case and extra spaces: ' UPAY ' == 'Upay'."""
    return " ".join(str(name).split()).casefold()


def group_by_partner(upload: models.Upload) -> dict[tuple[str, str], list[models.Transaction]]:
    """{(partner name key, mail type): [transactions]} for one upload: one email each."""
    grouped = defaultdict(list)
    for t in upload.transactions:
        if t.mail_type in MAIL_TYPES:
            grouped[(name_key(t.partner_name), t.mail_type)].append(t)
    return dict(sorted(grouped.items(), key=lambda item: (item[0][0], MAIL_TYPE_ORDER.index(item[0][1]))))


def dispatch_transactions(d: models.EmailDispatch) -> list[models.Transaction]:
    mail_type = "outward" if d.mail_type == "outward_reminder" else d.mail_type
    return group_by_partner(d.upload).get((name_key(d.partner.name), mail_type), [])


def partners_by_name(db: Session) -> dict[str, models.Partner]:
    return {name_key(p.name): p for p in db.query(models.Partner).all()}


def attachment_for(d: models.EmailDispatch) -> list[tuple[str, bytes]]:
    """The email's transactions as an attached Excel file ("please find attached" in the templates)."""
    txns = dispatch_transactions(d)
    return [(attachment_name(d.partner.name, d.mail_type, txns), transactions_xlsx(txns))] if txns else []


def get_upload_or_404(db: Session, upload_id: int) -> models.Upload:
    upload = db.get(models.Upload, upload_id)
    if not upload:
        raise HTTPException(404, "Upload not found")
    return upload


# ---------------------------------------------------------------- config

@api.get("/api/config")
def get_config():
    """Settings shown in the UI."""
    return {
        "smtp_host": config.SMTP_HOST,
        "smtp_port": config.SMTP_PORT,
        "mail_from": config.MAIL_FROM,
        "cc_emails": settings.get("cc_emails"),
    }


# ---------------------------------------------------------------- partners

class EmailIn(BaseModel):
    email: str
    is_active: bool = True
    clear_problem: bool = False   # "Clear" on a refused address: use it again

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError(f"'{value}' is not a valid email address")
        return value.lower()


class PartnerIn(BaseModel):
    name: str
    is_active: bool = True
    emails: list[EmailIn] = []


def build_partner_emails(emails: list[EmailIn], existing: list[models.PartnerEmail]) -> list[models.PartnerEmail]:
    """New PartnerEmail rows from the form. New addresses must be able to receive mail;
    a "refused" flag stays on an unchanged address unless the user cleared it."""
    old = {e.email.lower(): e for e in existing}
    seen, result = set(), []
    for e in emails:
        if e.email in seen:
            raise HTTPException(400, f"{e.email} is listed twice.")
        seen.add(e.email)
        previous = old.get(e.email)
        if previous is None:
            try:
                validate_real_email(e.email)
            except HTTPException as exc:
                raise HTTPException(exc.status_code, f"{e.email}: {exc.detail}")
        row = models.PartnerEmail(email=e.email, is_active=e.is_active)
        if previous is not None and previous.problem and not e.clear_problem:
            row.problem, row.problem_at = previous.problem, previous.problem_at
        result.append(row)
    return result


def ensure_unique_partner_name(db: Session, name: str, partner_id: int | None = None) -> str:
    """The cleaned name, or 400: it must match KEY_ORG_NM in the files and be unique (ignoring case)."""
    name = " ".join(name.split())
    if not name:
        raise HTTPException(400, "Enter the partner name exactly as in the KEY_ORG_NM column.")
    for other in db.query(models.Partner).filter(models.Partner.id != (partner_id or 0)).all():
        if name_key(other.name) == name_key(name):
            raise HTTPException(400, f"A partner named \"{other.name}\" already exists.")
    return name


@api.get("/api/partners")
def list_partners(db: Session = Depends(get_db)):
    partners = db.query(models.Partner).order_by(models.Partner.name).all()
    return [partner_to_dict(p) for p in partners]


@api.post("/api/partners")
def create_partner(data: PartnerIn, db: Session = Depends(get_db), _: models.User = Depends(auth.require_admin)):
    name = ensure_unique_partner_name(db, data.name)
    partner = models.Partner(name=name, is_active=data.is_active)
    partner.emails = build_partner_emails(data.emails, [])
    db.add(partner)
    db.commit()
    return partner_to_dict(partner)


@api.put("/api/partners/{partner_id}")
def update_partner(partner_id: int, data: PartnerIn, db: Session = Depends(get_db),
                   _: models.User = Depends(auth.require_admin)):
    partner = db.get(models.Partner, partner_id)
    if not partner:
        raise HTTPException(404, "Partner not found")
    partner.name = ensure_unique_partner_name(db, data.name, partner_id)
    partner.is_active = data.is_active
    # replace the email list with what the UI sent (known problems stay with unchanged addresses)
    partner.emails = build_partner_emails(data.emails, partner.emails)
    # emails waiting to be sent go to the new addresses
    to_list = [e.email for e in partner.emails if e.is_active and not e.problem]
    if to_list:
        for d in db.query(models.EmailDispatch).filter(
            models.EmailDispatch.partner_id == partner.id,
            models.EmailDispatch.status.in_(["PREPARED", "PENDING", "FAILED"]),
        ):
            d.to_emails = ",".join(to_list)
    db.commit()
    return partner_to_dict(partner)


# ---------------------------------------------------------------- uploads

XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
ROW_KINDS = {"valid": "successful", "faulty": "skipped"}


@api.get("/api/upload-template")
def download_upload_template():
    """Sample upload file with the required columns."""
    return Response(
        build_template(),
        media_type=XLSX_TYPE,
        headers={"Content-Disposition": 'attachment; filename="dispute_transactions_template.xlsx"'},
    )


@api.post("/api/uploads")
async def upload_file(file: UploadFile = File(...), db: Session = Depends(get_db)):
    content = await file.read()
    try:
        total_rows, valid_rows, row_errors = parse_transactions(file.filename, content)
    except FileValidationError as exc:
        # whole file rejected -> nothing is saved
        raise HTTPException(400, {"message": "File rejected", "errors": exc.errors})

    upload = models.Upload(
        filename=file.filename,
        total_rows=total_rows,
        valid_rows=len(valid_rows),
        file_content=content,
    )
    upload.transactions = [models.Transaction(**row) for row in valid_rows]
    db.add(upload)
    db.commit()

    return {
        "upload_id": upload.id,
        "filename": upload.filename,
        "total_rows": upload.total_rows,
        "valid_rows": upload.valid_rows,
        "inward_rows": sum(1 for r in valid_rows if r["mail_type"] == "inward"),
        "outward_rows": sum(1 for r in valid_rows if r["mail_type"] == "outward"),
        "skipped_rows": len(row_errors),
        "row_errors": row_errors,
    }


@api.get("/api/uploads")
def list_uploads(db: Session = Depends(get_db)):
    uploads = db.query(models.Upload).order_by(models.Upload.id.desc()).limit(20).all()
    return [
        {"id": u.id, "filename": u.filename, "uploaded_at": u.uploaded_at.isoformat(),
         "total_rows": u.total_rows, "valid_rows": u.valid_rows}
        for u in uploads
    ]


@api.get("/api/uploads/{upload_id}/rows/{kind}")
def download_upload_rows(upload_id: int, kind: str, db: Session = Depends(get_db)):
    """The upload's valid or faulty rows as a new .xlsx."""
    if kind not in ROW_KINDS:
        raise HTTPException(404, "Unknown row type. Use 'valid' or 'faulty'.")
    upload = get_upload_or_404(db, upload_id)
    if upload.file_content is None:
        raise HTTPException(404, "The original file was not kept for this upload. Upload it again to download rows.")

    valid, faulty = split_rows(upload.filename, upload.file_content)
    base = re.sub(r"\.(xlsx|csv)$", "", upload.filename, flags=re.IGNORECASE)
    filename = re.sub(r'[^\w.\- ]', "_", f"{base}_{ROW_KINDS[kind]}.xlsx")
    return Response(
        to_xlsx(valid if kind == "valid" else faulty),
        media_type=XLSX_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@api.get("/api/uploads/{upload_id}")
def get_upload_groups(upload_id: int, db: Session = Depends(get_db)):
    """Transactions grouped by partner (KEY_ORG_NM) and mail type (TXN_DIRECTION): one email each."""
    upload = get_upload_or_404(db, upload_id)
    partners = partners_by_name(db)

    groups = []
    for (key, mail_type), txns in group_by_partner(upload).items():
        partner = partners.get(key)
        groups.append({
            "key": f"{key}|{mail_type}",
            "mail_type": mail_type,
            "mail_type_label": MAIL_TYPES[mail_type],
            "partner_name": partner.name if partner else txns[0].partner_name,
            "partner_configured": partner is not None,
            "txn_count": len(txns),
            "total_amount": round(sum(float(t.amount) for t in txns), 2),
            "transactions": [
                {
                    "excel_row": t.excel_row,
                    "rrn": t.rrn,
                    "approval_datetime": t.approval_datetime_text or t.txn_datetime.strftime("%d-%m-%Y %H:%M:%S"),
                    "txn_type": t.txn_type,
                    "txn_id": t.txn_id,
                    "status": t.status,
                    "amount": float(t.amount),
                    "from_account_name": t.from_account_name,
                    "to_account_type": t.to_account_type,
                    "stan": t.stan,
                    "org_code": t.org_code,
                }
                for t in txns
            ],
        })

    return {
        "upload_id": upload.id,
        "filename": upload.filename,
        "total_rows": upload.total_rows,
        "valid_rows": upload.valid_rows,
        "groups": groups,
    }


# ---------------------------------------------------------------- emails

@api.post("/api/uploads/{upload_id}/prepare-emails")
def prepare_emails(upload_id: int, db: Session = Depends(get_db)):
    """Build (or rebuild) one email per partner and mail type. Emails already SENT are never touched."""
    upload = get_upload_or_404(db, upload_id)
    partners = partners_by_name(db)

    errors = []
    notices = []  # emails prepared, but some addresses were left out
    for (key, mail_type), txns in group_by_partner(upload).items():
        partner = partners.get(key)

        # --- checks: skip this partner but continue with the others
        if partner is None:
            errors.append(f"{txns[0].partner_name} – {MAIL_TYPES[mail_type]}: no partner with this name in "
                          "Partner Configuration. No email prepared.")
            continue
        label = f"{partner.name} – {MAIL_TYPES[mail_type]}"
        if not partner.is_active:
            errors.append(f"{label}: partner is inactive. No email prepared.")
            continue
        active = [e for e in partner.emails if e.is_active]
        to_list = [e.email for e in active if not e.problem]
        problems = [f"{e.email} ({e.problem})" for e in active if e.problem]
        if not active:
            errors.append(f"{label}: no active email address configured. No email prepared.")
            continue
        if not to_list:
            errors.append(f"{label}: every active address failed before: "
                          f"{'; '.join(problems)}. No email prepared.")
            continue

        dispatch = db.query(models.EmailDispatch).filter_by(
            upload_id=upload.id, partner_id=partner.id, mail_type=mail_type
        ).first()
        if dispatch and dispatch.status != "PREPARED":
            continue  # with an admin (PENDING / FAILED) or already gone out (SENT): never rebuilt

        if dispatch is None:
            dispatch = models.EmailDispatch(upload_id=upload.id, partner_id=partner.id, mail_type=mail_type)
            db.add(dispatch)
        if not dispatch.is_edited:  # keep the user's manual edits
            dispatch.subject, dispatch.body_html = build_email(partner.name, mail_type, txns)
            dispatch.is_edited = False
        dispatch.to_emails = ",".join(to_list)
        dispatch.cc_emails = ",".join(settings.get("cc_emails"))
        dispatch.txn_count = len(txns)
        dispatch.total_amount = sum(float(t.amount) for t in txns)
        dispatch.status = "PREPARED"
        dispatch.error = None
        dispatch.delivery_issues = None
        if problems:
            notices.append(f"{label}: left out {'; '.join(problems)}.")

    db.commit()
    return {"errors": errors, "notices": notices, "emails": list_emails(upload_id, db)}


@api.get("/api/uploads/{upload_id}/emails")
def list_emails(upload_id: int, db: Session = Depends(get_db)):
    get_upload_or_404(db, upload_id)
    dispatches = db.query(models.EmailDispatch).filter_by(upload_id=upload_id).all()
    return dispatches_to_dicts(db, dispatches)


class EmailEditIn(BaseModel):
    subject: str
    body_html: str

    @field_validator("subject")
    @classmethod
    def check_subject(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Subject cannot be empty")
        if len(value) > 300:
            raise ValueError("Subject is too long (max 300 characters)")
        return value


def get_editable_dispatch_or_error(db: Session, email_id: int, user: models.User) -> models.EmailDispatch:
    """Drafts (PREPARED) can be changed by anyone; once sent for approval, only by admins."""
    dispatch = db.get(models.EmailDispatch, email_id)
    if not dispatch:
        raise HTTPException(404, "Email not found")
    if dispatch.status == "SENT":
        raise HTTPException(400, "This email has already been sent and can no longer be edited.")
    if dispatch.status == "SENDING":
        raise HTTPException(409, "This email is being sent right now and can no longer be edited.")
    if dispatch.status != "PREPARED" and user.role != "admin":
        raise HTTPException(403, "This email is waiting for an admin. Only admins can change it now.")
    return dispatch


@api.get("/api/emails/{email_id}/attachment")
def download_attachment(email_id: int, db: Session = Depends(get_db)):
    """The Excel file attached to this email: its transactions."""
    d = db.get(models.EmailDispatch, email_id)
    if not d:
        raise HTTPException(404, "Email not found")
    attached = attachment_for(d)
    if not attached:
        raise HTTPException(404, "This email has no transactions to attach.")
    name, data = attached[0]
    return Response(data, media_type=XLSX_TYPE, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@api.put("/api/emails/{email_id}")
def edit_email(email_id: int, data: EmailEditIn, db: Session = Depends(get_db),
               user: models.User = Depends(auth.get_current_user)):
    """Save a manual edit. Edited emails are kept when previews are refreshed."""
    dispatch = get_editable_dispatch_or_error(db, email_id, user)
    dispatch.subject = data.subject
    dispatch.body_html = data.body_html
    dispatch.is_edited = True
    db.commit()
    return dispatch_to_dict(dispatch)


@api.delete("/api/emails/{email_id}/edits")
def discard_email_edits(email_id: int, db: Session = Depends(get_db),
                        user: models.User = Depends(auth.get_current_user)):
    """Throw away manual edits. A draft is regenerated by the next prepare-emails call; an email
    waiting for an admin is regenerated right away (prepare-emails no longer touches it)."""
    dispatch = get_editable_dispatch_or_error(db, email_id, user)
    dispatch.is_edited = False
    if dispatch.status != "PREPARED":
        txns = dispatch_transactions(dispatch)
        if txns:
            dispatch.subject, dispatch.body_html = build_email(dispatch.partner.name, dispatch.mail_type, txns)
    db.commit()
    return dispatch_to_dict(dispatch)


@api.post("/api/uploads/{upload_id}/submit")
def submit_emails(upload_id: int, db: Session = Depends(get_db), user: models.User = Depends(auth.get_current_user)):
    """A user's "Send": every PREPARED email of this upload becomes PENDING and waits for an admin."""
    get_upload_or_404(db, upload_id)
    drafts = db.query(models.EmailDispatch).filter_by(upload_id=upload_id, status="PREPARED").all()
    if not drafts:
        raise HTTPException(400, "There are no prepared emails to send.")
    now = datetime.now()
    for d in drafts:
        d.status = "PENDING"
        d.submitted_by = user.username
        d.submitted_at = now
    db.commit()
    return {"submitted": len(drafts), "emails": list_emails(upload_id, db)}


# An admin's claim on an email: if the server dies mid-send, another admin may claim it after this long
CLAIM_EXPIRES = timedelta(minutes=10)


def pending_query(db: Session):
    """PENDING and FAILED emails, plus SENDING ones (another admin is sending them right now)."""
    return db.query(models.EmailDispatch) \
        .filter(models.EmailDispatch.status.in_(["PENDING", "FAILED", "SENDING"])) \
        .order_by(models.EmailDispatch.submitted_at, models.EmailDispatch.id)


@api.get("/api/pending-emails")
def list_pending_emails(db: Session = Depends(get_db)):
    """Emails waiting for an admin (PENDING), and ones whose sending failed (FAILED), from every upload."""
    return dispatches_to_dicts(db, pending_query(db).all())


def claim(db: Session, email_id: int, admin: models.User) -> bool:
    """Mark one email as SENDING by this admin, in a single UPDATE. When two admins send the same
    email at the same moment, the database lets only one UPDATE match, so only one of them sends it."""
    now = datetime.now()
    E = models.EmailDispatch
    result = db.execute(
        update(E)
        .where(E.id == email_id, or_(
            E.status.in_(["PENDING", "FAILED"]),
            and_(E.status == "SENDING", E.sending_since < now - CLAIM_EXPIRES),  # claim left by a crash
        ))
        .values(status="SENDING", sent_by=admin.username, sending_since=now)
        .execution_options(synchronize_session=False)
    )
    db.commit()
    return result.rowcount == 1


def deliver(db: Session, d: models.EmailDispatch, admin: models.User) -> None:
    """Send one email this admin has claimed, and record the result. Saved right away, so a crash
    never loses a "SENT"."""
    try:
        result = send_email(
            to=d.to_emails.split(","),
            cc=[c for c in d.cc_emails.split(",") if c],
            subject=d.subject,
            html_body=d.body_html,
            attachments=attachment_for(d),
        )
        d.status = "SENT"
        d.sent_at = datetime.now()
        d.sent_by = admin.username
        d.error = None
        d.attempts += result.attempts
        d.message_id = result.message_id
        for address, reason in result.refused.items():  # some recipients refused: record, don't hide
            record_refused(d, address, reason)
    except RecipientsRefused as exc:
        d.status = "FAILED"
        d.error = str(exc)
        d.attempts += 1
        for address, reason in exc.refused.items():
            record_refused(d, address, reason)
    except Exception as exc:
        d.status = "FAILED"
        d.error = str(exc)
        d.attempts += config.SMTP_MAX_ATTEMPTS
    d.sending_since = None
    db.commit()


class SendSelectedIn(BaseModel):
    ids: list[int]


@api.post("/api/pending-emails/send")
def send_selected(data: SendSelectedIn, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    """Admin sends the ticked PENDING / FAILED emails. Each one is claimed first, so an email that
    is already SENT, or being sent by another admin, is skipped: it is never sent twice."""
    if not data.ids:
        raise HTTPException(400, "Select at least one pending email to send.")
    sent, failed, skipped = 0, 0, []
    for email_id in dict.fromkeys(data.ids):  # each id once, in the order given
        d = db.get(models.EmailDispatch, email_id)
        if d is None:
            continue
        if not claim(db, email_id, admin):
            db.refresh(d)
            who = user_names(db, [d.sent_by]).get(d.sent_by, d.sent_by)
            skipped.append(f"{d.partner.name}: " + (f"already sent by {who}" if d.status == "SENT"
                                                     else f"being sent by {who}" if d.status == "SENDING"
                                                     else "not waiting to be sent"))
            continue
        db.refresh(d)
        deliver(db, d, admin)
        if d.status == "SENT":
            sent += 1
        else:
            failed += 1
    if not sent and not failed and skipped:
        raise HTTPException(409, "Nothing was sent. " + "; ".join(skipped) + ".")
    return {"sent": sent, "failed": failed, "skipped": skipped, "emails": list_pending_emails(db)}


def sent_query(db: Session, q: str, partner_id: int | None, date_from: date | None, date_to: date | None):
    """SENT emails matching the search / partner / date filters of the Sent Mails page."""
    if date_from and date_to and date_from > date_to:
        raise HTTPException(400, "The 'from' date must be on or before the 'to' date.")
    E, P, U = models.EmailDispatch, models.Partner, models.Upload
    query = db.query(E).join(P, E.partner_id == P.id).join(U, E.upload_id == U.id).filter(E.status == "SENT")
    if partner_id is not None:
        query = query.filter(E.partner_id == partner_id)
    if date_from:
        query = query.filter(E.sent_at >= datetime.combine(date_from, time.min))
    if date_to:
        query = query.filter(E.sent_at < datetime.combine(date_to + timedelta(days=1), time.min))
    for word in q.split()[:10]:
        like = f"%{word.replace('%', '').replace('_', '')}%"
        names = db.query(models.User.username).filter(models.User.full_name.ilike(like))
        query = query.filter(or_(
            P.name.ilike(like), E.subject.ilike(like),
            E.to_emails.ilike(like), E.cc_emails.ilike(like), U.filename.ilike(like),
            E.submitted_by.ilike(like), E.sent_by.ilike(like), E.remarks.ilike(like),
            E.submitted_by.in_(names), E.sent_by.in_(names),
        ))
    return query


def due_filter():
    """SQL condition for followup_due()."""
    E = models.EmailDispatch
    cutoff = datetime.now() - timedelta(days=settings.get("followup_due_days"))
    return and_(E.reply_status == "not_received", or_(
        and_(E.last_followup_at.is_(None), E.sent_at < cutoff), E.last_followup_at < cutoff))


ReplyFilter = Literal["", "not_received", "received", "reconciled", "due"]


@api.get("/api/sent-emails")
def list_sent_emails(q: str = "", partner_id: int | None = None, sort: Literal["newest", "oldest"] = "newest",
                     date_from: date | None = None, date_to: date | None = None, reply: ReplyFilter = "",
                     limit: int = 500, db: Session = Depends(get_db)):
    """Sent emails from every upload.

    q: words that must each appear in the partner name or code, subject, recipients, file name, remarks,
       or the username / name of who sent it for approval or sent it. partner_id: one partner only.
    date_from / date_to: sent on or after / on or before these days (both days included).
    reply: a reply status, or "due" (no reply and no contact for "followup_due_days").
    sort: by sent date, "newest" or "oldest" first.
    """
    limit = max(1, min(limit, 2000))
    E = models.EmailDispatch
    query = sent_query(db, q, partner_id, date_from, date_to)
    if reply == "due":
        query = query.filter(due_filter())
    elif reply:
        query = query.filter(E.reply_status == reply)
    order = (E.sent_at.asc(), E.id.asc()) if sort == "oldest" else (E.sent_at.desc(), E.id.desc())
    return dispatches_to_dicts(db, query.order_by(*order).limit(limit).all())


@api.get("/api/sent-emails/summary")
def sent_summary(q: str = "", partner_id: int | None = None, date_from: date | None = None,
                 date_to: date | None = None, db: Session = Depends(get_db)):
    """How many sent emails (with the same search / partner / date filters) are in each reply status."""
    E = models.EmailDispatch
    base = sent_query(db, q, partner_id, date_from, date_to)
    counts = {status: 0 for status in ("not_received", "received", "reconciled")}
    for status, n in base.with_entities(E.reply_status, func.count(E.id)).group_by(E.reply_status):
        counts[status] = n
    return {**counts, "due": base.filter(due_filter()).count(), "total": sum(counts.values()),
            "due_after_days": settings.get("followup_due_days")}


# ---------------------------------------------------------------- follow-up of sent emails

REPLY_STATUS_LABELS = {"not_received": "Awaiting reply", "received": "Reply received", "reconciled": "Reconciled"}
FOLLOWUP_GAP = timedelta(seconds=60)  # one follow-up per email per minute: no double clicks / two admins at once


def get_sent_or_404(db: Session, email_id: int) -> models.EmailDispatch:
    d = db.get(models.EmailDispatch, email_id)
    if not d or d.status != "SENT":
        raise HTTPException(404, "Sent email not found.")
    return d


def event_to_dict(e: models.EmailEvent, names: dict[str, str]) -> dict:
    return {
        "id": e.id, "kind": e.kind, "reply_status": e.reply_status, "note": e.note,
        "subject": e.subject, "body_html": e.body_html,
        "to": [a for a in (e.to_emails or "").split(",") if a],
        "cc": [a for a in (e.cc_emails or "").split(",") if a],
        "ok": e.ok, "error": e.error,
        "created_by": e.created_by, "created_by_name": names.get(e.created_by, e.created_by),
        "created_at": e.created_at.isoformat(),
    }


@api.get("/api/emails/{email_id}/events")
def list_email_events(email_id: int, db: Session = Depends(get_db)):
    """Follow-up history of a sent email, newest first."""
    get_sent_or_404(db, email_id)
    events = db.query(models.EmailEvent).filter_by(dispatch_id=email_id) \
        .order_by(models.EmailEvent.created_at.desc(), models.EmailEvent.id.desc()).all()
    names = user_names(db, [e.created_by for e in events])
    return [event_to_dict(e, names) for e in events]


class ReplyStatusIn(BaseModel):
    status: Literal["not_received", "received", "reconciled"]
    note: str = ""


@api.put("/api/emails/{email_id}/reply-status")
def set_reply_status(email_id: int, data: ReplyStatusIn, db: Session = Depends(get_db),
                     admin: models.User = Depends(auth.require_admin)):
    """Admin records whether the partner replied. Reconciled closes the email: no more follow-ups."""
    d = get_sent_or_404(db, email_id)
    if d.reply_status != data.status:
        d.reply_status = data.status
        d.reply_status_by = admin.username
        d.reply_status_at = datetime.now()
        db.add(models.EmailEvent(dispatch_id=d.id, kind="status", reply_status=data.status,
                                 note=data.note.strip()[:1000] or None, created_by=admin.username))
        db.commit()
    return dispatch_to_dict(d)


class NoteIn(BaseModel):
    note: str

    @field_validator("note")
    @classmethod
    def check_note(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Write a note first")
        if len(value) > 1000:
            raise ValueError("A note can have at most 1000 characters")
        return value


@api.post("/api/emails/{email_id}/notes")
def add_email_note(email_id: int, data: NoteIn, db: Session = Depends(get_db),
                   admin: models.User = Depends(auth.require_admin)):
    """Admin note on a sent email, e.g. what the partner said on the phone."""
    d = get_sent_or_404(db, email_id)
    db.add(models.EmailEvent(dispatch_id=d.id, kind="note", note=data.note, created_by=admin.username))
    db.commit()
    return {"ok": True}


class RemarksIn(BaseModel):
    remarks: str

    @field_validator("remarks")
    @classmethod
    def check_remarks(cls, value: str) -> str:
        value = value.strip()
        if len(value) > 500:
            raise ValueError("Remarks can have at most 500 characters")
        return value


@api.put("/api/emails/{email_id}/remarks")
def set_remarks(email_id: int, data: RemarksIn, db: Session = Depends(get_db),
                admin: models.User = Depends(auth.require_admin)):
    """Admin's free-text remarks on a sent email (empty clears them). Every change is kept in the history."""
    d = get_sent_or_404(db, email_id)
    if (d.remarks or "") != data.remarks:
        d.remarks = data.remarks or None
        d.remarks_by = admin.username
        d.remarks_at = datetime.now()
        db.add(models.EmailEvent(dispatch_id=d.id, kind="remarks", note=data.remarks or None,
                                 created_by=admin.username))
        db.commit()
    return dispatch_to_dict(d)


def ensure_followup_allowed(d: models.EmailDispatch) -> None:
    if d.reply_status == "reconciled":
        raise HTTPException(409, "This email is reconciled, so follow-ups are closed. "
                                 "Change its reply status first if it needs another follow-up.")


@api.get("/api/emails/{email_id}/followup-draft")
def followup_draft(email_id: int, db: Session = Depends(get_db), admin: models.User = Depends(auth.require_admin)):
    """A ready-made follow-up for the admin to edit: the original recipients, "Re:" subject and a
    reminder (no reply) or a request for missing details (reply received), with the transactions."""
    d = get_sent_or_404(db, email_id)
    ensure_followup_allowed(d)
    subject, body = build_followup(d.mail_type, d.subject, d.sent_at, d.txn_count, float(d.total_amount),
                                   d.reply_status, d.followup_count + 1)
    return {"to": d.to_emails.split(","), "cc": [c for c in d.cc_emails.split(",") if c],
            "subject": subject, "body_html": body, "number": d.followup_count + 1}


class FollowupIn(BaseModel):
    to: list[str]
    cc: list[str] = []
    subject: str
    body_html: str

    @field_validator("to", "cc")
    @classmethod
    def check_addresses(cls, value: list[str]) -> list[str]:
        cleaned = []
        for address in value:
            address = address.strip()
            if not address:
                continue
            if not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+", address):
                raise ValueError(f"'{address}' is not a valid email address")
            if address.lower() not in [a.lower() for a in cleaned]:
                cleaned.append(address)
        return cleaned

    @field_validator("subject")
    @classmethod
    def check_subject(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Subject cannot be empty")
        if len(value) > 300:
            raise ValueError("Subject is too long (max 300 characters)")
        return value


@api.post("/api/emails/{email_id}/followups")
def send_followup(email_id: int, data: FollowupIn, db: Session = Depends(get_db),
                  admin: models.User = Depends(auth.require_admin)):
    """Admin sends a follow-up for a sent email. It replies in the original email's thread.

    The email is claimed with a single UPDATE first: it fails when the email is reconciled or a
    follow-up went out less than a minute ago (a double click, or another admin at the same time).
    """
    if not data.to:
        raise HTTPException(400, "Add at least one recipient.")
    if not data.body_html.strip():
        raise HTTPException(400, "The email body is empty.")
    d = get_sent_or_404(db, email_id)
    ensure_followup_allowed(d)

    previous = d.last_followup_at
    if not claim_followup(db, d):
        ensure_followup_allowed(d)  # reconciled in the meantime
        raise HTTPException(409, "A follow-up for this email was just sent. Check its history before sending another.")
    try:
        refused = deliver_followup(db, d, previous, data.to, data.cc, data.subject, data.body_html, admin.username)
    except Exception as exc:
        raise HTTPException(502, f"The follow-up could not be sent: {exc}")
    return {"email": dispatch_to_dict(d), "refused": refused}


def claim_followup(db: Session, d: models.EmailDispatch, *conditions) -> bool:
    """Claim the email for one follow-up with a single UPDATE (sets last_followup_at to now). Fails when
    it is reconciled, a follow-up went out less than a minute ago (a double click, two admins, or the
    automatic sender at the same moment), or one of the extra conditions no longer holds."""
    E, now = models.EmailDispatch, datetime.now()
    claimed = db.execute(
        update(E).where(E.id == d.id, E.status == "SENT", E.reply_status != "reconciled",
                        or_(E.last_followup_at.is_(None), E.last_followup_at < now - FOLLOWUP_GAP), *conditions)
        .values(last_followup_at=now).execution_options(synchronize_session=False)
    ).rowcount == 1
    db.commit()
    db.refresh(d)
    return claimed


def deliver_followup(db: Session, d: models.EmailDispatch, previous: datetime | None, to: list[str], cc: list[str],
                     subject: str, body_html: str, by: str) -> list[str]:
    """Send the follow-up of an email claimed with claim_followup, in the original email's thread, and
    record it in the history. previous: last_followup_at before the claim (restored when nothing went
    out). Returns the refused recipients; raises when the email could not be sent."""
    event = models.EmailEvent(dispatch_id=d.id, kind="followup", subject=subject, body_html=body_html,
                              to_emails=",".join(to), cc_emails=",".join(cc), created_by=by)
    try:
        result = send_email(to=to, cc=cc, subject=subject, html_body=body_html,
                            in_reply_to=d.message_id, attachments=attachment_for(d))
    except Exception as exc:
        d.last_followup_at = previous  # nothing went out
        event.ok, event.error = False, str(exc)[:1000]
        db.add(event)
        db.commit()
        raise

    d.followup_count += 1
    for address, reason in result.refused.items():
        record_refused(d, address, reason)
    if result.refused:
        event.error = "Refused: " + "; ".join(f"{a} ({r})" for a, r in result.refused.items())
    db.add(event)
    db.commit()
    return list(result.refused)


# ---------------------------------------------------------------- automatic follow-ups

AUTO_RETRY_AFTER = timedelta(hours=1)  # an automatic follow-up that failed is tried again after this long
log = logging.getLogger("uvicorn.error")
_stop = threading.Event()
_run_lock = threading.Lock()           # one run at a time ("Run now" while the timer runs)
_failed_at: dict[int, datetime] = {}   # email id -> when its automatic follow-up last failed
auto_status = {"last_run_at": None, "last_result": None, "next_run_at": None}


def auto_candidates(db: Session, max_followups: int) -> list[models.EmailDispatch]:
    """Due emails that may still get an automatic follow-up (below the follow-up limit)."""
    E = models.EmailDispatch
    return db.query(E).filter(E.status == "SENT", due_filter(), E.followup_count < max_followups) \
        .order_by(E.sent_at, E.id).all()


def run_auto_followups() -> dict:
    """Send the follow-up of every due email, when automatic follow-ups are switched on."""
    with _run_lock, SessionLocal() as db:
        values = settings.current(db)
        result = {"enabled": values["auto_followup_enabled"], "sent": 0, "failed": 0, "errors": []}
        if values["auto_followup_enabled"]:
            now = datetime.now()
            for d in auto_candidates(db, values["auto_followup_max"]):
                if now - _failed_at.get(d.id, datetime.min) < AUTO_RETRY_AFTER:
                    continue
                previous = d.last_followup_at
                # claimed only while still due: an admin may have just followed up or changed the reply status
                if not claim_followup(db, d, due_filter()):
                    continue
                subject, body = build_followup(d.mail_type, d.subject, d.sent_at, d.txn_count, float(d.total_amount),
                                               d.reply_status, d.followup_count + 1)
                try:
                    deliver_followup(db, d, previous, d.to_emails.split(","),
                                     [c for c in d.cc_emails.split(",") if c], subject, body, SYSTEM_USER)
                    _failed_at.pop(d.id, None)
                    result["sent"] += 1
                except Exception as exc:
                    _failed_at[d.id] = now
                    result["failed"] += 1
                    result["errors"].append(f"{d.partner.name} (#{d.id}): {exc}"[:300])
        auto_status["last_run_at"] = datetime.now().isoformat(timespec="seconds")
        auto_status["last_result"] = result
        if result["sent"] or result["failed"]:
            log.info("Automatic follow-ups: %s sent, %s failed", result["sent"], result["failed"])
        return result


def auto_followup_loop():
    """Background thread: look for due emails every AUTO_FOLLOWUP_CHECK_SECONDS."""
    while not _stop.is_set():
        try:
            run_auto_followups()
        except Exception:
            log.exception("Automatic follow-ups failed")
        next_run = datetime.now() + timedelta(seconds=config.AUTO_FOLLOWUP_CHECK_SECONDS)
        auto_status["next_run_at"] = next_run.isoformat(timespec="seconds")
        _stop.wait(config.AUTO_FOLLOWUP_CHECK_SECONDS)


# ---------------------------------------------------------------- email configuration

EMAIL_RE = r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+"


class EmailSettingsIn(BaseModel):
    followup_due_days: int
    auto_followup_enabled: bool
    auto_followup_max: int
    cc_emails: list[str]
    reply_to: str = ""

    @field_validator("followup_due_days")
    @classmethod
    def check_days(cls, value: int) -> int:
        if not 1 <= value <= 90:
            raise ValueError("Follow-up days must be between 1 and 90")
        return value

    @field_validator("auto_followup_max")
    @classmethod
    def check_max(cls, value: int) -> int:
        if not 1 <= value <= 20:
            raise ValueError("Follow-ups per email must be between 1 and 20")
        return value

    @field_validator("cc_emails")
    @classmethod
    def check_cc(cls, value: list[str]) -> list[str]:
        cleaned = []
        for address in value:
            address = address.strip().lower()
            if not address:
                continue
            if not re.fullmatch(EMAIL_RE, address):
                raise ValueError(f"'{address}' is not a valid email address")
            if address not in cleaned:
                cleaned.append(address)
        if len(cleaned) > 20:
            raise ValueError("At most 20 CC addresses")
        return cleaned

    @field_validator("reply_to")
    @classmethod
    def check_reply_to(cls, value: str) -> str:
        value = value.strip().lower()
        if value and not re.fullmatch(EMAIL_RE, value):
            raise ValueError(f"'{value}' is not a valid email address")
        return value


def email_settings_dict(db: Session) -> dict:
    values = settings.current(db)
    change = settings.last_change(db)
    names = user_names(db, [change["by"]] if change else [])
    E = models.EmailDispatch
    return {
        **values,
        "defaults": settings.DEFAULTS,
        "updated_by_name": names.get(change["by"], change["by"]) if change else None,
        "updated_at": change["at"] if change else None,
        "due_now": db.query(E).filter(E.status == "SENT", due_filter()).count(),
        "auto_eligible_now": len(auto_candidates(db, values["auto_followup_max"])),
        "check_every_seconds": config.AUTO_FOLLOWUP_CHECK_SECONDS,
        "auto_status": auto_status,
        "smtp": {"host": config.SMTP_HOST, "port": config.SMTP_PORT, "use_tls": config.SMTP_USE_TLS,
                 "user": config.SMTP_USER, "mail_from": config.MAIL_FROM, "max_attempts": config.SMTP_MAX_ATTEMPTS},
    }


@api.get("/api/email-settings")
def get_email_settings(db: Session = Depends(get_db)):
    return email_settings_dict(db)


@api.put("/api/email-settings")
def update_email_settings(data: EmailSettingsIn, db: Session = Depends(get_db),
                          admin: models.User = Depends(auth.require_admin)):
    settings.save(db, data.model_dump(), admin.username)
    return email_settings_dict(db)


@api.post("/api/email-settings/run-followups")
def run_followups_now(db: Session = Depends(get_db), _: models.User = Depends(auth.require_admin)):
    """Look for due emails now instead of waiting for the next automatic check."""
    result = run_auto_followups()
    return {"result": result, "settings": email_settings_dict(db)}


class TestEmailIn(BaseModel):
    to: str

    @field_validator("to")
    @classmethod
    def check_to(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(EMAIL_RE, value):
            raise ValueError(f"'{value}' is not a valid email address")
        return value


@api.post("/api/email-settings/test-email")
def send_test_email(data: TestEmailIn, _: models.User = Depends(auth.require_admin)):
    """Send a short email to check the mail server settings."""
    body = ('<div style="font-family:Arial,sans-serif;font-size:14px">'
            "<p>This is a test email from NPSB Dispute Email Automation.</p>"
            f"<p>Mail server: {config.SMTP_HOST}:{config.SMTP_PORT}</p></div>")
    try:
        result = send_email(to=[data.to], cc=[], subject="NPSB Dispute Email Automation - test email", html_body=body)
    except Exception as exc:
        raise HTTPException(502, f"The test email could not be sent: {exc}")
    if result.refused:
        raise HTTPException(502, f"The mail server refused {data.to}: {'; '.join(result.refused.values())}")
    return {"ok": True, "message": f"Test email sent to {data.to}."}


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(api)
