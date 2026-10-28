import { useEffect, useState } from "react";
import { api, formatDateTime } from "../api";
import { Alert, btnCls, card, cx, h2, page } from "../components/ui";

// Admins' start page: what is waiting for them, with a shortcut to each page
export default function AdminHomePage({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api.pendingEmails(), api.sentSummary(), api.emailSettings()])
      .then(([pending, summary, settings]) => setData({ pending, summary, settings }))
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <Alert type="error">{error}</Alert>;
  if (!data) return <p className="text-muted">Loading...</p>;

  const { pending, summary, settings } = data;
  const failed = pending.filter((e) => e.status === "FAILED").length;
  const auto = settings.auto_followup_enabled;

  const tiles = [
    { label: "Waiting to be sent", value: pending.length - failed, note: "Sent for approval by users", page: "pending" },
    { label: "Failed to send", value: failed, note: "Check the error and send again", page: "pending", tone: failed && "red" },
    { label: "Follow-up due", value: summary.due, note: `No reply for ${summary.due_after_days}+ days`, page: "sent", tone: summary.due && "amber" },
    { label: "Awaiting reply", value: summary.not_received, note: `${summary.total} sent in total`, page: "sent" },
  ];

  return (
    <div className={page}>
      <div className="grid grid-cols-2 gap-3 min-[900px]:grid-cols-4">
        {tiles.map((t) => (
          <button key={t.label} onClick={() => onOpen(t.page)}
            className={cx(card, "text-left transition hover:border-gray-300 hover:shadow-card")}>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">{t.label}</div>
            <div className={cx("mt-1.5 text-[28px] font-bold leading-none",
              t.tone === "red" ? "text-red-700" : t.tone === "amber" ? "text-amber-700" : "text-ink")}>
              {t.value}
            </div>
            <div className="mt-1.5 text-xs text-muted">{t.note}</div>
          </button>
        ))}
      </div>

      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-[1_1_320px]">
            <h2 className={h2}>Automatic follow-ups</h2>
            <p className="text-muted">
              {auto
                ? <>On: emails with no reply for <b className="text-ink">{settings.followup_due_days} day(s)</b> get a follow-up automatically,
                  up to {settings.auto_followup_max} per email.</>
                : <>Off: follow-ups are only sent by hand from Sent Mails. Emails are marked due after {settings.followup_due_days} day(s).</>}
            </p>
            {settings.auto_status.last_run_at && (
              <p className="mt-1 text-xs text-muted">Last check {formatDateTime(settings.auto_status.last_run_at)}</p>
            )}
          </div>
          <button className={btnCls("default")} onClick={() => onOpen("emailConfig")}>Email configuration</button>
        </div>
      </section>
    </div>
  );
}
