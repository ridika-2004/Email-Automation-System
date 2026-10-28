from . import models

# Demo partners for a new, empty database: the partners in the sample file, matched by name (KEY_ORG_NM)
DEMO_PARTNERS = [
    ("bKash", True, [("email.example@gmail.com", True)]),
    ("Rocket", True, [("email.example@gmail.com", True)]),
    ("TallyPay", True, [("email.example@gmail.com", False)]),  # no ACTIVE email -> shows the error message
    # UPAY is in the sample file but intentionally NOT configured -> "no partner with this name"
]


def seed_templates(db):
    """A new database gets the two templates of docs/Email_Template.docx, as the defaults."""
    from .email_service import DEFAULT_TEMPLATES

    if db.query(models.EmailTemplate).count() > 0:
        return
    for mail_type, t in DEFAULT_TEMPLATES.items():
        db.add(models.EmailTemplate(
            name=t["name"], mail_type=mail_type, subject=t["subject"], body_html=t["body_html"].strip(),
            description="Standard wording (docs/Email_Template.docx)", is_default=True,
        ))
    db.commit()


def seed_partners(db):
    if db.query(models.Partner).count() > 0:
        return
    for name, active, emails in DEMO_PARTNERS:
        partner = models.Partner(name=name, is_active=active)
        partner.emails = [models.PartnerEmail(email=e, is_active=a) for e, a in emails]
        db.add(partner)
    db.commit()
