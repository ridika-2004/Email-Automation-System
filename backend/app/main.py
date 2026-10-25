"""FastAPI app: all API endpoints live in this file.

Flow:
  1. POST /api/uploads                     -> upload & validate file
  2. GET  /api/uploads/{id}                -> unknown transactions grouped by partner
  3. POST /api/uploads/{id}/prepare-emails -> build one email per partner (preview)
  4. POST /api/uploads/{id}/send           -> send the prepared emails

Every endpoint here needs a signed-in user (JWT). Sign-in, sessions and password
recovery live in auth.py; user management (open to every user) in users.py.
"""
import json
import re
from collections import defaultdict
from datetime import datetime

from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from . import auth, config, models, users
from .database import Base, SessionLocal, create_database_if_missing, engine, get_db
from .email_check import validate_real_email
from .email_service import RecipientsRefused, build_email, mask_account, send_email
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


# Columns added after a table was first created: (table, column, SQL type + default).
# create_all() never changes existing tables, so these are added on startup when missing.
LATER_COLUMNS = [
    ("email_dispatches", "is_edited", "BOOLEAN NOT NULL DEFAULT FALSE"),
    ("uploads", "file_content", "LONGBLOB NULL"),
    ("partner_emails", "problem", "VARCHAR(255) NULL"),
    ("partner_emails", "problem_at", "DATETIME NULL"),
    ("email_dispatches", "delivery_issues", "TEXT NULL"),
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
]
# Columns that are no longer used: (table, column). Removed on startup when present.
REMOVED_COLUMNS = [
    ("users", "role"),  # there are no roles: every user can do everything
]


def add_missing_columns():
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl in LATER_COLUMNS:
            if column not in {c["name"] for c in inspector.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))
        for table, column in REMOVED_COLUMNS:
            if column in {c["name"] for c in inspector.get_columns(table)}:
                conn.execute(text(f"ALTER TABLE {table} DROP COLUMN {column}"))
        # users.email must be unique (the index is created separately so this also works on SQLite)
        has_unique_email = (
            any(ix["column_names"] == ["email"] and ix["unique"] for ix in inspector.get_indexes("users"))
            or any(uc["column_names"] == ["email"] for uc in inspector.get_unique_constraints("users"))
        )
        if not has_unique_email:
            conn.execute(text("CREATE UNIQUE INDEX ux_users_email ON users (email)"))


# ---------------------------------------------------------------- helpers

def partner_to_dict(p: models.Partner) -> dict:
    return {
        "id": p.id,
        "institution_code": p.institution_code,
        "name": p.name,
        "is_active": p.is_active,
        "emails": [{
            "id": e.id, "email": e.email, "is_active": e.is_active, "problem": e.problem,
            "problem_at": e.problem_at.isoformat() if e.problem_at else None,
        } for e in p.emails],
    }


def dispatch_to_dict(d: models.EmailDispatch) -> dict:
    return {
        "id": d.id,
        "partner_name": d.partner.name,
        "institution_code": d.partner.institution_code,
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
    }


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


def group_unknown_by_partner(upload: models.Upload) -> dict:
    """{institution_code: [unknown transactions]} for one upload."""
    grouped = defaultdict(list)
    for t in upload.transactions:
        if t.is_unknown:
            grouped[t.dest_institution_code].append(t)
    return dict(sorted(grouped.items()))


def get_upload_or_404(db: Session, upload_id: int) -> models.Upload:
    upload = db.get(models.Upload, upload_id)
    if not upload:
        raise HTTPException(404, "Upload not found")
    return upload


# ---------------------------------------------------------------- config

