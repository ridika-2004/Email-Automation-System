"""Authentication: accounts, sign-in, sessions and password recovery.

How sign-in works
  * Two steps, every time: POST /api/auth/login checks the password and emails a 6-digit
    code; POST /api/auth/verify-code checks the code and returns a short-lived JWT access token
    (15 min). Registering works the same way: the account is used for the first time by
    entering the emailed code. The frontend keeps it in memory and sends "Authorization: Bearer <token>".
  * It also sets a long-lived refresh token in an httpOnly cookie (JavaScript cannot read
    it). When the access token expires, POST /api/auth/refresh exchanges the cookie for a
    new access token. Refresh tokens are rotated on every use; re-using an old one revokes
    the whole session (it was probably stolen).
  * Each refresh-token chain is one "session" (browser/device) that the user can see and
    sign out of. Changing or resetting the password signs out every session.

Real email addresses only
  * The domain must be able to receive mail (email_check.py).
  * Every sign-in needs the code emailed to the account's address, so only someone who can
    read that inbox gets in. Changing the email in the profile needs a code sent to the new address.

There are no roles: every signed-in user can use every feature, including managing users.

Protection
  * Passwords: PBKDF2-SHA256 (600k iterations, random salt) + strength rules.
  * Too many wrong passwords lock the account for a while; requests per IP are rate limited.
  * Refresh and reset tokens are stored only as SHA-256 hashes.
  * Every sign-in, failure, sign-out and password change is written to auth_events.
"""
import hashlib
import hmac
import re
import secrets
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from html import escape

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from . import config, models
from .database import get_db
from .email_check import validate_real_email
from .models import utcnow

router = APIRouter(prefix="/api/auth", tags=["auth"])
bearer = HTTPBearer(auto_error=False)

JWT_ALGORITHM = "HS256"
PBKDF2_ITERATIONS = 600_000
REFRESH_COOKIE = "npsb_refresh"
REFRESH_COOKIE_PATH = "/api/auth"
REFRESH_REUSE_GRACE_SECONDS = 30  # two tabs refreshing at the same moment is not theft

USERNAME_RE = re.compile(r"[a-z0-9._-]{3,30}")
EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
COMMON_PASSWORDS = {
    "password", "password1", "password123", "12345678", "123456789", "1234567890",
    "qwerty123", "qwertyuiop", "11111111", "iloveyou", "admin123", "welcome1",
    "letmein1", "abc12345", "p@ssw0rd", "passw0rd",
}


# ================================================================ helpers

