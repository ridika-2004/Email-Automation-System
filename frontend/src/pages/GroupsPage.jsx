import { useEffect, useState } from "react";
import { api, formatAmount } from "../api";

export default function GroupsPage({ uploadId, onNext }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState({}); // which partner rows are expanded

  useEffect(() => {
    api.getGroups(uploadId).then(setData).catch((e) => setError(e.message));
  }, [uploadId]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <p>Loading...</p>;

  const totalAmount = data.groups.reduce((sum, g) => sum + g.total_amount, 0);
  const toggle = (code) => setOpen({ ...open, [code]: !open[code] });

  return (
    <div className="page">
      <section className="card">
        <h2>Unknown-response transactions grouped by destination partner</h2>
        <p className="muted">
          {data.unknown_rows} of {data.valid_rows} valid transactions have an unknown response code,
          across {data.groups.length} partner(s). Click a partner to see its transactions.
        </p>

        <table className="table">
          <thead>
            <tr>
              <th></th>
              <th>Institution Code</th>
              <th>Partner</th>
              <th className="num">Transactions</th>
              <th className="num">Total Amount (BDT)</th>
              <th>Configured?</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((g) => (
              <GroupRows key={g.institution_code} group={g} isOpen={!!open[g.institution_code]} onToggle={() => toggle(g.institution_code)} />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td></td>
              <td colSpan={2}><b>Total</b></td>
              <td className="num"><b>{data.unknown_rows}</b></td>
              <td className="num"><b>{formatAmount(totalAmount)}</b></td>
              <td></td>
            </tr>
          </tfoot>
        </table>

        <button className="btn primary" onClick={onNext}>Prepare emails →</button>
      </section>
    </div>
  );
}

function GroupRows({ group, isOpen, onToggle }) {
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td>{isOpen ? "▾" : "▸"}</td>
        <td>{group.institution_code}</td>
        <td><b>{group.partner_name}</b></td>
        <td className="num">{group.txn_count}</td>
        <td className="num">{formatAmount(group.total_amount)}</td>
        <td>
          {group.partner_configured
            ? <span className="badge green">Yes</span>
            : <span className="badge red">Not configured</span>}
        </td>
      </tr>
      {isOpen && (
        <tr className="detail-row">
          <td></td>
          <td colSpan={5}>
            <table className="table compact">
              <thead>
                <tr>
                  <th>Date &amp; Time</th><th>RRN</th><th>STAN</th><th className="num">Amount</th>
                  <th>Source</th><th>Beneficiary</th><th>Type</th><th>Resp. Code</th><th>Nagad Status</th>
                </tr>
              </thead>
              <tbody>
                {group.transactions.map((t) => (
                  <tr key={t.excel_row}>
                    <td>{t.txn_datetime}</td>
                    <td>{t.rrn}</td>
                    <td>{t.stan}</td>
                    <td className="num">{formatAmount(t.amount)}</td>
                    <td className="mono">{t.source_account}</td>
                    <td className="mono">{t.beneficiary_account}</td>
                    <td>{t.txn_type}</td>
                    <td>{t.response_code}</td>
                    <td>{t.nagad_status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
