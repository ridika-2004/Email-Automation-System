import { useState } from "react";
import { api } from "../api";
import { Alert, DownloadIcon, btnCls, card, cx, h2, page, tableCompact } from "../components/ui";

// The "Final_Report_for_DMS_Claim" format (same as backend/app/excel_parser.py REQUIRED_COLUMNS)
const REQUIRED_COLUMNS = [
  "NPSB_TXN_RRN", "APPROVAL_DATE", "APPROVAL_DATETIME", "TXN_TYPE", "TXN_ID", "FIRST_TXN_STATUS_NAME",
  "TXN_AMOUNT", "FROMAC_NAME", "TOAC_TYPE", "ORG_TXN_STAN", "KEY_ORG_NM", "NPSB_ORG_CODE", "TXN_DIRECTION",
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
    <div className={page}>
      <section className={card}>
        <h2 className={h2}>Upload dispute transactions file</h2>
        <p className="text-muted">
          Accepted formats: <b>.xlsx</b> or <b>.csv</b>.
        </p>
        <p className="text-muted">Required columns:</p>
        <div className="my-2 flex flex-wrap gap-1.5">
          {REQUIRED_COLUMNS.map((c) => <span key={c} className="rounded-xl border border-line bg-gray-100 px-2.5 py-[3px] text-xs">{c}</span>)}
        </div>
        <p className="text-xs text-muted">
          <b>KEY_ORG_NM</b> is the partner (matched by name to Partner Configuration). <b>TXN_DIRECTION</b> picks the
          email: <b>Inward</b> or <b>Outward</b> (a dropdown in the sample template). NPSB_TXN_RRN, TXN_AMOUNT, KEY_ORG_NM,
          TXN_DIRECTION and a date are needed in every row; an RRN may appear only once.
        </p>

        <div className="mt-3.5">
          <button type="button" className={btnCls("download")} onClick={handleDownloadTemplate}>
            <DownloadIcon /> Download sample template (.xlsx)
          </button>
        </div>

        <form onSubmit={handleUpload} className="mt-3.5 flex items-center gap-3">
          <input
            className="rounded-md border border-dashed border-slate-300 bg-gray-50 p-2"
            type="file"
            accept=".xlsx,.csv"
            onChange={(e) => setFile(e.target.files[0] || null)}
          />
          <button className={btnCls("primary")} disabled={!file || loading}>
            {loading ? "Uploading..." : "Upload & Validate"}
          </button>
        </form>
      </section>

      {error && (
        <Alert as="section" type="error" className="">
          <b>{error.message}</b>
          {error.details?.length > 0 && (
            <ul>{error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
          )}
        </Alert>
      )}

      {result && (
        <section className={card}>
          <h2 className={h2}>Validation result — {result.filename}</h2>
          <div className="my-3 flex flex-wrap items-start gap-3">
            <Stat label="Rows in file" value={result.total_rows} />
            <div className="flex min-w-[140px] flex-1 flex-col gap-2 [&>button]:w-full">
              <Stat label="Valid rows" value={result.valid_rows} />
              {result.valid_rows > 0 && (
                <button type="button" className={btnCls("download")} onClick={() => handleDownloadRows("valid")}
                  title="Download the valid rows as an Excel file">
                  <DownloadIcon /> Successful transactions
                </button>
              )}
            </div>
            <div className="flex min-w-[140px] flex-1 flex-col gap-2 [&>button]:w-full">
              <Stat label="Inward / Outward" value={`${result.inward_rows} / ${result.outward_rows}`} highlight />
              {result.skipped_rows > 0 && (
                <button type="button" className={btnCls("download")} onClick={() => handleDownloadRows("faulty")}
                  title="Download the skipped rows as an Excel file">
                  <DownloadIcon /> Skipped transactions
                </button>
              )}
            </div>
            <Stat label="Skipped (errors)" value={result.skipped_rows ?? 0} danger={result.skipped_rows > 0} />
          </div>

          {result.row_errors?.length > 0 && (
            <Alert type="warning">
              <b>{result.row_errors.length} row(s) were skipped. All other rows were imported.</b>
              <table className={tableCompact}>
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
            </Alert>
          )}

          <button className={btnCls("primary")} onClick={onNext}>View grouped transactions →</button>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, highlight, danger }) {
  return (
    <div className="min-w-[140px] flex-1 rounded-lg border border-line p-3">
      <div className={cx("text-2xl font-bold", highlight && "text-brand", danger && "text-amber-700")}>{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </div>
  );
}
