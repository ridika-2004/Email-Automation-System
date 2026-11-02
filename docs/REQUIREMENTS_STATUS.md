# Requirement status and fixes

Status of the app against the BRD "Email Automation for NPSB Dispute Handling" (v1.0, 17 October 2026).
Status as of 2 November 2026.

**Summary:** the core flow works: upload, group, prepare, approve, send, reminders and reply tracking.
**Not built:** SMTP settings in the portal, maker-checker with change history for configuration, and
portal-defined variables and reminder templates.

## Requirements

| BRD section | Requirement | Status | Notes |
|---|---|---|---|
| 4.1 | Several recipient addresses per partner, each active or inactive | Done | |
| 4.1 | Only active partners and addresses receive email; otherwise an error, other partners unaffected | Done | |
| 4.1 | Nagad people in CC on all emails | Done | Set in Email Configuration |
| 4.1 | Partner changes under maker-checker, with change history | **Not built** | Partner changes are admin-only, take effect at once, and keep no history |
| 4.2 | One consolidated email per partner | Done, changed | One per partner **and mail type** (inward / outward) in each upload |
| 4.2 | Transaction details in the email | Partly | The transactions are in an attached Excel file. The current file format has no response code and no account numbers to mask |
| 4.3 | Templates defined in the portal, with variables filled from the file | Partly | Templates can be created and edited; variables are a fixed list (partner name, date, count, total, mail type) and can't be declared in the portal |
| 4.3 | Template matrix | **Open** | The BRD annexure is still "TBD". Templates exist per mail type only |
| 4.3 | Template changes under maker-checker | **Not built** | Users change templates directly |
| 4.4 | SMTP configured from the portal; changes apply immediately | **Not built** | Set in `backend/.env`, needs a restart. The portal only displays it |
| 4.5 | Emails prepared after upload; team triggers dispatch from the portal | Done | A user sends for approval, an admin sends |
| 4.6 | Temporary failures retried, with configurable count | Done | `SMTP_MAX_ATTEMPTS` |
| 4.6 | Configurable retry interval | **Not built** | Fixed at 2 seconds |
| 4.6 | Permanent failures marked failed and raised to NPSB operations | Partly | Shown as FAILED in the app, with the refused address flagged. Nobody is notified outside the app |
| 4.6 | No duplicate email after a restart or repeat run | Done | One email per upload, partner and mail type; sending claims each email first |
| 4.7 | Automatic reminder after a configurable period | Done | Switched on and timed in Email Configuration; **off by default** |
| 4.7 | Separate reminder template | Partly | Reminder wording is built in; an admin can edit each manual follow-up, but it is not a portal template |
| 5 | No transaction reported twice within the response period | **Not built** | Uploading the same transactions again in a new file creates new emails |
| 5 | No duplicate reminder, including after a restart | Done | Each follow-up is claimed in the database first |
| 5 | Every email logged with delivery status | Partly | Sent, failed and refused results are logged. "Sent" means the mail server accepted it, not that it was delivered |
| 3 | Role-based access | Done | Admin and user roles |

## Added beyond the BRD

- Partner Replies: reads replies from the sending mailbox, links them to the right email, stores attachments, and shows a per-person count of new replies with a pop-up.
- Approval step: users prepare emails, admins send them (Pending Mails).
- Sent Mails: search and filters, reply status, follow-up history, notes and remarks.
- Sign-in with an emailed code, account lockout, password reset, devices and security log.
- Mobile layout and a Back button.

## Main fixes

| Problem | Fix |
|---|---|
| Replies went to a separate Reply-To mailbox that the app didn't read | Every email now has `Reply-To: MAIL_FROM`; the editable Reply-To setting was removed |
| Older sent emails had no saved Message-ID, so replies couldn't be linked to them reliably | Missing IDs are recovered from the Sent folder |
| Follow-ups' Message-IDs weren't saved | Saved when sent, so replies to a follow-up are matched |
| Any sender on the partner's domain could match, even when that is our own domain | Partners on our own domain, or on free mail providers, match by exact address only |
| A partner reply could not affect the email's status automatically | A reply sets *Reply received* and is added to the history |
| Partner email HTML could overlay the app or open links in place of it | Dangerous content is removed, the view is contained, and links open in a new tab |
| Pages overflowed on phones | Tables scroll inside their card; added a phone menu bar |
| Demo partners with fake addresses came back on an empty database | Removed; only the two standard templates are added |

## Known limits

- Replies to emails sent before Reply-To was fixed go to the old address and are not read.
- Sign-in depends on email: if the mail server or app password fails, nobody can get a sign-in code.
- A reply from an address other than the partner's, with no reply headers, is not matched.
- There are no automated tests in the repository yet.