@api.get("/api/config")
def get_config():
    """Read-only settings shown in the UI."""
    return {
        "smtp_host": config.SMTP_HOST,
        "smtp_port": config.SMTP_PORT,
        "mail_from": config.MAIL_FROM,
        "cc_emails": config.CC_EMAILS,
        "unknown_response_codes": sorted(config.UNKNOWN_RESPONSE_CODES),
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
    institution_code: str
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


@api.get("/api/partners")
def list_partners(db: Session = Depends(get_db)):
    partners = db.query(models.Partner).order_by(models.Partner.name).all()
    return [partner_to_dict(p) for p in partners]


@api.post("/api/partners")
def create_partner(data: PartnerIn, db: Session = Depends(get_db)):
    code = data.institution_code.strip()
    if db.query(models.Partner).filter_by(institution_code=code).first():
        raise HTTPException(400, f"A partner with institution code {code} already exists")
    partner = models.Partner(institution_code=code, name=data.name.strip(), is_active=data.is_active)
    partner.emails = build_partner_emails(data.emails, [])
    db.add(partner)
    db.commit()
    return partner_to_dict(partner)


@api.put("/api/partners/{partner_id}")
def update_partner(partner_id: int, data: PartnerIn, db: Session = Depends(get_db)):
    partner = db.get(models.Partner, partner_id)
    if not partner:
        raise HTTPException(404, "Partner not found")
    code = data.institution_code.strip()
    duplicate = db.query(models.Partner).filter(
        models.Partner.institution_code == code, models.Partner.id != partner_id
    ).first()
    if duplicate:
        raise HTTPException(400, f"Institution code {code} is used by {duplicate.name}")

    partner.institution_code = code
    partner.name = data.name.strip()
    partner.is_active = data.is_active
    # replace the email list with what the UI sent (known problems stay with unchanged addresses)
    partner.emails = build_partner_emails(data.emails, partner.emails)
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
        unknown_rows=sum(1 for r in valid_rows if r["is_unknown"]),
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
        "unknown_rows": upload.unknown_rows,
        "skipped_rows": len(row_errors),
        "row_errors": row_errors,
    }


