"""Database tables."""
from datetime import date, datetime, timezone

from sqlalchemy import (
    BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, LargeBinary, Numeric, String, Text, UniqueConstraint,
)
from sqlalchemy.dialects.mysql import LONGBLOB, MEDIUMTEXT
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
    # "admin": manages users, changes partners, sends emails. "user": everything else.
    role: Mapped[str] = mapped_column(String(10), default="user")
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


class TrustedDevice(Base):
    """A browser where the user signed in with the emailed code and ticked "Keep me signed in".
    For REFRESH_TOKEN_REMEMBER_DAYS, signing in there needs only the password. The browser keeps
    the raw token in an httpOnly cookie; only its SHA-256 hash is stored here."""
    __tablename__ = "trusted_devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_agent: Mapped[str] = mapped_column(String(255), default="")
    ip_address: Mapped[str] = mapped_column(String(45), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


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
    """A Bank / MFS / PSP that receives our emails. Matched to file rows by name (KEY_ORG_NM),
    ignoring upper/lower case; names are unique."""
    __tablename__ = "partners"

    id: Mapped[int] = mapped_column(primary_key=True)
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


class EmailTemplate(Base):
    """Subject and body of the email to a partner, kept by users on the Email Templates page.
    Several per mail type; the default one is used for new emails, and users can pick another
    for each email. {{placeholders}} are filled in per partner (email_service.PLACEHOLDERS)."""
    __tablename__ = "email_templates"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    mail_type: Mapped[str] = mapped_column(String(20))       # inward / outward
    description: Mapped[str] = mapped_column(String(255), default="")  # when to use it
    subject: Mapped[str] = mapped_column(String(300))
    body_html: Mapped[str] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)  # one per mail type
    created_by: Mapped[str | None] = mapped_column(String(30), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    updated_by: Mapped[str | None] = mapped_column(String(30), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, onupdate=datetime.now)


class Upload(Base):
    """One uploaded dispute file."""
    __tablename__ = "uploads"

    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(255))
    uploaded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    total_rows: Mapped[int] = mapped_column(Integer, default=0)
    valid_rows: Mapped[int] = mapped_column(Integer, default=0)
    # The original file, kept so the valid / faulty rows can be downloaded later.
    # Deferred: only loaded when a download asks for it.
    file_content: Mapped[bytes | None] = mapped_column(
        LargeBinary().with_variant(LONGBLOB(), "mysql"), nullable=True, deferred=True)

    transactions: Mapped[list["Transaction"]] = relationship(cascade="all, delete-orphan")


class Transaction(Base):
    """A valid row from the uploaded file ("Final_Report_for_DMS_Claim" format; file column in brackets)."""
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    upload_id: Mapped[int] = mapped_column(ForeignKey("uploads.id"))
    excel_row: Mapped[int] = mapped_column(Integer)
    rrn: Mapped[str] = mapped_column(String(30))                                     # NPSB_TXN_RRN
    approval_date: Mapped[date | None] = mapped_column(Date, nullable=True)          # APPROVAL_DATE
    approval_datetime_text: Mapped[str | None] = mapped_column(String(40), nullable=True)  # APPROVAL_DATETIME as written
    txn_datetime: Mapped[datetime] = mapped_column(DateTime)                         # APPROVAL_DATETIME, read
    txn_type: Mapped[str] = mapped_column(String(80))                                # TXN_TYPE
    txn_id: Mapped[str | None] = mapped_column(String(40), nullable=True)            # TXN_ID
    status: Mapped[str] = mapped_column("nagad_status", String(40))                  # FIRST_TXN_STATUS_NAME
    amount: Mapped[float] = mapped_column(Numeric(14, 2))                            # TXN_AMOUNT
    from_account_name: Mapped[str | None] = mapped_column(String(150), nullable=True)  # FROMAC_NAME
    to_account_type: Mapped[str | None] = mapped_column(String(40), nullable=True)   # TOAC_TYPE
    stan: Mapped[str] = mapped_column(String(20))                                    # ORG_TXN_STAN
    partner_name: Mapped[str] = mapped_column("dest_partner_name", String(150))      # KEY_ORG_NM
    org_code: Mapped[str] = mapped_column("dest_institution_code", String(20))       # NPSB_ORG_CODE
    mail_type: Mapped[str | None] = mapped_column(String(20), nullable=True)         # TXN_DIRECTION: inward / outward


