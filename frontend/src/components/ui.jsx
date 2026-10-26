// Shared building blocks, styled with Tailwind. Use these instead of repeating long class lists.

// Join class names, skipping empty ones: cx("a", cond && "b")
export const cx = (...classes) => classes.filter(Boolean).join(" ");

// ---------------------------------------------------------------- buttons

const BUTTON = {
  default: "border border-line bg-white text-ink hover:enabled:bg-gray-100",
  primary: "border border-brand bg-brand text-white hover:enabled:bg-brand-dark",
  grey: "border border-gray-300 bg-gray-200 text-gray-700 hover:enabled:bg-gray-300",
  // download buttons: grey, with an icon (see DownloadIcon)
  download:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-gray-300 bg-gray-100 px-4 py-[9px] text-[13px] font-semibold " +
    "text-gray-700 shadow-sm transition hover:enabled:border-gray-400 hover:enabled:bg-gray-200 hover:enabled:shadow " +
    "active:enabled:translate-y-px active:enabled:shadow-none focus-visible:outline focus-visible:outline-2 " +
    "focus-visible:outline-offset-2 focus-visible:outline-brand [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 " +
    "[&_svg]:text-gray-500 hover:[&_svg]:text-gray-700",
  // looks like a link
  link: "border-0 bg-transparent p-0 text-xs font-semibold text-brand hover:underline",
};
const SIZE = { md: "px-3.5 py-2 text-sm", sm: "px-2.5 py-1 text-xs" };

export function Button({ variant = "default", size = "md", className = "", ...props }) {
  const sized = variant === "download" || variant === "link" ? "" : SIZE[size];
  return (
    <button
      className={cx("cursor-pointer rounded-md disabled:cursor-not-allowed disabled:opacity-50", BUTTON[variant], sized, className)}
      {...props}
    />
  );
}

export function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

// ---------------------------------------------------------------- badges, alerts, cards

const BADGE = {
  green: "bg-green-100 text-green-800",
  red: "bg-red-100 text-red-800",
  blue: "bg-blue-100 text-blue-800",
  gray: "bg-gray-100 text-gray-600",
  amber: "bg-amber-100 text-amber-800",
};

export function Badge({ color = "gray", className = "", ...props }) {
  return <span className={cx("inline-block rounded-full px-2 py-0.5 text-xs font-semibold", BADGE[color], className)} {...props} />;
}

const ALERT = {
  error: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  success: "border-green-200 bg-green-50 text-green-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

// Message box. Lists inside get bullets.
export function Alert({ type = "info", className = "my-3", as: Tag = "div", ...props }) {
  return (
    <Tag className={cx("rounded-md border px-3.5 py-3 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5", ALERT[type], className)} {...props} />
  );
}

export function Card({ className = "", as: Tag = "section", ...props }) {
  return <Tag className={cx("rounded-lg border border-line bg-white p-[18px]", className)} {...props} />;
}

// Page section title (h2)
export const h2 = "mb-2 text-base font-bold";

// ---------------------------------------------------------------- form fields

export const input =
  "w-full rounded-md border border-line bg-white px-2.5 py-2 text-sm font-normal text-ink " +
  "focus:border-brand focus:shadow-focus focus:outline-none disabled:bg-gray-50";

// Label above its field
export const label = "flex flex-col gap-1 text-[13px] font-semibold";

// ---------------------------------------------------------------- tables

// Only the table's own cells are styled (nested tables keep theirs). Put `num` on number cells.
export const table =
  "my-3 w-full border-collapse " +
  "[&>thead>tr>th]:border-b [&>thead>tr>th]:border-line [&>thead>tr>th]:bg-gray-50 [&>thead>tr>th]:px-2.5 " +
  "[&>thead>tr>th]:py-2 [&>thead>tr>th]:text-left [&>thead>tr>th]:align-top [&>thead>tr>th]:text-xs " +
  "[&>thead>tr>th]:font-semibold [&>thead>tr>th]:uppercase [&>thead>tr>th]:text-muted " +
  "[&>tbody>tr>td]:border-b [&>tbody>tr>td]:border-line [&>tbody>tr>td]:px-2.5 [&>tbody>tr>td]:py-2 [&>tbody>tr>td]:align-top " +
  "[&>tfoot>tr>td]:border-t-2 [&>tfoot>tr>td]:border-line [&>tfoot>tr>td]:px-2.5 [&>tfoot>tr>td]:py-2";

export const tableCompact =
  "my-3 w-full border-collapse text-xs " +
  "[&>thead>tr>th]:border-b [&>thead>tr>th]:border-line [&>thead>tr>th]:bg-gray-50 [&>thead>tr>th]:px-2 " +
  "[&>thead>tr>th]:py-1.5 [&>thead>tr>th]:text-left [&>thead>tr>th]:font-semibold [&>thead>tr>th]:uppercase " +
  "[&>thead>tr>th]:text-muted [&>tbody>tr>td]:border-b [&>tbody>tr>td]:border-line [&>tbody>tr>td]:px-2 " +
  "[&>tbody>tr>td]:py-1.5 [&>tbody>tr>td]:align-top";

export const num = "!text-right";

// Clickable table row; `selected` highlights it
export const rowCls = (selected) => cx("cursor-pointer hover:bg-gray-50", selected && "!bg-rose-50");

// Cell of an expanded row (preview under a row)
export const expandedCell = "!bg-gray-50 !p-3 [&>*+*]:mt-3";

export const chevron = "w-6 text-sm text-muted";

// Page body: cards stacked with a gap
export const page = "flex flex-col gap-4";

// Class strings for places that can't use the components above
export const card = "rounded-lg border border-line bg-white p-[18px]";
export const btnCls = (variant = "default", size = "md") =>
  cx("cursor-pointer rounded-md disabled:cursor-not-allowed disabled:opacity-50", BUTTON[variant],
    variant === "download" || variant === "link" ? "" : SIZE[size]);
export const badge = (color = "gray") => cx("inline-block rounded-full px-2 py-0.5 text-xs font-semibold", BADGE[color]);
export const link = BUTTON.link + " cursor-pointer";

// Simple stacked form: labels above fields
export const formCls =
  "flex max-w-[560px] flex-col gap-3 [&_label]:flex [&_label]:flex-col [&_label]:gap-1 [&_label]:text-[13px] " +
  "[&_label]:font-semibold [&_small]:font-normal";
// Label holding a checkbox, inside `form`
export const checkLabel = "!flex-row items-center gap-1.5 !font-normal";
