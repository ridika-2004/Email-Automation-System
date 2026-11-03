"""Recipients the mail server refused (when sending, or later in a bounce message)."""
import json
from datetime import datetime

from . import models


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