@api.get("/api/uploads")
def list_uploads(db: Session = Depends(get_db)):
    uploads = db.query(models.Upload).order_by(models.Upload.id.desc()).limit(20).all()
    return [
        {"id": u.id, "filename": u.filename, "uploaded_at": u.uploaded_at.isoformat(),
         "total_rows": u.total_rows, "unknown_rows": u.unknown_rows}
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
    """Unknown-response transactions grouped by destination partner."""
    upload = get_upload_or_404(db, upload_id)
    partners = {p.institution_code: p for p in db.query(models.Partner).all()}

    groups = []
    for code, txns in group_unknown_by_partner(upload).items():
        partner = partners.get(code)
        groups.append({
            "institution_code": code,
            "partner_name": partner.name if partner else txns[0].dest_partner_name,
            "partner_configured": partner is not None,
            "txn_count": len(txns),
            "total_amount": round(sum(float(t.amount) for t in txns), 2),
            "transactions": [
                {
                    "excel_row": t.excel_row,
                    "txn_datetime": t.txn_datetime.strftime("%d-%m-%Y %H:%M:%S"),
                    "rrn": t.rrn,
                    "stan": t.stan,
                    "amount": float(t.amount),
                    "source_account": mask_account(t.source_account),
                    "beneficiary_account": mask_account(t.beneficiary_account),
                    "txn_type": t.txn_type,
                    "response_code": t.response_code,
                    "nagad_status": t.nagad_status,
                }
                for t in txns
            ],
        })

    return {
        "upload_id": upload.id,
        "filename": upload.filename,
        "total_rows": upload.total_rows,
        "valid_rows": upload.valid_rows,
        "unknown_rows": upload.unknown_rows,
        "groups": groups,
    }


# ---------------------------------------------------------------- emails

@api.post("/api/uploads/{upload_id}/prepare-emails")
def prepare_emails(upload_id: int, db: Session = Depends(get_db)):
    """Build (or rebuild) one email per partner. Emails already SENT are never touched."""
    upload = get_upload_or_404(db, upload_id)
    partners = {p.institution_code: p for p in db.query(models.Partner).all()}

    errors = []
    notices = []  # emails prepared, but some addresses were left out
    for code, txns in group_unknown_by_partner(upload).items():
        partner = partners.get(code)
        file_name = txns[0].dest_partner_name

        # --- checks: skip this partner but continue with the others
        if partner is None:
            errors.append(f"{file_name} ({code}): partner is not configured. No email prepared.")
            continue
        if not partner.is_active:
            errors.append(f"{partner.name} ({code}): partner is inactive. No email prepared.")
            continue
        active = [e for e in partner.emails if e.is_active]
        to_list = [e.email for e in active if not e.problem]
        problems = [f"{e.email} ({e.problem})" for e in active if e.problem]
        if not active:
            errors.append(f"{partner.name} ({code}): no active email address configured. No email prepared.")
            continue
        if not to_list:
            errors.append(f"{partner.name} ({code}): every active address failed before: "
                          f"{'; '.join(problems)}. No email prepared.")
            continue

        dispatch = db.query(models.EmailDispatch).filter_by(
            upload_id=upload.id, partner_id=partner.id
        ).first()
        if dispatch and dispatch.status == "SENT":
            continue  # never rebuild an email that has already gone out

        if dispatch is None:
            dispatch = models.EmailDispatch(upload_id=upload.id, partner_id=partner.id)
            db.add(dispatch)
        if not dispatch.is_edited:  # keep the user's manual edits
            dispatch.subject, dispatch.body_html = build_email(partner.name, txns)
            dispatch.is_edited = False
        dispatch.to_emails = ",".join(to_list)
        dispatch.cc_emails = ",".join(config.CC_EMAILS)
        dispatch.txn_count = len(txns)
        dispatch.total_amount = sum(float(t.amount) for t in txns)
        dispatch.status = "PREPARED"
        dispatch.error = None
        dispatch.delivery_issues = None
        if problems:
            notices.append(f"{partner.name} ({code}): left out {'; '.join(problems)}.")

    db.commit()
    return {"errors": errors, "notices": notices, "emails": list_emails(upload_id, db)}


@api.get("/api/uploads/{upload_id}/emails")
def list_emails(upload_id: int, db: Session = Depends(get_db)):
    get_upload_or_404(db, upload_id)
    dispatches = db.query(models.EmailDispatch).filter_by(upload_id=upload_id).all()
    return [dispatch_to_dict(d) for d in dispatches]


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


def get_unsent_dispatch_or_error(db: Session, email_id: int) -> models.EmailDispatch:
    dispatch = db.get(models.EmailDispatch, email_id)
    if not dispatch:
        raise HTTPException(404, "Email not found")
    if dispatch.status == "SENT":
        raise HTTPException(400, "This email has already been sent and can no longer be edited.")
    return dispatch


@api.put("/api/emails/{email_id}")
def edit_email(email_id: int, data: EmailEditIn, db: Session = Depends(get_db)):
    """Save a manual edit. Edited emails are kept when previews are refreshed."""
    dispatch = get_unsent_dispatch_or_error(db, email_id)
    dispatch.subject = data.subject
    dispatch.body_html = data.body_html
    dispatch.is_edited = True
    db.commit()
    return dispatch_to_dict(dispatch)


@api.delete("/api/emails/{email_id}/edits")
def discard_email_edits(email_id: int, db: Session = Depends(get_db)):
    """Throw away manual edits; the next prepare-emails call regenerates the email."""
    dispatch = get_unsent_dispatch_or_error(db, email_id)
    dispatch.is_edited = False
    db.commit()
    return dispatch_to_dict(dispatch)


@api.post("/api/uploads/{upload_id}/send")
def send_emails(upload_id: int, db: Session = Depends(get_db)):
    """Send every email of this upload that is not SENT yet (PREPARED or FAILED).

    Because SENT emails are skipped, clicking the button twice never
    sends the same email twice.
    """
    get_upload_or_404(db, upload_id)
    pending = db.query(models.EmailDispatch).filter(
        models.EmailDispatch.upload_id == upload_id,
        models.EmailDispatch.status.in_(["PREPARED", "FAILED"]),
    ).all()
    if not pending:
        raise HTTPException(400, "There are no prepared emails to send.")

    for d in pending:
        try:
            result = send_email(
                to=d.to_emails.split(","),
                cc=[c for c in d.cc_emails.split(",") if c],
                subject=d.subject,
                html_body=d.body_html,
            )
            d.status = "SENT"
            d.sent_at = datetime.now()
            d.error = None
            d.attempts += result.attempts
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
        db.commit()  # save after each email, so a crash never loses a "SENT" status

    sent = sum(1 for d in pending if d.status == "SENT")
    return {
        "sent": sent,
        "failed": len(pending) - sent,
        "emails": list_emails(upload_id, db),
    }


app.include_router(auth.router)
app.include_router(users.router)
app.include_router(api)
