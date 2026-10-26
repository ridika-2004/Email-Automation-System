"""User management and the security audit log. Admins only."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from . import models
from .auth import (
    check_admin_code, check_password_strength, clean_email, clean_full_name, clean_username, event_to_dict,
    hash_password, log_event, require_admin, user_to_dict,
)
from .database import get_db
from .email_check import validate_real_email
from .models import utcnow

router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[Depends(require_admin)])


class NewUserIn(BaseModel):
    full_name: str
    username: str
    email: str
    password: str
    role: Literal["admin", "user"] = "user"
    admin_code: str = ""     # needed when role is "admin"

    _name = field_validator("full_name")(lambda cls, v: clean_full_name(v))
    _username = field_validator("username")(lambda cls, v: clean_username(v))
    _email = field_validator("email")(lambda cls, v: clean_email(v))


class UserUpdateIn(BaseModel):
    unlock: bool = False


@router.get("")
def list_users(me: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    return [user_to_dict(u) for u in db.query(models.User).order_by(models.User.username).all()]


@router.post("", status_code=201)
def create_user(data: NewUserIn, request: Request, me: models.User = Depends(require_admin),
                db: Session = Depends(get_db)):
    """Create an account for someone. They sign in with their password plus a code emailed to them."""
    check_admin_code(db, request, data.role, data.admin_code, data.username)
    check_password_strength(data.password, data.username, data.email)
    if db.query(models.User).filter_by(username=data.username).first():
        raise HTTPException(409, "This username is already taken.")
    if db.query(models.User).filter_by(email=data.email).first():
        raise HTTPException(409, "An account with this email already exists.")
    validate_real_email(data.email)
    user = models.User(
        username=data.username, email=data.email, full_name=data.full_name, role=data.role,
        password_hash=hash_password(data.password), password_changed_at=utcnow(),
    )
    db.add(user)
    db.flush()
    log_event(db, request, "user_created", user=me, detail=f"created {user.username} ({user.role})")
    db.commit()
    return user_to_dict(user)


@router.patch("/{user_id}")
def update_user(user_id: int, data: UserUpdateIn, request: Request,
                me: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(404, "User not found.")

    changes = []
    if data.unlock and (user.locked_until or user.failed_login_count):
        user.locked_until = None
        user.failed_login_count = 0
        changes.append("unlocked")

    if changes:
        log_event(db, request, "user_updated", user=me, detail=f"{user.username}: " + ", ".join(changes))
    db.commit()
    return user_to_dict(user)


@router.get("/events")
def audit_log(limit: int = 100, me: models.User = Depends(require_admin), db: Session = Depends(get_db)):
    limit = max(1, min(limit, 500))
    events = db.query(models.AuthEvent).order_by(models.AuthEvent.created_at.desc(), models.AuthEvent.id.desc()) \
        .limit(limit).all()
    return [event_to_dict(e) for e in events]
