"""Database tables."""
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, DateTime, ForeignKey, Integer, LargeBinary, Numeric, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.mysql import LONGBLOB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    """Auth timestamps are stored in UTC (without timezone info, as MySQL DATETIME)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------- authentication

class User(Base):
    """Someone who can sign in to the app."""
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(30), unique=True)        # stored in lowercase
    email: Mapped[str | None] = mapped_column(String(254), unique=True, nullable=True)  # lowercase
    full_name: Mapped[str] = mapped_column(String(100), default="")
    # Proven by entering the code emailed to the address; unverified accounts cannot sign in
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # New address waiting for its confirmation code (profile email change)
    pending_email: Mapped[str | None] = mapped_column(String(254), nullable=True)
    password_hash: Mapped[str] = mapped_column(String(200))               # PBKDF2, never the password
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Bumped on password change / reset / "sign out everywhere": old access tokens stop working
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class RefreshToken(Base):
    """One signed-in session (browser/device). Only a SHA-256 hash of the token is stored.

    Tokens are rotated on every refresh; `replaced_by_id` links the chain so that
    re-use of an old token (a sign of theft) can revoke the whole session family.
    """
    __tablename__ = "refresh_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    family_id: Mapped[str] = mapped_column(String(32), index=True)       # same for all rotations of a session
    remember_me: Mapped[bool] = mapped_column(Boolean, default=False)
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    ip_address: Mapped[str] = mapped_column(String(45), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    replaced_by_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    user: Mapped["User"] = relationship()


class EmailVerificationCode(Base):
    """A 6-digit code emailed to prove an address is real and belongs to the user.

    purpose "login": second step of every sign-in (after the password)
    purpose "change": confirm a new address from the profile page
    Only a SHA-256 hash of the code is stored.
    """
    __tablename__ = "email_verification_codes"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    email: Mapped[str] = mapped_column(String(254))          # the address the code was sent to
    purpose: Mapped[str] = mapped_column(String(10))
    code_hash: Mapped[str] = mapped_column(String(64))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # also set when replaced

    user: Mapped["User"] = relationship()


class PasswordResetToken(Base):
    """A one-time "forgot password" link. Only the SHA-256 hash is stored."""
    __tablename__ = "password_reset_tokens"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ip_address: Mapped[str] = mapped_column(String(45), default="")

    user: Mapped["User"] = relationship()


class AuthEvent(Base):
    """Audit log: sign-ins (successful and failed), sign-outs, password/email changes, account changes."""
    __tablename__ = "auth_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    username: Mapped[str] = mapped_column(String(254), default="")   # what was typed, for failed logins
    event: Mapped[str] = mapped_column(String(40))                    # e.g. login_success, login_failed
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    detail: Mapped[str] = mapped_column(String(255), default="")
    ip_address: Mapped[str] = mapped_column(String(45), default="")
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


# ---------------------------------------------------------------- business data


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
    # Set when the mail server refused this address; it is then left out of new emails
    # until it is changed or the problem is cleared on the Partners page.
    problem: Mapped[str | None] = mapped_column(String(255), nullable=True)
    problem_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

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
    # The original file, kept so the valid / faulty rows can be downloaded later.
    # Deferred: only loaded when a download asks for it.
    file_content: Mapped[bytes | None] = mapped_column(
        LargeBinary().with_variant(LONGBLOB(), "mysql"), nullable=True, deferred=True)

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
    is_edited: Mapped[bool] = mapped_column(Boolean, default=False)  # manually edited -> keep on refresh
    txn_count: Mapped[int] = mapped_column(Integer)
    total_amount: Mapped[float] = mapped_column(Numeric(14, 2))
    status: Mapped[str] = mapped_column(String(20), default="PREPARED")  # PREPARED / SENT / FAILED
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # JSON list of {"email", "reason", "at"}: recipients the mail server refused
    delivery_issues: Mapped[str | None] = mapped_column(Text, nullable=True)

    partner: Mapped[Partner] = relationship()
