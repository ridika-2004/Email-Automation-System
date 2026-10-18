import { useEffect, useState } from "react";
import { api, formatAmount } from "../api";

export default function EmailsPage({ uploadId, config }) {
  const [emails, setEmails] = useState([]);
  const [warnings, setWarnings] = useState([]);   // partners that got no email
  const [selectedId, setSelectedId] = useState(null);
  const [busy, setBusy] = useState("");            // "preparing" | "sending" | ""
  const [message, setMessage] = useState(null);    // { type, text }

  // Every time this page opens, (re)build the previews from the current partner config
  useEffect(() => {
    prepare();
  }, [uploadId]);

  async function prepare() {
    setBusy("preparing");
    setMessage(null);
    try {
      const data = await api.prepareEmails(uploadId);
      setEmails(data.emails);
      setWarnings(data.errors);
      setSelectedId((id) => id ?? data.emails[0]?.id ?? null);
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  async function send() {
    const count = emails.filter((e) => e.status !== "SENT").length;
    if (!window.confirm(`Send ${count} email(s) now?`)) return;
    setBusy("sending");
    setMessage(null);
    try {
      const data = await api.sendEmails(uploadId);
      setEmails(data.emails);
      setMessage({
        type: data.failed ? "warning" : "success",
        text: `${data.sent} email(s) sent successfully, ${data.failed} failed.`,
      });
    } catch (e) {
      setMessage({ type: "error", text: e.message });
    } finally {
      setBusy("");
    }
  }

  const selected = emails.find((e) => e.id === selectedId);
  const pendingCount = emails.filter((e) => e.status !== "SENT").length;

  return (
    <div className="page">
      <section className="card">
        <div className="row-between">
          <div>
            <h2>Prepared emails ({emails.length})</h2>
            <p className="muted small">
              One consolidated email per partner. Sending through test SMTP{" "}
              <b>{config ? `${config.smtp_host}:${config.smtp_port}` : ""}</b>.
            </p>
          </div>
          <div className="actions">
            <button className="btn" onClick={prepare} disabled={!!busy}>
              {busy === "preparing" ? "Refreshing..." : "Refresh previews"}
            </button>
            <button className="btn primary" onClick={send} disabled={!!busy || pendingCount === 0}>
              {busy === "sending" ? "Sending..."
                : pendingCount === 0 && emails.length ? "All emails sent"
                : `Send ${pendingCount} email(s)`}
            </button>
          </div>
        </div>

        {message && <div className={`alert ${message.type}`}>{message.text}</div>}

        {warnings.length > 0 && (
          <div className="alert error">
            <b>No email was prepared for these partners:</b>
            <ul>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            <span className="small">Fix them in Partner Configuration, then click “Refresh previews”.</span>
          </div>
        )}

        <table className="table">
          <thead>
            <tr>
              <th>Partner</th><th>To</th><th className="num">Txns</th>
              <th className="num">Amount (BDT)</th><th>Status</th><th>Details</th>
            </tr>
          </thead>
          <tbody>
            {emails.map((e) => (
              <tr
                key={e.id}
                className={`clickable ${e.id === selectedId ? "selected" : ""}`}
                onClick={() => setSelectedId(e.id)}
              >
                <td><b>{e.partner_name}</b> <span className="muted">({e.institution_code})</span></td>
                <td className="small">{e.to.join(", ")}</td>
                <td className="num">{e.txn_count}</td>
                <td className="num">{formatAmount(e.total_amount)}</td>
                <td><StatusBadge status={e.status} /></td>
                <td className="small">
                  {e.status === "SENT" && `Sent ${new Date(e.sent_at).toLocaleString()}`}
                  {e.status === "FAILED" && <span className="text-red">{e.error}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selected && (
        <section className="card">
          <h2>Email preview — {selected.partner_name}</h2>
          <div className="email-meta">
            <div><span>From</span>{config?.mail_from}</div>
            <div><span>To</span>{selected.to.join(", ")}</div>
            <div><span>CC</span>{selected.cc.join(", ")}</div>
            <div><span>Subject</span><b>{selected.subject}</b></div>
          </div>
          {/* iframe keeps the email's own styling separate from the app */}
          <iframe className="email-body" title="Email body" srcDoc={selected.body_html} sandbox="" />
        </section>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const color = { SENT: "green", FAILED: "red", PREPARED: "blue" }[status] || "gray";
  return <span className={`badge ${color}`}>{status}</span>;
}
