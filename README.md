# NPSB Dispute Email Automation

Upload the daily dispute file → the system finds transactions with an **unknown response code**,
groups them by **destination partner**, prepares **one consolidated email per partner**, and sends
them when the reconciliation team clicks **Send**.

Stack: **React (Vite)** · **FastAPI** · **MySQL** · a built-in test mail server (nothing reaches real partners)

---

## 1. Project structure

```
npsb-email-automation/
├── backend/
│   ├── requirements.txt
│   ├── .env.example          copy to .env and add your MySQL password
│   ├── test_mail_server.py   fake SMTP server; saves emails to sent_emails/
│   ├── schema.sql            optional: create tables by hand in Workbench
│   └── app/
│       ├── main.py           all API endpoints
│       ├── models.py         database tables
│       ├── excel_parser.py   reads + validates .xlsx / .csv
│       ├── email_service.py  builds the email, masks accounts, sends via SMTP
│       ├── seed.py           demo partners added on first start
│       ├── database.py       DB connection
│       ├── settings.py       Email Configuration values (DB, .env defaults)
│       └── config.py         reads .env
├── frontend/
│   └── src/
│       ├── App.jsx           page layout: sidebar (components/Sidebar.jsx) + pages
│       ├── api.js            calls to the backend
│       └── pages/            UploadPage, GroupsPage, EmailsPage, PartnersPage
└── sample-data/
    ├── dispute_transactions_sample.xlsx   upload this
    ├── dispute_transactions_sample.csv    same data as CSV
    ├── invalid_missing_columns.xlsx       shows "file rejected"
    └── generate_samples.py                re-creates the files above
```

## 2. How to run (Windows, no Docker)

**You need:** Python 3.10+, Node.js 18+, and MySQL Server (the one MySQL Workbench connects to).

You will have **3 terminals** open: test mail server, backend, frontend.

### Step 1 – set up the backend (one time)
```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```
Open `backend\.env` and enter the MySQL details you use in Workbench:
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_mysql_password
DB_NAME=npsb_dispute
```
You do **not** need to create the database in Workbench. The backend creates the
`npsb_dispute` database, its tables and 5 demo partners on first start.

### Step 2 – terminal 1: test mail server
```bash
cd backend
venv\Scripts\activate
python test_mail_server.py
```
This is a fake mail server. Nothing is sent to real partners. Each email is printed in this
terminal and saved as an `.html` file in `backend\sent_emails\`. Double-click a file to view it.

### Step 3 – terminal 2: backend
```bash
cd backend
venv\Scripts\activate
uvicorn app.main:app --reload --port 8000
```
API docs: **http://localhost:8000/docs**

Before the first start, add a sign-in secret to `backend\.env` (see `.env.example`):
```
JWT_SECRET=<output of: python -c "import secrets; print(secrets.token_urlsafe(48))">
```

After it starts, refresh MySQL Workbench (Schemas panel) to see the `npsb_dispute` database.

### Step 4 – terminal 3: frontend
```bash
cd frontend
npm install
npm run dev
```
Open **http://localhost:5173**

### Signing in
- There are no roles: every user can use every feature, including **Users & Security**.
- Only real email addresses work. The domain must be able to receive mail, throwaway inboxes
  are refused, and a **6-digit code** is emailed to the address. The account can't sign in
  until the code is entered. Changing your email also needs a code sent to the new address.
- Afterwards, set `ALLOW_REGISTRATION=false` in `.env` so only signed-in users can add accounts
  (**Users & Security** tab). New users confirm their email with a code on first sign-in.
- Sign in with username or email. "Keep me signed in" keeps the session for 30 days.
- 5 wrong passwords lock the account for 15 minutes (any other user can unlock it).
- **Forgot password?** emails a one-time reset link (valid 30 minutes) through the SMTP server in `.env`.
  With the test mail server, open the saved email in `backend\sent_emails\` and click the link.
- **Menu**: move the mouse to the left edge of the screen and point at the arrow to open the sidebar
  (pages, Email Configuration and User Settings). The pin button keeps it open.
- **Email Configuration**: after how many days a sent email is *Follow-up due*, automatic follow-ups
  (on/off, at most N per email), CC addresses and Reply-To. Everyone can see it; admins change it.
- **My Profile**: edit your profile, change your password, see and sign out your devices,
  and review recent security activity.

### Common problems
| Error | Fix |
|---|---|
| `Access denied for user 'root'@'localhost'` | wrong `DB_PASSWORD` in `.env` |
| `Can't connect to MySQL server on 'localhost'` | MySQL service isn't running. Open *Services* (Win+R → `services.msc`) and start **MySQL80** |
| Emails show **FAILED** with `Connection refused` | the test mail server (terminal 1) isn't running |
| Sign-in page says **Method Not Allowed** / **Not Found**, or *Cannot reach the server* | port 8000 is not this backend (or nothing is running there). Stop whatever else uses port 8000, then start the backend (step 3) |
| `'venv\Scripts\activate' is not recognized` in PowerShell | run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt |

