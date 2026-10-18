import { useEffect, useState } from "react";
import { api } from "./api";
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

export default function App() {
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
        {config && (
          <div className="smtp-badge" title="Emails go to this SMTP server">
            SMTP: {config.smtp_host}:{config.smtp_port}
          </div>
        )}
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
      </main>
    </div>
  );
}
