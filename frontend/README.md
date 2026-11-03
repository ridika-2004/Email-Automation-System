# NPSB Dispute Email Automation — Frontend

Web interface for the NPSB dispute email system: upload the daily dispute file, check the grouped
transactions, prepare and approve partner emails, follow up, and read partners' replies.

Stack: **React 18** · **Vite** · **Tailwind CSS**

It needs the backend API, a separate module:
[Email_Automation_Backend](https://github.com/Solutions024/Email_Automation_Backend). Requirement status
and fixes are documented there in `docs/REQUIREMENTS_STATUS.md`.

---

## 1. How to run (Windows)

**You need:** Node.js 18+, and the backend running on **http://localhost:8000** (see its README).

```bash
npm install
npm run dev
```
Open **http://localhost:5173**

The development server forwards every `/api` request to `http://127.0.0.1:8000` (`vite.config.js`).
If the backend runs elsewhere, change the `proxy` target there.

### Production build
```bash
npm run build
```
The site is created in `dist/`. Serve it from the same address as the API, with `/api` passed through to
the backend: sign-in uses a cookie that only works on the same site. Set the backend's `APP_BASE_URL` to
the frontend's address.

## 2. Project structure

```
frontend/
├── index.html
├── vite.config.js          dev server and /api proxy
├── tailwind.config.js      colours (brand red, ink, muted, line)
└── src/
    ├── main.jsx
    ├── App.jsx             page layout, Back button, reply notifications
    ├── api.js              every call to the backend; access token and refresh cookie
    ├── index.css           Tailwind
    ├── components/
    │   ├── Sidebar.jsx     menu (pin it on wide screens; phone menu bar)
    │   ├── ui.jsx          shared Tailwind class names and small components
    │   ├── EmailHtml.jsx   safe email view and editor
    │   ├── EmailActivity.jsx, FollowUpModal.jsx, MailTypeBadge.jsx, Modal.jsx, Password.jsx
    └── pages/              one file per page (below)
```

## 3. Pages

| Page | Who | What it does |
|---|---|---|
| Sign in / Create account | everyone | password plus an emailed 6-digit code |
| Home (users) | users | upload a dispute file, download the template |
| Grouped Transactions | users | transactions grouped by partner and mail type |
| Email Preview & Send | users | choose templates, edit each email, send for approval |
| Home (admins) | admins | what needs attention today |
| Pending Mails | everyone; admins send | emails waiting for approval, with their history |
| Sent Mails | everyone; admins act | reply status, follow-ups, notes, and each email's history up to every partner reply |
| Partner Replies | everyone | two lists: replies to our emails, and other mail from partners; the sidebar shows how many are new |
| Partner Configuration | everyone; admins change | partners and their addresses |
| Email Templates | users | templates per mail type |
| Email Configuration | everyone; admins change | follow-up timing, automatic follow-ups, CC; shows the mail server |
| System Settings | admins | mail server, inbox, retries, background jobs, sign-up and security (applied at once) |
| My Profile, Users & Security | everyone / admins | account, devices, users, audit log |

The layout works on phones: tables scroll sideways inside their card, and a menu bar replaces the
side menu.
