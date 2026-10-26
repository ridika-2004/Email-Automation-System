import { useEffect, useState } from "react";
import { api, formatAmount } from "../api";
import MailTypeBadge from "../components/MailTypeBadge";
import { Alert, badge, btnCls, card, h2, num, page, table, tableCompact } from "../components/ui";

export default function GroupsPage({ uploadId, onNext }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState({}); // which partner rows are expanded

  useEffect(() => {
    api.getGroups(uploadId).then(setData).catch((e) => setError(e.message));
  }, [uploadId]);

  if (error) return <Alert type="error">{error}</Alert>;
  if (!data) return <p>Loading...</p>;

  const totalAmount = data.groups.reduce((sum, g) => sum + g.total_amount, 0);
  const totalCount = data.groups.reduce((sum, g) => sum + g.txn_count, 0);
  const keyOf = (g) => g.key;
  const toggle = (key) => setOpen({ ...open, [key]: !open[key] });

  return (
    <div className={page}>
      <section className={card}>
        <h2 className={h2}>Transactions grouped by partner and mail type</h2>
        <p className="text-muted">
          {totalCount} of {data.valid_rows} valid transactions, in {data.groups.length} group(s). Each group becomes one
          email, written from its TXN_DIRECTION template (Inward / Outward). Click a group to see its transactions.
        </p>

        <table className={table}>
          <thead>
            <tr>
              <th></th>
              <th>Partner (KEY_ORG_NM)</th>
              <th>Mail Type</th>
              <th className={num}>Transactions</th>
              <th className={num}>Total Amount (BDT)</th>
              <th>Configured?</th>
            </tr>
          </thead>
          <tbody>
            {data.groups.map((g) => (
              <GroupRows key={keyOf(g)} group={g} isOpen={!!open[keyOf(g)]} onToggle={() => toggle(keyOf(g))} />
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td></td>
              <td colSpan={2}><b>Total</b></td>
              <td className={num}><b>{totalCount}</b></td>
              <td className={num}><b>{formatAmount(totalAmount)}</b></td>
              <td></td>
            </tr>
          </tfoot>
        </table>

        <button className={btnCls("primary")} onClick={onNext}>Prepare emails →</button>
      </section>
    </div>
  );
}

function GroupRows({ group, isOpen, onToggle }) {
  return (
    <>
      <tr className="cursor-pointer hover:bg-gray-50" onClick={onToggle}>
        <td>{isOpen ? "▾" : "▸"}</td>
        <td><b>{group.partner_name}</b></td>
        <td><MailTypeBadge type={group.mail_type} /></td>
        <td className={num}>{group.txn_count}</td>
        <td className={num}>{formatAmount(group.total_amount)}</td>
        <td>
          {group.partner_configured
            ? <span className={badge("green")}>Yes</span>
            : <span className={badge("red")}>Not configured</span>}
        </td>
      </tr>
      {isOpen && (
        <tr className="[&>td]:!bg-gray-50">
          <td></td>
          <td colSpan={5}>
            <table className={tableCompact}>
              <thead>
                <tr>
                  <th>RRN</th><th>Approval date &amp; time</th><th>Txn type</th><th>Txn ID</th><th>Status</th>
                  <th className={num}>Amount</th><th>From account</th><th>To account type</th><th>STAN</th><th>Org code</th>
                </tr>
              </thead>
              <tbody>
                {group.transactions.map((t) => (
                  <tr key={t.excel_row}>
                    <td className="font-mono">{t.rrn}</td>
                    <td className="whitespace-nowrap">{t.approval_datetime}</td>
                    <td>{t.txn_type}</td>
                    <td className="font-mono">{t.txn_id || "—"}</td>
                    <td>{t.status}</td>
                    <td className={num}>{formatAmount(t.amount)}</td>
                    <td>{t.from_account_name || "—"}</td>
                    <td>{t.to_account_type || "—"}</td>
                    <td className="font-mono">{t.stan}</td>
                    <td className="font-mono">{t.org_code}</td>
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