## 3. Demo script (≈ 3 minutes)

1. **Upload File** → choose `invalid_missing_columns.xlsx` → file is **rejected** with the missing column names.
2. Upload `dispute_transactions_sample.xlsx` (or `.csv`) → 32 rows, 30 valid, 22 unknown, **2 rows skipped** with the reason (blank RRN, amount "abc").
3. **Grouped Transactions** → 6 partners with counts and totals; click a partner to see its transactions (accounts masked).
4. **Email Preview & Send** → 4 emails prepared. Two partners show an error on purpose:
   - *Islami Bank* – only has an inactive email address
   - *Upay* – not configured at all
5. **Partner Configuration** → add Upay (code `0301`) and an active email for Islami Bank → back to step 4 → **Refresh previews** → now 6 emails.
6. Click **Send** → statuses turn **SENT**. Show terminal 1 and open a file in `backend\\sent_emails\\` to show the received email.
7. Click Send again → nothing is re-sent (no duplicates).
8. *(Optional)* stop the test mail server (Ctrl+C in terminal 1), upload again, send → status **FAILED** with the error after 3 attempts.

## 4. File format

| Column | Example | Notes |
|---|---|---|
| Txn Datetime | 2026-10-17 10:05:00 | any normal date/time |
| RRN | 629017220956 | |
| STAN | 990174 | |
| Amount | 25000.00 | must be > 0 |
| Source Account | 01712345678 | masked in email |
| Beneficiary Account | 0808435921521 | masked in email |
| Txn Type | Fund Transfer (P2P) | |
| Response Code | 91 | `68, 91, 96` = unknown (change in `.env`) |
| Nagad Status | PENDING | |
| Dest Institution Code | 0101 | matched against Partner Configuration |
| Dest Partner Name | bKash | |

Header names are case-insensitive (`Response Code` = `response_code`).

**Validation rules**
- Wrong file type or a missing column → the whole file is rejected, nothing is saved.
- A row with a blank value, bad amount or bad date → only that row is skipped and listed; the rest is imported.
- Only rows whose response code is in `UNKNOWN_RESPONSE_CODES` are grouped and emailed.

## 5. API summary

| Method | URL | What it does |
|---|---|---|
| POST | `/api/uploads` | upload + validate file |
| GET | `/api/uploads/{id}` | unknown transactions grouped by partner |
| POST | `/api/uploads/{id}/prepare-emails` | build one email per partner (preview) |
| GET | `/api/uploads/{id}/emails` | list prepared emails with status |
| POST | `/api/uploads/{id}/send` | send all emails not yet SENT |
| GET / POST | `/api/partners` | list / add partners |
| PUT | `/api/partners/{id}` | edit partner, emails, active status |
| GET | `/api/config` | SMTP host, CC list, unknown codes |

## 6. Settings (`backend/.env`)

| Setting | Meaning |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection (same as Workbench) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_USE_TLS` | mail server (test_mail_server.py by default) |
| `MAIL_FROM`, `REPLY_TO` | sender + monitored reply mailbox (Reply-To can be changed in Email Configuration) |
| `CC_EMAILS` | Nagad people CC'd on every email (default; change it in Email Configuration) |
| `FOLLOWUP_DUE_DAYS`, `AUTO_FOLLOWUP_ENABLED`, `AUTO_FOLLOWUP_MAX` | follow-up defaults; admins change them in Email Configuration |
| `AUTO_FOLLOWUP_CHECK_SECONDS` | how often the server looks for due emails (default 300) |
| `UNKNOWN_RESPONSE_CODES` | codes treated as unknown |
| `SMTP_MAX_ATTEMPTS` | retries before marking an email FAILED |

## 7. Not in this demo (from the BRD, for later phases)

- Email templates configurable from the portal (template matrix)
- SMTP settings editable from the portal (currently `.env`)
- Maker–checker approval and change history
- Login / role-based access
