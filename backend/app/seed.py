from . import models

DEMO_PARTNERS = [
    ("0101", "bKash", True, [("email.example@gmail.com", True), ("email.example@gmail.com", True)]),
    ("0102", "Rocket (DBBL)", True, [("email.example@gmail.com", True)]),
    ("0201", "BRAC Bank", True, [("email.example@gmail.com", True)]),
    ("0202", "Islami Bank Bangladesh", True, [("email.example@gmail.com", False)]),  # no ACTIVE email -> error demo
    ("0203", "The City Bank", True, [("email.example@gmail.com", True)]),
    # 0301 Upay is in the sample file but intentionally NOT configured -> error demo
]


def seed_partners(db):
    if db.query(models.Partner).count() > 0:
        return
    for code, name, active, emails in DEMO_PARTNERS:
        partner = models.Partner(institution_code=code, name=name, is_active=active)
        partner.emails = [models.PartnerEmail(email=e, is_active=a) for e, a in emails]
        db.add(partner)
    db.commit()
