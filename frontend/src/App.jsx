import { useEffect, useRef, useState } from "react";
import { api, auth, SESSION_EXPIRED_EVENT } from "./api";
import AuthPage from "./pages/AuthPage";
import AccountPage from "./pages/AccountPage";
import UsersPage from "./pages/UsersPage";
import UploadPage from "./pages/UploadPage";
import GroupsPage from "./pages/GroupsPage";
import EmailsPage from "./pages/EmailsPage";
import PartnersPage from "./pages/PartnersPage";
import PendingPage from "./pages/PendingPage";
import SentPage from "./pages/SentPage";

// Users prepare the emails; admins send them from Pending Mails and manage partners and users
const USER_TABS = [
  { id: "upload", label: "1. Upload File" },
  { id: "groups", label: "2. Grouped Transactions" },
  { id: "emails", label: "3. Email Preview & Send" },
  { id: "pending", label: "Pending Mails" },
  { id: "sent", label: "Sent Mails" },
  { id: "partners", label: "Partner Configuration" },
];
const ADMIN_TABS = [
  { id: "pending", label: "Pending Mails" },
  { id: "sent", label: "Sent Mails" },
  { id: "partners", label: "Partner Configuration" },
  { id: "users", label: "Users & Security" },
];

const hasResetLink = () => new URLSearchParams(window.location.search).has("reset_token");

// Shows the sign-in page until the user is signed in, then the app
export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(() => !hasResetLink()); // restoring a session from the cookie
  const [notice, setNotice] = useState("");

  useEffect(() => {
    // A refresh cookie from an earlier visit signs the user straight back in
    if (!hasResetLink()) auth.restore().then(setUser).finally(() => setChecking(false));

    const onExpired = (e) => {
      setUser(null);
      setNotice(e.detail || "Your session has ended. Please sign in again.");
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);

    // Keep all open tabs in sync
    const stop = auth.onBroadcast((type) => {
      if (type === "logout") {
        auth.setToken(null);
        setUser(null);
        setNotice("You signed out in another tab.");
      } else if (type === "login") {
        auth.restore().then((u) => u && setUser(u));
      }
    });
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
      stop();
    };
  }, []);

  async function signOut(alreadyRevoked = false) {
    if (!alreadyRevoked) await api.logout().catch(() => {});
    auth.setToken(null);
    auth.broadcast("logout");
    setUser(null);
    setNotice("You have been signed out.");
  }

  if (checking) return <div className="auth-loading">Loading...</div>;
  if (!user) {
    return <AuthPage key={notice} notice={notice} onSignedIn={(u) => { setUser(u); setNotice(""); }} />;
  }
  return <MainApp user={user} onUserChange={setUser} onSignOut={signOut} />;
}

function MainApp({ user, onUserChange, onSignOut }) {
  const isAdmin = user.role === "admin";
  const tabs = isAdmin ? ADMIN_TABS : USER_TABS;
  const [tab, setTab] = useState(tabs[0].id);
  const [upload, setUpload] = useState(null); // result of the last successful upload
  const [config, setConfig] = useState(null);

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => setConfig(null));
  }, []);

  const needsUpload = (id) => (id === "groups" || id === "emails") && !upload;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>NPSB Dispute Email Automation</h1>
          <p>Group unknown-response transactions by partner and request clarification by email</p>
        </div>
        <div className="header-right">
          {config && (
            <div className="smtp-badge" title="Emails go to this SMTP server">
              SMTP: {config.smtp_host}:{config.smtp_port}
            </div>
          )}
          <UserMenu user={user} isAdmin={isAdmin} onOpen={setTab} onSignOut={() => onSignOut()} />
        </div>
      </header>

      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab active" : "tab"}
            disabled={needsUpload(t.id)}
            title={needsUpload(t.id) ? "Upload a file first" : ""}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        {upload && <span className="current-file">Current file: {upload.filename} (#{upload.upload_id})</span>}
      </nav>

      <main>
        {tab === "upload" && !isAdmin && (
          <UploadPage
            config={config}
            lastUpload={upload}
            onUploaded={setUpload}
            onNext={() => setTab("groups")}
          />
        )}
        {tab === "groups" && upload && !isAdmin && <GroupsPage uploadId={upload.upload_id} onNext={() => setTab("emails")} />}
        {tab === "emails" && upload && !isAdmin && (
          <EmailsPage uploadId={upload.upload_id} config={config} onOpenPending={() => setTab("pending")} />
        )}
        {tab === "pending" && <PendingPage config={config} isAdmin={isAdmin} />}
        {tab === "sent" && <SentPage config={config} />}
        {tab === "partners" && <PartnersPage isAdmin={isAdmin} />}
        {tab === "account" && <AccountPage user={user} onUserChange={onUserChange} onSignedOut={onSignOut} />}
        {tab === "users" && isAdmin && <UsersPage currentUser={user} />}
      </main>
    </div>
  );
}

function UserMenu({ user, isAdmin, onOpen, onSignOut }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn) => () => { setOpen(false); fn(); };

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <span className="avatar" aria-hidden="true">{(user.full_name || user.username)[0].toUpperCase()}</span>
        <span className="user-name">{user.full_name || user.username}</span>
        <span aria-hidden="true" className="caret">▾</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-header">
            <b>{user.full_name || user.username}</b>
            <span className="muted small">{user.email || user.username}</span>
          </div>
          <button role="menuitem" onClick={pick(() => onOpen("account"))}>My account</button>
          {isAdmin && <button role="menuitem" onClick={pick(() => onOpen("users"))}>Users &amp; security</button>}
          <button role="menuitem" className="danger" onClick={pick(onSignOut)}>Sign out</button>
        </div>
      )}
    </div>
  );
}