def hash_password(password: str) -> str:
    """Stored as  pbkdf2_sha256$iterations$salt$hash."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt, expected = stored.split("$")
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations))
    return hmac.compare_digest(digest.hex(), expected)


# Checked when the account does not exist, so a wrong username takes as long as a wrong password
_DUMMY_HASH = hash_password(secrets.token_hex(16))


def password_problems(password: str, username: str = "", email: str = "") -> list[str]:
    """Strength rules. The frontend shows the same rules live while typing."""
    problems = []
    if len(password) < 8:
        problems.append("at least 8 characters")
    if len(password) > 128:
        problems.append("at most 128 characters")
    if not re.search(r"[a-z]", password):
        problems.append("a lowercase letter")
    if not re.search(r"[A-Z]", password):
        problems.append("an uppercase letter")
    if not re.search(r"\d", password):
        problems.append("a number")
    if not re.search(r"[^A-Za-z0-9]", password):
        problems.append("a symbol")
    lowered = password.lower()
    if username and len(username) >= 3 and username.lower() in lowered:
        problems.append("must not contain the username")
    local_part = email.split("@")[0].lower() if email else ""
    if len(local_part) >= 3 and local_part in lowered:
        problems.append("must not contain the email address")
    if lowered in COMMON_PASSWORDS:
        problems.append("must not be a common password")
    return problems


def check_password_strength(password: str, username: str = "", email: str = ""):
    problems = password_problems(password, username, email)
    if problems:
        raise HTTPException(400, "Password is too weak: " + ", ".join(problems) + ".")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def client_ip(request: Request) -> str:
    return (request.client.host if request.client else "")[:45]


def client_agent(request: Request) -> str:
    return request.headers.get("user-agent", "")[:255]


def log_event(db: Session, request: Request, event: str, *, user: models.User | None = None,
              username: str = "", success: bool = True, detail: str = "") -> None:
    db.add(models.AuthEvent(
        user_id=user.id if user else None,
        username=(user.username if user else username)[:254],
        event=event, success=success, detail=detail[:255],
        ip_address=client_ip(request), user_agent=client_agent(request),
    ))


def user_to_dict(user: models.User) -> dict:
    iso = lambda d: d.replace(tzinfo=timezone.utc).isoformat() if d else None  # noqa: E731
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "full_name": user.full_name,
        "email_verified": user.email_verified,
        "pending_email": user.pending_email,
        "is_active": user.is_active,
        "is_locked": bool(user.locked_until and user.locked_until > utcnow()),
        "locked_until": iso(user.locked_until) if user.locked_until and user.locked_until > utcnow() else None,
        "last_login_at": iso(user.last_login_at),
        "password_changed_at": iso(user.password_changed_at),
        "created_at": iso(user.created_at),
    }


# ---------------------------------------------------------------- rate limiting

class RateLimiter:
    """At most `limit` requests per `window` seconds for one key (in memory, per server process)."""

    def __init__(self, limit: int, window: int = 60):
        self.limit, self.window = limit, window
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, key: str) -> None:
        now = time.monotonic()
        with self.lock:
            hits = self.hits[key]
            while hits and hits[0] <= now - self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                retry = int(self.window - (now - hits[0])) + 1
                raise HTTPException(429, f"Too many attempts. Please wait {retry} seconds and try again.",
                                    headers={"Retry-After": str(retry)})
            hits.append(now)


login_limiter = RateLimiter(config.LOGIN_RATE_LIMIT_PER_MINUTE)
register_limiter = RateLimiter(5)
forgot_limiter = RateLimiter(5)
verify_limiter = RateLimiter(10)
MAX_LOGIN_CODES = 5  # codes per sign-in within VERIFICATION_CODE_MINUTES, counting resends
resend_limiter = RateLimiter(5)


# ---------------------------------------------------------------- tokens

def create_access_token(user: models.User) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user.id),
        "username": user.username,
        "ver": user.token_version,
        "type": "access",
        "iss": config.JWT_ISSUER,
        "iat": now,
        "exp": now + timedelta(minutes=config.ACCESS_TOKEN_MINUTES),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=JWT_ALGORITHM)


def start_session(db: Session, request: Request, response: Response, user: models.User,
                  remember_me: bool, family_id: str | None = None) -> models.RefreshToken:
    """Create a refresh token, store its hash, and put the raw token in the httpOnly cookie."""
    raw = secrets.token_urlsafe(48)
    days = config.REFRESH_TOKEN_REMEMBER_DAYS if remember_me else config.REFRESH_TOKEN_DAYS
    token = models.RefreshToken(
        user_id=user.id,
        token_hash=hash_token(raw),
        family_id=family_id or secrets.token_hex(16),
        remember_me=remember_me,
        user_agent=client_agent(request),
        ip_address=client_ip(request),
        expires_at=utcnow() + timedelta(days=days),
    )
    db.add(token)
    db.flush()
    response.set_cookie(
        REFRESH_COOKIE, raw,
        max_age=days * 86400 if remember_me else None,  # without "remember me": gone when the browser closes
        httponly=True, secure=config.COOKIE_SECURE, samesite="strict", path=REFRESH_COOKIE_PATH,
    )
    return token


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path=REFRESH_COOKIE_PATH,
                           httponly=True, secure=config.COOKIE_SECURE, samesite="strict")


def revoke_all_sessions(db: Session, user: models.User, except_family: str | None = None) -> None:
    query = db.query(models.RefreshToken).filter(
        models.RefreshToken.user_id == user.id, models.RefreshToken.revoked_at.is_(None)
    )
    if except_family:
        query = query.filter(models.RefreshToken.family_id != except_family)
    query.update({models.RefreshToken.revoked_at: utcnow()}, synchronize_session=False)


def current_refresh_token(db: Session, request: Request) -> models.RefreshToken | None:
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        return None
    return db.query(models.RefreshToken).filter_by(token_hash=hash_token(raw)).first()


def token_response(user: models.User) -> dict:
    return {
        "access_token": create_access_token(user),
        "token_type": "bearer",
        "expires_in": config.ACCESS_TOKEN_MINUTES * 60,
        "user": user_to_dict(user),
    }


# ---------------------------------------------------------------- dependencies

def _unauthorized(message: str) -> HTTPException:
    return HTTPException(401, message, headers={"WWW-Authenticate": "Bearer"})


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> models.User:
    """The signed-in user, or 401. Used by every protected endpoint."""
    if credentials is None:
        raise _unauthorized("Please sign in.")
    try:
        payload = jwt.decode(credentials.credentials, config.JWT_SECRET, algorithms=[JWT_ALGORITHM],
                             issuer=config.JWT_ISSUER, options={"require": ["exp", "sub", "ver"]})
    except jwt.ExpiredSignatureError:
        raise _unauthorized("Your session has expired. Please sign in again.")
    except jwt.InvalidTokenError:
        raise _unauthorized("Invalid session. Please sign in again.")
    if payload.get("type") != "access":
        raise _unauthorized("Invalid session. Please sign in again.")
    user = db.get(models.User, int(payload["sub"]))
    if user is None or not user.is_active or payload["ver"] != user.token_version:
        raise _unauthorized("Your session has ended. Please sign in again.")
    return user


# ---------------------------------------------------------------- email verification codes

def latest_code(db: Session, user: models.User, purpose: str, email: str) -> models.EmailVerificationCode | None:
    return db.query(models.EmailVerificationCode).filter_by(
        user_id=user.id, purpose=purpose, email=email, used_at=None
    ).order_by(models.EmailVerificationCode.id.desc()).first()


def code_hash(user: models.User, purpose: str, code: str) -> str:
    return hash_token(f"{user.id}:{purpose}:{code}")


def send_verification_code(db: Session, user: models.User, email: str, purpose: str,
                           respect_cooldown: bool = True) -> bool:
    """Email a fresh 6-digit code (older codes stop working). Returns False if one was sent
    less than VERIFICATION_RESEND_SECONDS ago. Raises 502 if the email cannot be sent."""
    previous = latest_code(db, user, purpose, email)
    if respect_cooldown and previous and \
            (utcnow() - previous.created_at).total_seconds() < config.VERIFICATION_RESEND_SECONDS:
        return False
    db.query(models.EmailVerificationCode).filter_by(user_id=user.id, purpose=purpose, used_at=None) \
        .update({models.EmailVerificationCode.used_at: utcnow()}, synchronize_session=False)
    code = f"{secrets.randbelow(10**6):06d}"
    db.add(models.EmailVerificationCode(
        user_id=user.id, email=email, purpose=purpose, code_hash=code_hash(user, purpose, code),
        expires_at=utcnow() + timedelta(minutes=config.VERIFICATION_CODE_MINUTES),
    ))
    db.flush()
    try:
        deliver_code_email(email, user.full_name or user.username, code, purpose)
    except Exception as exc:
        raise HTTPException(502, f"We could not send a verification email to {email}. Check that the "
                                 f"address is correct and try again. ({exc})")
    return True


def deliver_code_email(email: str, name: str, code: str, purpose: str) -> None:
    from .email_service import send_email  # avoid a circular import at startup

    action = "confirm your new email address" if purpose == "change" else "sign in"
    body = f"""
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2430;max-width:520px">
      <p>Hello {escape(name)},</p>
      <p>Use this code to {action} for NPSB Dispute Email Automation:</p>
      <p style="font-size:30px;font-weight:700;letter-spacing:8px;margin:20px 0;color:#e8222d">{code}</p>
      <p>The code is valid for {config.VERIFICATION_CODE_MINUTES} minutes. If you did not request it,
         you can ignore this email.</p>
    </div>"""
    subject = "Your sign-in code" if purpose == "login" else "Your verification code"
    send_email(to=[email], cc=[], subject=f"{subject}: {code}", html_body=body)


def check_code(db: Session, user: models.User, purpose: str, email: str, code: str) -> None:
    """Raise 400 unless `code` is the current, unexpired code for this address."""
    record = latest_code(db, user, purpose, email)
    expired = HTTPException(400, "This code has expired or was replaced. Request a new code.")
    if record is None or record.expires_at <= utcnow() or record.attempts >= config.VERIFICATION_MAX_ATTEMPTS:
        raise expired
    if not hmac.compare_digest(record.code_hash, code_hash(user, purpose, code.strip())):
        record.attempts += 1
        left = config.VERIFICATION_MAX_ATTEMPTS - record.attempts
        db.commit()
        if left <= 0:
            raise HTTPException(400, "Too many wrong codes. Request a new code.")
        raise HTTPException(400, f"Incorrect code. {left} attempt(s) left.")
    record.used_at = utcnow()


def send_login_code(db: Session, request: Request, user: models.User) -> dict:
    """Password OK (or account just created): email the code and tell the page to ask for it."""
    sent = send_verification_code(db, user, user.email, "login")
    log_event(db, request, "login_code_sent", user=user, detail="" if sent else "recent code still valid")
    note = "We've sent a 6-digit code to" if sent else "Enter the 6-digit code we sent to"
    return {
        "otp_required": True,
        "login": user.username,
        "email": user.email,
        "message": f"{note} {user.email}.",
    }


def find_user(db: Session, login: str) -> models.User | None:
    field = models.User.email if "@" in login else models.User.username
    return db.query(models.User).filter(field == login).first()


# ================================================================ request bodies

def clean_full_name(v: str) -> str:
    v = " ".join(v.split())
    if not 2 <= len(v) <= 100:
        raise ValueError("Full name must be 2-100 characters")
    return v


def clean_username(v: str) -> str:
    v = v.strip().lower()
    if not USERNAME_RE.fullmatch(v):
        raise ValueError("Username must be 3-30 characters: letters, numbers, dot, dash or underscore")
    return v


def clean_email(v: str) -> str:
    v = v.strip().lower()
    if len(v) > 254 or not EMAIL_RE.fullmatch(v):
        raise ValueError("Enter a valid email address")
    return v


class RegisterIn(BaseModel):
    full_name: str
    username: str
    email: str
    password: str

    _name = field_validator("full_name")(lambda cls, v: clean_full_name(v))
    _username = field_validator("username")(lambda cls, v: clean_username(v))
    _email = field_validator("email")(lambda cls, v: clean_email(v))


class LoginIn(BaseModel):
    login: str            # username or email
    password: str
    remember_me: bool = False

    @field_validator("login")
    @classmethod
    def normalize(cls, v: str) -> str:
        return v.strip().lower()


class ProfileIn(BaseModel):
    full_name: str
    email: str

    _name = field_validator("full_name")(lambda cls, v: clean_full_name(v))
    _email = field_validator("email")(lambda cls, v: clean_email(v))


class VerifyCodeIn(BaseModel):
    login: str            # username or email
    code: str
    remember_me: bool = False

    @field_validator("login")
    @classmethod
    def normalize(cls, v: str) -> str:
        return v.strip().lower()


class ResendIn(BaseModel):
    login: str

    @field_validator("login")
    @classmethod
    def normalize(cls, v: str) -> str:
        return v.strip().lower()


class CodeIn(BaseModel):
    code: str


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str


class ForgotPasswordIn(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def normalize(cls, v: str) -> str:
        return v.strip().lower()


class ResetPasswordIn(BaseModel):
    token: str
    new_password: str


# ================================================================ endpoints

def registration_open(db: Session) -> bool:
    """The first account can always be created; after that it depends on ALLOW_REGISTRATION."""
    return config.ALLOW_REGISTRATION or db.query(models.User).count() == 0


@router.get("/settings")
def auth_settings(db: Session = Depends(get_db)):
    return {
        "allow_registration": registration_open(db),
        "first_user": db.query(models.User).count() == 0,
        "remember_me_days": config.REFRESH_TOKEN_REMEMBER_DAYS,
    }


@router.post("/register", status_code=201)
def register(data: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)):
    register_limiter.check(client_ip(request))
    if not registration_open(db):
        raise HTTPException(403, "Registration is closed. Ask an existing user to create an account for you.")
    check_password_strength(data.password, data.username, data.email)
    if db.query(models.User).filter_by(username=data.username).first():
        raise HTTPException(409, "This username is already taken.")
    if db.query(models.User).filter_by(email=data.email).first():
        raise HTTPException(409, "An account with this email already exists.")
    validate_real_email(data.email)

    user = models.User(
        username=data.username, email=data.email, full_name=data.full_name,
        password_hash=hash_password(data.password), password_changed_at=utcnow(),
    )
    db.add(user)
    db.flush()
    log_event(db, request, "register", user=user)
    try:
        answer = send_login_code(db, request, user)
    except HTTPException:
        db.rollback()  # the email could not be delivered: do not keep the account
        raise
    db.commit()
    return {**answer, "message": f"Account created. We've sent a 6-digit code to {user.email}."}


@router.post("/verify-code")
def verify_code(data: VerifyCodeIn, request: Request, response: Response, db: Session = Depends(get_db)):
    """Step 2 of sign-in: the emailed code is correct -> the user is signed in."""
    verify_limiter.check(client_ip(request))
    user = find_user(db, data.login)
    if user is None or not user.email:
        raise HTTPException(400, "This code has expired or was replaced. Request a new code.")
    if not user.is_active:
        raise HTTPException(403, "This account has been disabled.")
    try:
        check_code(db, user, "login", user.email, data.code)
    except HTTPException as exc:
        log_event(db, request, "login_code_failed", user=user, success=False, detail=str(exc.detail))
        db.commit()
        raise

    if not user.email_verified:  # the code reached this inbox, so the address is real
        user.email_verified = True
        user.email_verified_at = utcnow()
    user.last_login_at = utcnow()
    user.failed_login_count = 0
    user.locked_until = None
    start_session(db, request, response, user, data.remember_me)
    log_event(db, request, "login_success", user=user, detail="remember me" if data.remember_me else "")
    db.commit()
    return token_response(user)


@router.post("/resend-code")
def resend_code(data: ResendIn, request: Request, db: Session = Depends(get_db)):
    """A new sign-in code. Only works while a sign-in is in progress (password already entered)."""
    resend_limiter.check(client_ip(request))
    user = find_user(db, data.login)
    start_over = HTTPException(400, "Your sign-in has expired. Please sign in again.")
    if user is None or not user.email or not user.is_active:
        raise start_over
    window_start = utcnow() - timedelta(minutes=config.VERIFICATION_CODE_MINUTES)
    recent = db.query(models.EmailVerificationCode).filter(
        models.EmailVerificationCode.user_id == user.id,
        models.EmailVerificationCode.purpose == "login",
        models.EmailVerificationCode.created_at > window_start,
    ).count()
    if recent == 0:
        raise start_over
    if recent >= MAX_LOGIN_CODES:
        raise HTTPException(429, "Too many codes requested. Please wait a few minutes and sign in again.")
    if not send_verification_code(db, user, user.email, "login"):
        raise HTTPException(429, f"Please wait {config.VERIFICATION_RESEND_SECONDS} seconds before asking for another code.")
    log_event(db, request, "login_code_sent", user=user, detail="resent")
    db.commit()
    return {"message": f"A new code has been sent to {user.email}.",
            "resend_after": config.VERIFICATION_RESEND_SECONDS}


@router.post("/login")
def login(data: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)):
    login_limiter.check(client_ip(request))
    user = find_user(db, data.login)
    invalid = HTTPException(401, "Invalid username/email or password.")

    if user is None:
        verify_password(data.password, _DUMMY_HASH)
        log_event(db, request, "login_failed", username=data.login, success=False, detail="unknown account")
        db.commit()
        raise invalid

    now = utcnow()
    if user.locked_until and user.locked_until > now:
        minutes = int((user.locked_until - now).total_seconds() // 60) + 1
        log_event(db, request, "login_blocked", user=user, success=False, detail="account locked")
        db.commit()
        raise HTTPException(423, f"Too many failed attempts. This account is locked for {minutes} more minute(s).")

    if not verify_password(data.password, user.password_hash):
        user.failed_login_count += 1
        detail = f"wrong password ({user.failed_login_count}/{config.MAX_FAILED_LOGINS})"
        if user.failed_login_count >= config.MAX_FAILED_LOGINS:
            user.locked_until = now + timedelta(minutes=config.LOCKOUT_MINUTES)
            user.failed_login_count = 0
            detail = "wrong password, account locked"
        log_event(db, request, "login_failed", user=user, success=False, detail=detail)
        db.commit()
        if user.locked_until and user.locked_until > now:
            raise HTTPException(423, f"Too many failed attempts. This account is locked for "
                                     f"{config.LOCKOUT_MINUTES} minutes.")
        left = config.MAX_FAILED_LOGINS - user.failed_login_count
        raise HTTPException(401, f"Invalid username/email or password. {left} attempt(s) left before "
                                 f"the account is locked." if left <= 2 else invalid.detail)

    if not user.is_active:
        log_event(db, request, "login_blocked", user=user, success=False, detail="account disabled")
        db.commit()
        raise HTTPException(403, "This account has been disabled. Contact your system administrator.")

    # Password is right. Step 2: a code emailed to the account's address.
    user.failed_login_count = 0
    if not user.email:
        db.commit()
        raise HTTPException(403, "This account has no email address, so a sign-in code cannot be sent. "
                                 "Ask another user to add one.")
    try:
        validate_real_email(user.email)
    except HTTPException as exc:
        if exc.status_code == 400:
            db.commit()
            raise HTTPException(403, f"The email on this account ({user.email}) cannot receive mail, so a "
                                     "sign-in code cannot be sent. Ask another user to correct it.")
        raise
    answer = send_login_code(db, request, user)
    db.commit()
    return answer


@router.post("/refresh")
def refresh(request: Request, response: Response, db: Session = Depends(get_db)):
    """Exchange the refresh cookie for a new access token (and a new, rotated refresh cookie)."""
    token = current_refresh_token(db, request)
    if token is None:
        clear_refresh_cookie(response)
        raise _unauthorized("Please sign in.")
    now = utcnow()
    user = token.user

    if token.revoked_at is not None:
        if token.replaced_by_id and (now - token.revoked_at).total_seconds() <= REFRESH_REUSE_GRACE_SECONDS:
            # Another tab refreshed a moment ago and the browser already has the new cookie
            if user.is_active:
                return token_response(user)
        if token.replaced_by_id:
            # An old, already-rotated token was used again: treat the session as stolen
            db.query(models.RefreshToken).filter_by(family_id=token.family_id, revoked_at=None) \
                .update({models.RefreshToken.revoked_at: now}, synchronize_session=False)
            log_event(db, request, "refresh_reuse", user=user, success=False,
                      detail="old refresh token re-used; session revoked")
            db.commit()
        clear_refresh_cookie(response)
        raise _unauthorized("Your session has ended. Please sign in again.")

    if token.expires_at <= now or not user.is_active:
        token.revoked_at = now
        db.commit()
        clear_refresh_cookie(response)
        raise _unauthorized("Your session has expired. Please sign in again.")

    new_token = start_session(db, request, response, user, token.remember_me, family_id=token.family_id)
    new_token.created_at = token.created_at          # the session started when the user signed in
    token.revoked_at = now
    token.replaced_by_id = new_token.id
    db.commit()
    return token_response(user)


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    token = current_refresh_token(db, request)
    if token is not None:
        db.query(models.RefreshToken).filter_by(family_id=token.family_id, revoked_at=None) \
            .update({models.RefreshToken.revoked_at: utcnow()}, synchronize_session=False)
        log_event(db, request, "logout", user=token.user)
        db.commit()
    clear_refresh_cookie(response)
    return {"message": "Signed out."}


@router.post("/logout-all")
def logout_all(request: Request, response: Response, user: models.User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    """Sign out on every device; existing access tokens stop working immediately."""
    revoke_all_sessions(db, user)
    user.token_version += 1
    log_event(db, request, "logout_all", user=user)
    db.commit()
    clear_refresh_cookie(response)
    return {"message": "Signed out on all devices."}


@router.get("/me")
def me(user: models.User = Depends(get_current_user)):
    return user_to_dict(user)


@router.put("/me")
def update_profile(data: ProfileIn, request: Request, user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    """Name changes apply at once. A new email only replaces the old one after its code is entered."""
    if data.full_name != user.full_name:
        user.full_name = data.full_name
        log_event(db, request, "profile_updated", user=user, detail="changed name")

    message = "Profile saved."
    if data.email != user.email and data.email != user.pending_email:
        taken = db.query(models.User).filter(models.User.email == data.email, models.User.id != user.id).first()
        if taken:
            raise HTTPException(409, "Another account already uses this email.")
        validate_real_email(data.email)
        user.pending_email = data.email
        send_verification_code(db, user, data.email, "change", respect_cooldown=False)
        log_event(db, request, "email_change_requested", user=user, detail=data.email)
        message = f"We've sent a 6-digit code to {data.email}. Enter it to confirm the new address."
    elif data.email == user.email and user.pending_email:
        user.pending_email = None  # typed the old address back: cancel the change
    db.commit()
    return {**user_to_dict(user), "message": message}


@router.post("/me/confirm-email")
def confirm_email_change(data: CodeIn, request: Request, user: models.User = Depends(get_current_user),
                         db: Session = Depends(get_db)):
    if not user.pending_email:
        raise HTTPException(400, "There is no email change waiting for confirmation.")
    check_code(db, user, "change", user.pending_email, data.code)
    if db.query(models.User).filter(models.User.email == user.pending_email, models.User.id != user.id).first():
        raise HTTPException(409, "Another account started using this email in the meantime.")
    old = user.email
    user.email = user.pending_email
    user.pending_email = None
    user.email_verified = True
    user.email_verified_at = utcnow()
    log_event(db, request, "email_changed", user=user, detail=f"{old} -> {user.email}")
    db.commit()
    return {**user_to_dict(user), "message": "Your email address has been changed."}


@router.post("/me/resend-email-code")
def resend_email_change_code(request: Request, user: models.User = Depends(get_current_user),
                             db: Session = Depends(get_db)):
    if not user.pending_email:
        raise HTTPException(400, "There is no email change waiting for confirmation.")
    if not send_verification_code(db, user, user.pending_email, "change"):
        raise HTTPException(429, f"Please wait {config.VERIFICATION_RESEND_SECONDS} seconds before asking for another code.")
    db.commit()
    return {"message": f"A new code has been sent to {user.pending_email}."}


@router.delete("/me/pending-email")
def cancel_email_change(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    user.pending_email = None
    db.query(models.EmailVerificationCode).filter_by(user_id=user.id, purpose="change", used_at=None) \
        .update({models.EmailVerificationCode.used_at: utcnow()}, synchronize_session=False)
    db.commit()
    return user_to_dict(user)


@router.post("/change-password")
def change_password(data: ChangePasswordIn, request: Request, response: Response,
                    user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    if not verify_password(data.current_password, user.password_hash):
        log_event(db, request, "password_change_failed", user=user, success=False, detail="wrong current password")
        db.commit()
        raise HTTPException(400, "Current password is incorrect.")
    if data.new_password == data.current_password:
        raise HTTPException(400, "The new password must be different from the current one.")
    check_password_strength(data.new_password, user.username, user.email or "")

    current = current_refresh_token(db, request)
    remember = bool(current and current.remember_me)
    user.password_hash = hash_password(data.new_password)
    user.password_changed_at = utcnow()
    user.token_version += 1                      # old access tokens everywhere stop working
    revoke_all_sessions(db, user)                # sign out other devices...
    start_session(db, request, response, user, remember)  # ...but keep this one signed in
    log_event(db, request, "password_changed", user=user, detail="other sessions signed out")
    db.commit()
    return token_response(user)


@router.post("/forgot-password")
def forgot_password(data: ForgotPasswordIn, request: Request, background: BackgroundTasks,
                    db: Session = Depends(get_db)):
    """Always gives the same answer, so nobody can find out which emails have an account."""
    forgot_limiter.check(client_ip(request))
    answer = {"message": "If an account exists for that email, a password reset link has been sent. "
                         f"The link is valid for {config.PASSWORD_RESET_MINUTES} minutes."}
    user = db.query(models.User).filter_by(email=data.email).first()
    if user is None or not user.is_active:
        log_event(db, request, "password_reset_requested", username=data.email, success=False,
                  detail="no active account")
        db.commit()
        return answer

    # Only the newest link works
    db.query(models.PasswordResetToken).filter_by(user_id=user.id, used_at=None) \
        .update({models.PasswordResetToken.used_at: utcnow()}, synchronize_session=False)
    raw = secrets.token_urlsafe(32)
    db.add(models.PasswordResetToken(
        user_id=user.id, token_hash=hash_token(raw), ip_address=client_ip(request),
        expires_at=utcnow() + timedelta(minutes=config.PASSWORD_RESET_MINUTES),
    ))
    log_event(db, request, "password_reset_requested", user=user)
    db.commit()
    background.add_task(send_reset_email, user.email, user.full_name or user.username, raw)
    return answer


def send_reset_email(email: str, name: str, raw_token: str) -> None:
    from .email_service import send_email  # avoid a circular import at startup

    link = f"{config.APP_BASE_URL}/?reset_token={raw_token}"
    body = f"""
    <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2430;max-width:520px">
      <p>Hello {escape(name)},</p>
      <p>We received a request to reset the password for your NPSB Dispute Email Automation account.</p>
      <p style="margin:24px 0">
        <a href="{link}" style="background:#e8222d;color:#fff;padding:10px 18px;border-radius:6px;
           text-decoration:none;font-weight:600">Reset password</a>
      </p>
      <p>Or open this link: <br><a href="{link}">{link}</a></p>
      <p>The link is valid for {config.PASSWORD_RESET_MINUTES} minutes and can be used once.
         If you did not ask for this, you can ignore this email; your password stays the same.</p>
    </div>"""
    try:
        send_email(to=[email], cc=[], subject="Reset your password", html_body=body)
    except Exception as exc:  # never crash the request; the log shows what happened
        print(f"Password reset email to {email} failed: {exc}")


@router.get("/reset-password/{token}")
def check_reset_token(token: str, db: Session = Depends(get_db)):
    """Lets the reset page say early whether the link is still valid."""
    reset = db.query(models.PasswordResetToken).filter_by(token_hash=hash_token(token)).first()
    if reset is None or reset.used_at is not None or reset.expires_at <= utcnow():
        raise HTTPException(400, "This reset link is invalid or has expired. Please request a new one.")
    return {"username": reset.user.username}


@router.post("/reset-password")
def reset_password(data: ResetPasswordIn, request: Request, db: Session = Depends(get_db)):
    reset = db.query(models.PasswordResetToken).filter_by(token_hash=hash_token(data.token)).first()
    if reset is None or reset.used_at is not None or reset.expires_at <= utcnow():
        raise HTTPException(400, "This reset link is invalid or has expired. Please request a new one.")
    user = reset.user
    check_password_strength(data.new_password, user.username, user.email or "")

    user.password_hash = hash_password(data.new_password)
    user.password_changed_at = utcnow()
    user.token_version += 1
    user.failed_login_count = 0
    user.locked_until = None
    if not user.email_verified:  # the reset link reached this inbox, so the address is real
        user.email_verified = True
        user.email_verified_at = utcnow()
    reset.used_at = utcnow()
    revoke_all_sessions(db, user)
    log_event(db, request, "password_reset", user=user, detail="all sessions signed out")
    db.commit()
    return {"message": "Your password has been reset. You can now sign in with the new password."}


@router.get("/sessions")
def list_sessions(request: Request, user: models.User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    """Devices/browsers where the user is signed in."""
    current = current_refresh_token(db, request)
    tokens = db.query(models.RefreshToken).filter(
        models.RefreshToken.user_id == user.id,
        models.RefreshToken.revoked_at.is_(None),
        models.RefreshToken.expires_at > utcnow(),
    ).order_by(models.RefreshToken.last_used_at.desc()).all()
    iso = lambda d: d.replace(tzinfo=timezone.utc).isoformat()  # noqa: E731
    return [{
        "id": t.id,
        "user_agent": t.user_agent,
        "ip_address": t.ip_address,
        "signed_in_at": iso(t.created_at),
        "last_used_at": iso(t.last_used_at),
        "expires_at": iso(t.expires_at),
        "remember_me": t.remember_me,
        "current": bool(current and current.family_id == t.family_id),
    } for t in tokens]


@router.delete("/sessions/{session_id}")
def revoke_session(session_id: int, request: Request, user: models.User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    token = db.get(models.RefreshToken, session_id)
    if token is None or token.user_id != user.id:
        raise HTTPException(404, "Session not found.")
    db.query(models.RefreshToken).filter_by(family_id=token.family_id, revoked_at=None) \
        .update({models.RefreshToken.revoked_at: utcnow()}, synchronize_session=False)
    log_event(db, request, "session_revoked", user=user, detail=token.user_agent[:120])
    db.commit()
    return {"message": "Session signed out."}


@router.get("/activity")
def my_activity(user: models.User = Depends(get_current_user), db: Session = Depends(get_db)):
    events = db.query(models.AuthEvent).filter_by(user_id=user.id) \
        .order_by(models.AuthEvent.created_at.desc()).limit(25).all()
    return [event_to_dict(e) for e in events]


def event_to_dict(e: models.AuthEvent) -> dict:
    return {
        "id": e.id, "event": e.event, "success": e.success, "detail": e.detail,
        "username": e.username, "ip_address": e.ip_address, "user_agent": e.user_agent,
        "created_at": e.created_at.replace(tzinfo=timezone.utc).isoformat(),
    }


