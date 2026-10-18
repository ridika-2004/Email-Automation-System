"""Database tables."""
from datetime import datetime

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Partner(Base):
    """A destination Bank / MFS / PSP that receives NPSB transactions."""
    __tablename__ = "partners"

    id: Mapped[int] = mapped_column(primary_key=True)
    institution_code: Mapped[str] = mapped_column(String(20), unique=True)
    name: Mapped[str] = mapped_column(String(150))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    emails: Mapped[list["PartnerEmail"]] = relationship(
        back_populates="partner", cascade="all, delete-orphan"
    )


class PartnerEmail(Base):
    """One recipient address of a partner. A partner can have many."""
    __tablename__ = "partner_emails"

    id: Mapped[int] = mapped_column(primary_key=True)
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.id"))
    email: Mapped[str] = mapped_column(String(200))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    partner: Mapped[Partner] = relationship(back_populates="emails")


class Upload(Base):
    """One uploaded dispute file."""
    __tablename__ = "uploads"

    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(255))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    valid_rows: Mapped[int] = mapped_column(Integer, default=0)
    unknown_rows: Mapped[int] = mapped_column(Integer, default=0)

    transactions: Mapped[list["Transaction"]] = relationship(cascade="all, delete-orphan")


class Transaction(Base):
    """A valid row from the uploaded file."""
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    upload_id: Mapped[int] = mapped_column(ForeignKey("uploads.id"))
    excel_row: Mapped[int] = mapped_column(Integer)
    txn_datetime: Mapped[datetime] = mapped_column(DateTime)
    rrn: Mapped[str] = mapped_column(String(30))
    stan: Mapped[str] = mapped_column(String(20))
    amount: Mapped[float] = mapped_column(Numeric(14, 2))
    source_account: Mapped[str] = mapped_column(String(40))
    beneficiary_account: Mapped[str] = mapped_column(String(40))
    txn_type: Mapped[str] = mapped_column(String(50))
    response_code: Mapped[str] = mapped_column(String(10))
    nagad_status: Mapped[str] = mapped_column(String(30))
    dest_institution_code: Mapped[str] = mapped_column(String(20))
    dest_partner_name: Mapped[str] = mapped_column(String(150))
    is_unknown: Mapped[bool] = mapped_column(Boolean, default=False)


class EmailDispatch(Base):
    """The consolidated email for one partner in one upload.

    The unique constraint makes sure we never create two emails
    for the same partner in the same upload (no duplicates).
    """
    __tablename__ = "email_dispatches"
    __table_args__ = (UniqueConstraint("upload_id", "partner_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    upload_id: Mapped[int] = mapped_column(ForeignKey("uploads.id"))
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.id"))
    to_emails: Mapped[str] = mapped_column(Text)   # comma separated
    cc_emails: Mapped[str] = mapped_column(Text)   # comma separated
    subject: Mapped[str] = mapped_column(String(300))
    body_html: Mapped[str] = mapped_column(Text)
    txn_count: Mapped[int] = mapped_column(Integer)
    total_amount: Mapped[float] = mapped_column(Numeric(14, 2))
    status: Mapped[str] = mapped_column(String(20), default="PREPARED")  # PREPARED / SENT / FAILED
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    partner: Mapped[Partner] = relationship()
