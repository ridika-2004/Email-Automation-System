import { cx } from "./ui";

// Inward / Outward Transaction: the row's TXN_DIRECTION, which picks the email template.
// ("Outward Reminder" only on emails from before TXN_DIRECTION; reminders are follow-ups now.)
export const MAIL_TYPE_LABELS = {
  inward: "Inward Transaction",
  outward: "Outward Transaction",
  outward_reminder: "Outward Reminder",
};

const COLORS = {
  inward: "border-teal-200 bg-teal-100 text-teal-800",
  outward: "border-violet-200 bg-violet-100 text-violet-800",
  outward_reminder: "border-amber-200 bg-amber-100 text-amber-800",
};

export default function MailTypeBadge({ type, className = "" }) {
  return (
    <span className={cx("inline-block whitespace-nowrap rounded border px-2 py-0.5 align-middle text-[11px] font-semibold",
      COLORS[type] || "border-gray-200 bg-gray-100 text-gray-700", className)}>
      {MAIL_TYPE_LABELS[type] || type}
    </span>
  );
}
