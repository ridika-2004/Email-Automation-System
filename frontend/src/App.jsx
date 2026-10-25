import { useEffect, useRef, useState } from "react";
import { api, auth, SESSION_EXPIRED_EVENT } from "./api";
import AuthPage from "./pages/AuthPage";
import AccountPage from "./pages/AccountPage";
import UsersPage from "./pages/UsersPage";
import UploadPage from "./pages/UploadPage";
import GroupsPage from "./pages/GroupsPage";
import EmailsPage from "./pages/EmailsPage";
import PartnersPage from "./pages/PartnersPage";

const TABS = [
  { id: "upload", label: "1. Upload File" },
  { id: "groups", label: "2. Grouped Transactions" },
  { id: "emails", label: "3. Email Preview & Send" },
  { id: "partners", label: "Partner Configuration" },
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
  const [tab, setTab] = useState("upload");
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
          <UserMenu user={user} onOpen={setTab} onSignOut={() => onSignOut()} />
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
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
        <button className={tab === "users" ? "tab active" : "tab"} onClick={() => setTab("users")}>
          Users &amp; Security
        </button>
        {upload && <span className="current-file">Current file: {upload.filename} (#{upload.upload_id})</span>}
      </nav>

      <main>
        {tab === "upload" && (
          <UploadPage
            config={config}
            lastUpload={upload}
            onUploaded={setUpload}
            onNext={() => setTab("groups")}
          />
        )}
        {tab === "groups" && upload && <GroupsPage uploadId={upload.upload_id} onNext={() => setTab("emails")} />}
        {tab === "emails" && upload && <EmailsPage uploadId={upload.upload_id} config={config} />}
        {tab === "partners" && <PartnersPage />}
        {tab === "account" && <AccountPage user={user} onUserChange={onUserChange} onSignedOut={onSignOut} />}
        {tab === "users" && <UsersPage currentUser={user} />}
      </main>
    </div>
  );
}

function UserMenu({ user, onOpen, onSignOut }) {
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
          <button role="menuitem" onClick={pick(() => onOpen("users"))}>Users &amp; security</button>
          <button role="menuitem" className="danger" onClick={pick(onSignOut)}>Sign out</button>
        </div>
      )}
    </div>
  );
}
