import { useEffect, useState } from "react";
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
import EmailConfigPage from "./pages/EmailConfigPage";
import TemplatesPage from "./pages/TemplatesPage";
import AdminHomePage from "./pages/AdminHomePage";
import Sidebar, { useSidebarPin } from "./components/Sidebar";
import { cx } from "./components/ui";

// Title and one-line description shown at the top of each page
const PAGES = {
  home: { title: "Home", subtitle: "Upload a dispute file to prepare one email per partner and mail type" },
  adminHome: { title: "Home", subtitle: "What needs your attention today" },
  groups: { title: "Grouped Transactions", subtitle: "Transactions of the uploaded file, grouped by partner and mail type" },
  emails: { title: "Email Preview & Send", subtitle: "Check and edit each partner's email, then send them for approval" },
  pending: { title: "Pending Mails", subtitle: "Emails waiting for an admin to send them" },
  sent: { title: "Sent Mails", subtitle: "Emails sent to partners, their replies and follow-ups" },
  partners: { title: "Partner Configuration", subtitle: "Partners and the addresses their emails go to" },
  templates: { title: "Email Templates", subtitle: "Your templates for each case: pick one for each partner's email" },
  emailConfig: { title: "Email Configuration", subtitle: "Follow-up timing, automatic follow-ups, recipients and the mail server" },
  account: { title: "My Profile", subtitle: "Your details, password, devices and sign-in activity" },
  users: { title: "Users & Security", subtitle: "Accounts, roles and the security log" },
};

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

  if (checking) return <div className="flex min-h-screen items-center justify-center text-muted">Loading...</div>;
  if (!user) {
    return <AuthPage key={notice} notice={notice} onSignedIn={(u) => { setUser(u); setNotice(""); }} />;
  }
  return <MainApp user={user} onUserChange={setUser} onSignOut={signOut} />;
}

function MainApp({ user, onUserChange, onSignOut }) {
  const isAdmin = user.role === "admin";
  const [tab, setTab] = useState(isAdmin ? "adminHome" : "home");
  const [upload, setUpload] = useState(null); // result of the last successful upload
  const [config, setConfig] = useState(null);
  const [pinned, togglePin] = useSidebarPin();

  const loadConfig = () => api.getConfig().then(setConfig).catch(() => setConfig(null));
  useEffect(() => { loadConfig(); }, []);

  const open = (id) => { setTab(id); window.scrollTo({ top: 0 }); };
  const noUpload = { disabled: !upload, hint: "Upload a file first" };

  // Users prepare the emails; admins send them from Pending Mails and manage partners and users
  const sections = [
    {
      title: "Workspace",
      items: isAdmin
        ? [{ id: "adminHome", label: "Home", icon: "home" }]
        : [
          { id: "home", label: "Home", icon: "home" },
          { id: "groups", label: "Grouped Transactions", icon: "layers", sub: true, ...noUpload },
          { id: "emails", label: "Email Preview & Send", icon: "edit", sub: true, ...noUpload },
        ],
    },
    {
      title: "Mails",
      items: [
        { id: "pending", label: "Pending Mails", icon: "clock" },
        { id: "sent", label: "Sent Mails", icon: "send" },
      ],
    },
    {
      title: "Configuration",
      items: [
        { id: "partners", label: "Partner Configuration", icon: "building" },
        // users write the emails, so the templates are theirs
        ...(isAdmin ? [] : [{ id: "templates", label: "Email Templates", icon: "template" }]),
        { id: "emailConfig", label: "Email Configuration", icon: "sliders" },
      ],
    },
    {
      title: "User Settings",
      items: [
        { id: "account", label: "My Profile", icon: "user" },
        ...(isAdmin ? [{ id: "users", label: "Users & Security", icon: "shield" }] : []),
        { id: "signout", label: "Sign out", icon: "logout", danger: true, onClick: () => onSignOut() },
      ],
    },
  ];

  const info = PAGES[tab];

  return (
    <div className={cx("min-h-screen transition-[padding] duration-200", pinned && "min-[900px]:pl-64")}>
      <Sidebar
        sections={sections}
        active={tab}
        onSelect={open}
        user={user}
        pinned={pinned}
        onTogglePin={togglePin}
        title={info.title}
        footer={config && <span title="Emails go to this SMTP server">SMTP {config.smtp_host}:{config.smtp_port}</span>}
      />

      <div className="mx-auto max-w-[1200px] px-4 pb-10 min-[640px]:px-8">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-2 border-b border-line pb-3.5 pt-6 max-[640px]:mb-3.5 max-[640px]:pt-4">
          <div>
            <h1 className="text-xl font-bold">{info.title}</h1>
            <p className="mt-1 text-muted">{info.subtitle}</p>
          </div>
          {upload && !isAdmin && ["home", "groups", "emails"].includes(tab) && (
            <span className="rounded-md border border-line bg-white px-2.5 py-1.5 text-xs text-muted">
              Current file: <b className="text-ink">{upload.filename}</b> (#{upload.upload_id})
            </span>
          )}
        </header>

        <main>
          {tab === "adminHome" && isAdmin && <AdminHomePage onOpen={open} />}
          {tab === "home" && !isAdmin && (
            <UploadPage config={config} lastUpload={upload} onUploaded={setUpload} onNext={() => open("groups")} />
          )}
          {tab === "groups" && upload && !isAdmin && <GroupsPage uploadId={upload.upload_id} onNext={() => open("emails")} />}
          {tab === "emails" && upload && !isAdmin && (
            <EmailsPage uploadId={upload.upload_id} config={config} onOpenPending={() => open("pending")} />
          )}
          {tab === "pending" && <PendingPage config={config} isAdmin={isAdmin} />}
          {tab === "sent" && <SentPage config={config} isAdmin={isAdmin} />}
          {tab === "partners" && <PartnersPage isAdmin={isAdmin} />}
          {tab === "templates" && !isAdmin && <TemplatesPage />}
          {tab === "emailConfig" && <EmailConfigPage isAdmin={isAdmin} onSaved={loadConfig} />}
          {tab === "account" && <AccountPage user={user} onUserChange={onUserChange} onSignedOut={onSignOut} />}
          {tab === "users" && isAdmin && <UsersPage currentUser={user} />}
        </main>
      </div>
    </div>
  );
}
