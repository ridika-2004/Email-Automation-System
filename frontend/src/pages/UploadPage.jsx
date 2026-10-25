import { useState } from "react";
import { api } from "../api";

const REQUIRED_COLUMNS = [
  "Txn Datetime", "RRN", "STAN", "Amount", "Source Account", "Beneficiary Account",
  "Txn Type", "Response Code", "Nagad Status", "Dest Institution Code", "Dest Partner Name",
];

export default function UploadPage({ config, lastUpload, onUploaded, onNext }) {
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null); // { message, details[] }
  const [result, setResult] = useState(lastUpload);

  async function handleUpload(e) {
    e.preventDefault();
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await api.uploadFile(file);
      setResult(data);
      onUploaded(data);
    } catch (err) {
      setError({ message: err.message, details: err.details });
    } finally {
      setLoading(false);
    }
  }

  async function handleDownloadTemplate() {
    setError(null);
    try {
      await api.downloadTemplate();
    } catch (err) {
      setError({ message: err.message });
    }
  }

  async function handleDownloadRows(kind) {
    setError(null);
    const base = result.filename.replace(/\.(xlsx|csv)$/i, "");
    const suffix = kind === "valid" ? "successful" : "skipped";
    try {
      await api.downloadRows(result.upload_id, kind, `${base}_${suffix}.xlsx`);
    } catch (err) {
      setError({ message: err.message });
    }
  }

  return (
    <div className="page">
      <section className="card">
        <h2>Upload dispute transactions file</h2>
        <p className="muted">
          Accepted formats: <b>.xlsx</b> or <b>.csv</b>.
        </p>
        <p className="muted">Required columns:</p>
        <div className="chips">
          {REQUIRED_COLUMNS.map((c) => <span key={c} className="chip">{c}</span>)}
        </div>
        {config && (
          <p className="muted small">
            Response codes treated as <b>unknown</b>: {config.unknown_response_codes.join(", ")}
          </p>
        )}

        <div className="template-download">
          <button type="button" className="btn" onClick={handleDownloadTemplate}>
            Download sample template (.xlsx)
          </button>
        </div>

        <form onSubmit={handleUpload} className="upload-form">
          <input
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => setFile(e.target.files[0] || null)}
          />
          <button className="btn primary" disabled={!file || loading}>
            {loading ? "Uploading..." : "Upload & Validate"}
          </button>
        </form>
      </section>

      {error && (
        <section className="alert error">
          <b>{error.message}</b>
          {error.details?.length > 0 && (
            <ul>{error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
          )}
        </section>
      )}

      {result && (
        <section className="card">
          <h2>Validation result — {result.filename}</h2>
          <div className="stats">
            <Stat label="Rows in file" value={result.total_rows} />
            <Stat label="Valid rows" value={result.valid_rows} />
            <Stat label="Unknown response" value={result.unknown_rows} highlight />
            <div className="stat-with-action">
              <Stat label="Skipped (errors)" value={result.skipped_rows ?? 0} danger={result.skipped_rows > 0} />
              {result.skipped_rows > 0 && (
                <button type="button" className="btn grey" onClick={() => handleDownloadRows("faulty")}>
                  Download skipped transactions
                </button>
              )}
            </div>
          </div>

          {result.row_errors?.length > 0 && (
            <div className="alert warning">
              <b>{result.row_errors.length} row(s) were skipped. All other rows were imported.</b>
              <table className="table compact">
                <thead><tr><th>Excel Row</th><th>RRN</th><th>Problem</th></tr></thead>
                <tbody>
                  {result.row_errors.map((r) => (
                    <tr key={r.row}>
                      <td>{r.row}</td>
                      <td>{r.rrn || "—"}</td>
                      <td>{r.errors.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button className="btn primary" onClick={onNext}>View grouped transactions →</button>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, highlight, danger }) {
  return (
    <div className={`stat ${highlight ? "highlight" : ""} ${danger ? "danger" : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
