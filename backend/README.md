# NPSB Dispute Email Automation — Backend

API for the NPSB dispute email system. It reads the uploaded dispute file, groups transactions by
**partner and mail type**, prepares one email for each from templates, sends them after an admin
approves, sends follow-ups, and reads partners' replies from the sending mailbox.

Stack: **FastAPI** · **SQLAlchemy** · **MySQL** · SMTP (sending) · IMAP (reading replies)

The user interface is a separate module: [Email_Automation_FrontEnd](https://github.com/Solutions024/Email_Automation_FrontEnd).
How far the app meets the BRD, and what has been fixed: [docs/REQUIREMENTS_STATUS.md](docs/REQUIREMENTS_STATUS.md)

---

## 1. Project structure

```
backend/
├── requirements.txt
├── .env.example          copy to .env and add your MySQL and mail details
├── test_mail_server.py   fake SMTP server; saves emails to sent_emails/
├── schema.sql            optional: create tables by hand in Workbench
├── app/
│   ├── main.py           app API endpoints and background follow-ups
│   ├── auth.py           sign-in, sessions, password recovery
│   ├── users.py          user management (admins)
│   ├── inbox.py          reads partners' replies from the mailbox (IMAP)
│   ├── models.py         database tables
│   ├── excel_parser.py   reads + validates .xlsx / .csv
│   ├── email_service.py  templates, building emails, sending via SMTP
│   ├── email_check.py    checks that an address can really receive mail
│   ├── seed.py           the two standard email templates, added on first start
│   ├── database.py       DB connection
│   ├── settings.py       Email Configuration values (DB, .env defaults)
│   └── config.py         reads .env
├── docs/                 requirement status, email wording, status deck
└── sample-data/
    └── generate_samples.py   creates test upload files
```

## 2. How to run (Windows)

**You need:** Python 3.10+ and MySQL Server (the one MySQL Workbench connects to).

### Step 1 – set up (one time)
```bash
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```
Open `.env` and enter your MySQL details:
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=npsb_dispute
```
Also set a sign-in secret, and change the admin code:
```
JWT_SECRET=<output of: python -c "import secrets; print(secrets.token_urlsafe(48))">
ADMIN_SIGNUP_CODE=<your own code>
```
You do **not** need to create the database. The backend creates the `npsb_dispute` database, its
tables and the two standard email templates on first start. Partners are added in the app.

### Step 2 – choose a mail server
Signing in needs an emailed code, so a mail server is required even for testing. Set it in `.env` for the
first start; afterwards admins can change it, and most other settings, on the **System Settings** page
(see section 8).

**Real Gmail / Google Workspace mailbox** (`SMTP_PASSWORD` is a 16-character
[app password](https://myaccount.google.com/apppasswords), without spaces):
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USE_TLS=true
SMTP_USER=mailbox@example.com
SMTP_PASSWORD=your16characters
MAIL_FROM=mailbox@example.com
```

**Or the test mail server** (nothing leaves your PC; partners' replies can't be read with it):
set `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_USE_TLS=false`, leave `SMTP_USER` empty, and run this
in its own terminal. Each email is saved as an `.html` file in `sent_emails\`.
```bash
venv\Scripts\activate
python test_mail_server.py
```

### Step 3 – start the API
```bash
venv\Scripts\activate
python -m uvicorn app.main:app --reload --port 8000
```
API docs: **http://localhost:8000/docs**. The frontend expects the API on port 8000.
Restart after changing `.env`: auto-reload only watches the code.

`APP_BASE_URL` (default `http://localhost:5173`) must be the frontend's address: it is allowed by CORS
and used in password-reset links.

## 3. Roles

- **Users** upload files, prepare emails, manage email templates, and send emails for approval.
- **Admins** send pending emails, manage partners and users, set reply status, send follow-ups and
  change Email Configuration. Creating an admin account needs `ADMIN_SIGNUP_CODE`.
- Sign-in uses a password plus a **6-digit code** emailed to the account. 5 wrong passwords lock the
  account for 15 minutes. Set `ALLOW_REGISTRATION=false` once everyone has an account.

## 4. Reading partner mail

Every email has `Reply-To: <MAIL_FROM>`, so replies come back to the sending mailbox. The backend reads
that mailbox over IMAP every 2 minutes, read-only, so nothing is marked as read there. For Gmail nothing
extra is needed: it uses `imap.gmail.com` with `SMTP_USER` and `SMTP_PASSWORD`. Keep `MAIL_FROM` the same
as `SMTP_USER`.

Incoming mail from partners is kept in two lists:
- **Replies to our emails:** the message answers one of our emails or follow-ups (its reply headers), or has
  the same subject and comes from that partner's address or domain. A reply sets the email to *Reply received*.
  Automatic replies (out of office) and bounce messages are stored with the email but don't change its status;
  a bounce flags the address it names as refused.
- **Other mail from partners:** messages from a partner's address (or company domain) that don't answer any of
  our emails.

All other mail (personal mail, colleagues on CC, newsletters) is never downloaded. Emails sent before
Message-IDs were saved get them back from the Sent folder.

## 4a. Email history

Each email keeps its history, oldest first: sent for approval, sent (or failed, with the error),
follow-ups, every message from the partner, reply-status changes, notes and remarks. It is shown on
Pending Mails and Sent Mails.

## 5. Common problems

| Error | Fix |
|---|---|
| `Access denied for user 'root'@'localhost'` | wrong `DB_PASSWORD` in `.env` |
| `Can't connect to MySQL server on 'localhost'` | MySQL service isn't running. Open *Services* (Win+R → `services.msc`) and start **MySQL80** |
| *Connection unexpectedly closed* when sending through Gmail, or *Invalid credentials* when reading replies | Google rejected the app password. Create a new one, save it in `SMTP_PASSWORD`, restart the backend |
| Emails show **FAILED** with `Connection refused` | the mail server isn't reachable; with the test mail server, check that it is running |
| The frontend says **Method Not Allowed** / **Not Found**, or *Cannot reach the server* | port 8000 is not this backend (or nothing is running there). Stop whatever else uses port 8000, then start the backend |
| `'venv\Scripts\activate' is not recognized` in PowerShell | run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt |

## 6. File format

One row per transaction, in `.xlsx` or `.csv`. All columns must exist.

| Column | Example | Notes |
|---|---|---|
| `NPSB_TXN_RRN` | 624515085655 | required value |
| `APPROVAL_DATE` | 2026-09-02 | |
| `APPROVAL_DATETIME` | 02-SEP-26 03.56.37.586000 PM | |
| `TXN_TYPE` | NPSB - MFS to NAGAD | |
| `TXN_ID` | 00043BOS | |
| `FIRST_TXN_STATUS_NAME` | APPROVED | |
| `TXN_AMOUNT` | 20500 | required value |
| `FROMAC_NAME` | bKash | |
| `TOAC_TYPE` | CUSTOMER | |
| `ORG_TXN_STAN` | 087542 | |
| `KEY_ORG_NM` | bKash | required value; matched by name to the partner |
| `NPSB_ORG_CODE` | 022002 | |
| `TXN_DIRECTION` | Inward | required value; Inward / Outward picks the email template |

- Wrong file type or a missing column → the whole file is rejected, nothing is saved.
- A row with a bad required value → only that row is skipped and listed; the rest is imported.

## 7. API summary

Full, always-current list: **http://localhost:8000/docs**. Everything needs sign-in.

| URL | What it does |
|---|---|
| `/api/auth/...`, `/api/users` | sign-in, sessions, password recovery; user management (admins) |
| `/api/uploads`, `/api/upload-template` | upload and validate files, list uploads, download the template |
| `/api/uploads/{id}/prepare-emails`, `/emails`, `/submit` | build emails, list them, send them for approval |
| `/api/emails/{id}`, `/template`, `/edits`, `/attachment` | edit one email, change its template, discard edits, download its file |
| `/api/pending-emails`, `/api/pending-emails/send` | list emails waiting for an admin; send the ticked ones (admins) |
| `/api/sent-emails`, `/summary` | sent emails with filters and counts |
| `/api/emails/{id}/reply-status`, `/notes`, `/remarks`, `/followups`, `/events` | follow-up of sent emails and its history |
| `/api/replies`, `/summary`, `/read-all`, `/check-now` | partners' replies, new-reply count, mark all read, read the mailbox now (admins) |
| `/api/replies/{id}`, `/read`, `/attachments/{aid}` | one reply (opening it marks it read), mark as new, download an attachment |
| `/api/partners`, `/api/email-templates`, `/api/email-settings` | Partner Configuration, Email Templates, Email Configuration |
| `/api/replies?category=replies\|partner_mail` | the two lists of partner mail |
| `/api/server-settings`, `/test` | System Settings: read, save (tested first), test a connection (admins) |

## 8. Settings (`.env` and System Settings)

`.env` holds the starting values. Admins change these on the **System Settings** page, and a change applies
at once without a restart: the mail server, retries, the inbox, the follow-up check interval, and sign-up
and security settings. Passwords are stored encrypted (with a key made from `JWT_SECRET`) and are never
shown. A change to the mail server or the inbox is tested first; if the test fails nothing is saved, unless
the admin chooses *Save anyway*. Only the database connection, `JWT_SECRET`, `APP_BASE_URL` and
`COOKIE_SECURE` must be changed in `.env` (with a restart).

| Setting | Meaning |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection (same as Workbench) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_USE_TLS` | mail server for sending |
| `MAIL_FROM` | sender; partners' replies come back to it (Reply-To) |
| `CC_EMAILS` | people CC'd on every email (default; change it in Email Configuration) |
| `FOLLOWUP_DUE_DAYS`, `AUTO_FOLLOWUP_ENABLED`, `AUTO_FOLLOWUP_MAX` | follow-up defaults; admins change them in Email Configuration |
| `AUTO_FOLLOWUP_CHECK_SECONDS` | how often the server looks for due emails (default 300) |
| `SMTP_MAX_ATTEMPTS`, `SMTP_RETRY_SECONDS` | attempts before an email is marked FAILED, and the wait between them |
| `INBOX_ENABLED`, `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_FOLDER` | reading partner mail on/off, and the mailbox it is read from. Defaults: `imap.gmail.com` when sending through Gmail (otherwise empty = off), 993, `SMTP_USER`, `SMTP_PASSWORD`, `INBOX` |
| `INBOX_CHECK_SECONDS`, `INBOX_FIRST_SCAN_DAYS` | how often the mailbox is read (default 120); how far back the first check looks (default 60 days) |
| `JWT_SECRET`, `ADMIN_SIGNUP_CODE`, `ALLOW_REGISTRATION` | sign-in secret, code for creating admins, whether anyone can sign up |
| `APP_BASE_URL` | the frontend's address (CORS and password-reset links) |
