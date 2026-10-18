"""FastAPI app: all API endpoints live in this file.

Flow:
  1. POST /api/uploads                     -> upload & validate file
  2. GET  /api/uploads/{id}                -> unknown transactions grouped by partner
  3. POST /api/uploads/{id}/prepare-emails -> build one email per partner (preview)
  4. POST /api/uploads/{id}/send           -> send the prepared emails
"""
import re
from collections import defaultdict
from datetime import datetime

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from . import config, models
from .database import Base, SessionLocal, create_database_if_missing, engine, get_db
from .email_service import build_email, mask_account, send_email
from .excel_parser import FileValidationError, parse_transactions
from .seed import seed_partners

app = FastAPI(title="NPSB Dispute Email Automation")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_database_if_missing()             # create the MySQL database if needed
    Base.metadata.create_all(bind=engine)   # create tables if they don't exist
    with SessionLocal() as db:
        seed_partners(db)                    # add demo partners on first run


# ---------------------------------------------------------------- helpers

def partner_to_dict(p: models.Partner) -> dict:
    return {
        "id": p.id,
        "institution_code": p.institution_code,
        "name": p.name,
        "is_active": p.is_active,
        "emails": [{"id": e.id, "email": e.email, "is_active": e.is_active} for e in p.emails],
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
        "txn_count": d.txn_count,
        "total_amount": float(d.total_amount),
        "status": d.status,
        "attempts": d.attempts,
        "error": d.error,
        "sent_at": d.sent_at.isoformat() if d.sent_at else None,
    }


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

@app.get("/api/config")
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

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        value = value.strip()
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError(f"'{value}' is not a valid email address")
        return value


class PartnerIn(BaseModel):
    institution_code: str
    name: str
    is_active: bool = True
    emails: list[EmailIn] = []


@app.get("/api/partners")
def list_partners(db: Session = Depends(get_db)):
    partners = db.query(models.Partner).order_by(models.Partner.name).all()
    return [partner_to_dict(p) for p in partners]


@app.post("/api/partners")
def create_partner(data: PartnerIn, db: Session = Depends(get_db)):
    code = data.institution_code.strip()
    if db.query(models.Partner).filter_by(institution_code=code).first():
        raise HTTPException(400, f"A partner with institution code {code} already exists")
    partner = models.Partner(institution_code=code, name=data.name.strip(), is_active=data.is_active)
    partner.emails = [models.PartnerEmail(email=e.email, is_active=e.is_active) for e in data.emails]
    db.add(partner)
    db.commit()
    return partner_to_dict(partner)


@app.put("/api/partners/{partner_id}")
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
    # simplest approach: replace the email list with what the UI sent
    partner.emails = [models.PartnerEmail(email=e.email, is_active=e.is_active) for e in data.emails]
    db.commit()
    return partner_to_dict(partner)


# ---------------------------------------------------------------- uploads

@app.post("/api/uploads")
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


@app.get("/api/uploads")
def list_uploads(db: Session = Depends(get_db)):
    uploads = db.query(models.Upload).order_by(models.Upload.id.desc()).limit(20).all()
    return [
        {"id": u.id, "filename": u.filename, "uploaded_at": u.uploaded_at.isoformat(),
         "total_rows": u.total_rows, "unknown_rows": u.unknown_rows}
        for u in uploads
    ]


@app.get("/api/uploads/{upload_id}")
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

@app.post("/api/uploads/{upload_id}/prepare-emails")
def prepare_emails(upload_id: int, db: Session = Depends(get_db)):
    """Build (or rebuild) one email per partner. Emails already SENT are never touched."""
    upload = get_upload_or_404(db, upload_id)
    partners = {p.institution_code: p for p in db.query(models.Partner).all()}

    errors = []
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
        to_list = [e.email for e in partner.emails if e.is_active]
        if not to_list:
            errors.append(f"{partner.name} ({code}): no active email address configured. No email prepared.")
            continue

        dispatch = db.query(models.EmailDispatch).filter_by(
            upload_id=upload.id, partner_id=partner.id
        ).first()
        if dispatch and dispatch.status == "SENT":
            continue  # never rebuild an email that has already gone out

        subject, body = build_email(partner.name, txns)
        if dispatch is None:
            dispatch = models.EmailDispatch(upload_id=upload.id, partner_id=partner.id)
            db.add(dispatch)
        dispatch.to_emails = ",".join(to_list)
        dispatch.cc_emails = ",".join(config.CC_EMAILS)
        dispatch.subject = subject
        dispatch.body_html = body
        dispatch.txn_count = len(txns)
        dispatch.total_amount = sum(float(t.amount) for t in txns)
        dispatch.status = "PREPARED"
        dispatch.error = None

    db.commit()
    return {"errors": errors, "emails": list_emails(upload_id, db)}


@app.get("/api/uploads/{upload_id}/emails")
def list_emails(upload_id: int, db: Session = Depends(get_db)):
    get_upload_or_404(db, upload_id)
    dispatches = db.query(models.EmailDispatch).filter_by(upload_id=upload_id).all()
    return [dispatch_to_dict(d) for d in dispatches]


@app.post("/api/uploads/{upload_id}/send")
def send_emails(upload_id: int, db: Session = Depends(get_db)):
    """Send every email of this upload that is not SENT yet (PREPARED or FAILED).

    Because SENT emails are skipped, clicking the button twice never
    sends the same email twice.
    """
    get_upload_or_404(db, upload_id)
    pending = db.query(models.EmailDispatch).filter(
        models.EmailDispatch.upload_id == upload_id,
        models.EmailDispatch.status != "SENT",
    ).all()
    if not pending:
        raise HTTPException(400, "There are no prepared emails to send.")

    for d in pending:
        try:
            attempts = send_email(
                to=d.to_emails.split(","),
                cc=[c for c in d.cc_emails.split(",") if c],
                subject=d.subject,
                html_body=d.body_html,
            )
            d.status = "SENT"
            d.sent_at = datetime.now()
            d.error = None
            d.attempts += attempts
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
