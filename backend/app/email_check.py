"""Checks that an email address can really receive mail.

Two layers:
  1. Here, before an account is created or an email is changed: the address must be
     well-formed, not from a throwaway/disposable provider, and its domain must have a
     mail server (DNS MX record, or an A/AAAA record as the standard fallback).
  2. In auth.py: a 6-digit code is emailed to the address and must be entered. That is the
     only way to prove the mailbox itself exists and belongs to the person.
"""
import re
import time

import dns.exception
import dns.resolver
from fastapi import HTTPException

from . import config

EMAIL_RE = re.compile(
    r"(?=.{6,254}$)"                                   # overall length
    r"[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"  # local part
    r"@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}"           # domain + TLD
)

# Common throwaway inbox providers
DISPOSABLE_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "guerrillamail.net", "sharklasers.com", "10minutemail.com",
    "10minutemail.net", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmail.net", "throwawaymail.com",
    "yopmail.com", "yopmail.net", "getnada.com", "nada.email", "trashmail.com", "trashmail.de",
    "dispostable.com", "maildrop.cc", "mailnesia.com", "mintemail.com", "fakeinbox.com", "emailondeck.com",
    "mohmal.com", "mailcatch.com", "spamgourmet.com", "tempinbox.com", "moakt.com", "tempr.email",
    "discard.email", "mailpoof.com", "burnermail.io", "inboxkitten.com", "1secmail.com", "1secmail.net",
    "fakemail.net", "emailfake.com", "tmpmail.org", "tmpmail.net", "minuteinbox.com", "byom.de",
    "example.com", "example.org", "example.net", "test.com",
}

_cache: dict[str, tuple[float, bool]] = {}   # domain -> (checked at, can receive mail)
_CACHE_SECONDS = 3600


def domain_accepts_mail(domain: str) -> bool:
    """True if DNS says this domain has somewhere to deliver mail."""
    cached = _cache.get(domain)
    if cached and time.monotonic() - cached[0] < _CACHE_SECONDS:
        return cached[1]

    resolver = dns.resolver.Resolver()
    resolver.lifetime = 6
    try:
        answers = resolver.resolve(domain, "MX")
        # A "null MX" (a single record pointing at ".") means: this domain never receives mail
        ok = any(str(r.exchange).rstrip(".") for r in answers)
    except (dns.resolver.NXDOMAIN, dns.resolver.NoNameservers):
        ok = False
    except dns.resolver.NoAnswer:
        # No MX record: mail servers fall back to the domain's own address (RFC 5321)
        ok = False
        for rtype in ("A", "AAAA"):
            try:
                resolver.resolve(domain, rtype)
                ok = True
                break
            except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN, dns.resolver.NoNameservers):
                continue
    except dns.exception.Timeout:
        raise HTTPException(503, "Could not check the email address right now (DNS timeout). Please try again.")

    _cache[domain] = (time.monotonic(), ok)
    return ok


def validate_real_email(email: str) -> str:
    """Return the normalized address, or raise 400 explaining why it cannot be used."""
    email = email.strip().lower()
    if not EMAIL_RE.fullmatch(email):
        raise HTTPException(400, "Enter a valid email address.")
    domain = email.rsplit("@", 1)[1]
    if domain in DISPOSABLE_DOMAINS or any(domain.endswith("." + d) for d in DISPOSABLE_DOMAINS):
        raise HTTPException(400, "Disposable or example email addresses are not allowed. Use your real email.")
    if config.EMAIL_DNS_CHECK and not domain_accepts_mail(domain):
        raise HTTPException(400, f"The email domain \"{domain}\" does not exist or cannot receive email.")
    return email