class EmailDispatch(Base):
    """The consolidated email for one partner and one mail type in one upload.

    The unique constraint makes sure we never create two emails
    for the same partner in the same upload (no duplicates).
    """
    __tablename__ = "email_dispatches"
    __table_args__ = (UniqueConstraint("upload_id", "partner_id", "mail_type", name="ux_dispatch_upload_partner_type"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    upload_id: Mapped[int] = mapped_column(ForeignKey("uploads.id"))
    partner_id: Mapped[int] = mapped_column(ForeignKey("partners.id"))
    mail_type: Mapped[str] = mapped_column(String(20), default="outward")  # picks the template
    to_emails: Mapped[str] = mapped_column(Text)   # comma separated
    cc_emails: Mapped[str] = mapped_column(Text)   # comma separated
    subject: Mapped[str] = mapped_column(String(300))
    body_html: Mapped[str] = mapped_column(Text)
    is_edited: Mapped[bool] = mapped_column(Boolean, default=False)  # manually edited -> keep on refresh
    # The template it is built from (None: the default template of its mail type)
    template_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    txn_count: Mapped[int] = mapped_column(Integer)
    total_amount: Mapped[float] = mapped_column(Numeric(14, 2))
    # PREPARED (user's draft) -> PENDING (waiting for an admin) -> SENDING (claimed by one admin) -> SENT / FAILED
    status: Mapped[str] = mapped_column(String(20), default="PREPARED")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # JSON list of {"email", "reason", "at"}: recipients the mail server refused
    delivery_issues: Mapped[str | None] = mapped_column(Text, nullable=True)
    submitted_by: Mapped[str | None] = mapped_column(String(30), nullable=True)  # user who sent it for approval
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    sent_by: Mapped[str | None] = mapped_column(String(30), nullable=True)       # admin who sent it
    sending_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # when an admin claimed it
    message_id: Mapped[str | None] = mapped_column(String(255), nullable=True)  # so follow-ups join its thread

    # Follow-up (sent emails; set by admins by hand)
    #   not_received: no reply yet (default) | received: partner replied | reconciled: closed, no follow-ups
    reply_status: Mapped[str] = mapped_column(String(20), default="not_received")
    reply_status_by: Mapped[str | None] = mapped_column(String(30), nullable=True)
    reply_status_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    followup_count: Mapped[int] = mapped_column(Integer, default=0)
    last_followup_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    remarks: Mapped[str | None] = mapped_column(Text, nullable=True)   # free text from an admin
    remarks_by: Mapped[str | None] = mapped_column(String(30), nullable=True)
    remarks_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    partner: Mapped[Partner] = relationship()
    upload: Mapped["Upload"] = relationship()


class EmailEvent(Base):
    """Follow-up history of one sent email: reply-status changes, follow-up emails and notes."""
    __tablename__ = "email_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    dispatch_id: Mapped[int] = mapped_column(ForeignKey("email_dispatches.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))           # status / followup / note / remarks
    reply_status: Mapped[str | None] = mapped_column(String(20), nullable=True)  # kind "status": the new status
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # kind "followup": the email as sent
    subject: Mapped[str | None] = mapped_column(String(300), nullable=True)
    body_html: Mapped[str | None] = mapped_column(Text, nullable=True)
    to_emails: Mapped[str | None] = mapped_column(Text, nullable=True)
    cc_emails: Mapped[str | None] = mapped_column(Text, nullable=True)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)  # follow-up delivered to the mail server
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # kind "followup": its Message-ID, so a reply to the follow-up is matched to this email
    message_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # kind "reply": the partner's reply (email_replies)
    reply_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by: Mapped[str] = mapped_column(String(30))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class EmailReply(Base):
    """A partner's reply to one of our emails (or follow-ups), read from the sending mailbox (inbox.py).
    Only replies to our emails are stored: other mail in the mailbox is never downloaded."""
    __tablename__ = "email_replies"

    id: Mapped[int] = mapped_column(primary_key=True)
    dispatch_id: Mapped[int] = mapped_column(ForeignKey("email_dispatches.id", ondelete="CASCADE"), index=True)
    message_id: Mapped[str] = mapped_column(String(255), unique=True)   # the reply's own Message-ID
    from_email: Mapped[str] = mapped_column(String(254))
    from_name: Mapped[str] = mapped_column(String(200), default="")
    to_emails: Mapped[str] = mapped_column(Text)                        # comma separated
    cc_emails: Mapped[str] = mapped_column(Text)
    subject: Mapped[str] = mapped_column(String(500))
    body_html: Mapped[str] = mapped_column(Text().with_variant(MEDIUMTEXT(), "mysql"))
    snippet: Mapped[str] = mapped_column(String(300), default="")       # start of the text, for the list
    matched_by: Mapped[str] = mapped_column(String(20))                 # thread (reply headers) / subject
    received_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    found_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    dispatch: Mapped[EmailDispatch] = relationship()
    attachments: Mapped[list["EmailReplyAttachment"]] = relationship(
        cascade="all, delete-orphan", order_by="EmailReplyAttachment.id")


class EmailReplyAttachment(Base):
    """A file attached to a partner's reply."""
    __tablename__ = "email_reply_attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    reply_id: Mapped[int] = mapped_column(ForeignKey("email_replies.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int] = mapped_column(Integer)
    content: Mapped[bytes] = mapped_column(LargeBinary().with_variant(LONGBLOB(), "mysql"), deferred=True)


class EmailReplyRead(Base):
    """Replies a user has opened. The others count as new (the notification count), except replies
    found before the user's account was created."""
    __tablename__ = "email_reply_reads"

    reply_id: Mapped[int] = mapped_column(ForeignKey("email_replies.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    read_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class InboxState(Base):
    """How far the mailbox has been read, so each check only looks at new messages (IMAP UIDs)."""
    __tablename__ = "inbox_state"

    mailbox: Mapped[str] = mapped_column(String(255), primary_key=True)  # user@host/folder
    uidvalidity: Mapped[int] = mapped_column(BigInteger)                  # changes when the folder is rebuilt
    last_uid: Mapped[int] = mapped_column(BigInteger, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, onupdate=datetime.now)


class AppSetting(Base):
    """One setting changed from the Email Configuration page (see settings.py). Missing rows use the .env default."""
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(50), primary_key=True)
    value: Mapped[str] = mapped_column(Text)            # JSON
    updated_by: Mapped[str | None] = mapped_column(String(30), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, onupdate=datetime.now)
