import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";

// Left sidebar with every page and the user settings. Hidden by default: moving the mouse to the
// left edge of the screen shows an arrow, and pointing at (or clicking) the arrow slides the
// sidebar in. It slides out again when the mouse leaves it, unless it is pinned.
// On touch screens the arrow is always visible.

const PIN_KEY = "npsb:sidebar-pinned";
const OPEN_DELAY = 120;  // ms on the arrow before the sidebar opens (so passing over it doesn't)
const CLOSE_DELAY = 350; // ms after the mouse leaves before it closes

const readPinned = () => { try { return localStorage.getItem(PIN_KEY) === "1"; } catch { return false; } };
const savePinned = (v) => { try { localStorage.setItem(PIN_KEY, v ? "1" : "0"); } catch { /* not saved */ } };

// sections: [{ title, items: [{ id, label, icon, disabled, hint, sub, onClick, danger }] }]
export function useSidebarPin() {
  const [pinned, setPinned] = useState(readPinned);
  const toggle = () => setPinned((p) => { savePinned(!p); return !p; });
  return [pinned, toggle];
}

export default function Sidebar({ sections, active, onSelect, user, footer, pinned, onTogglePin }) {
  const [open, setOpen] = useState(false);
  const timer = useRef(null);
  const panel = useRef(null);
  const visible = open || pinned;

  const later = (fn, ms) => { clearTimeout(timer.current); timer.current = setTimeout(fn, ms); };
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);

  useEffect(() => {
    if (!open || pinned) return;
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    panel.current?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKey);
  }, [open, pinned]);

  function pick(item) {
    if (item.disabled) return;
    if (item.onClick) item.onClick();
    else onSelect(item.id);
    if (!pinned) setOpen(false);
  }

  return (
    <>
      {/* Left edge: hovering it reveals the arrow */}
      {!pinned && (
        <div className="group fixed inset-y-0 left-0 z-30 w-5" aria-hidden={visible}>
          <button
            type="button"
            aria-label="Open menu"
            title="Menu"
            className={cx(
              "absolute left-0 top-1/2 flex h-14 w-6 -translate-y-1/2 items-center justify-center rounded-r-lg",
              "border border-l-0 border-line bg-white text-muted shadow-menu transition-opacity duration-150",
              "hover:bg-brand hover:text-white focus-visible:opacity-100 focus-visible:outline-none",
              "group-hover:opacity-100 [@media(hover:none)]:opacity-100",
              visible ? "pointer-events-none opacity-0" : "opacity-0",
            )}
            onMouseEnter={() => later(() => setOpen(true), OPEN_DELAY)}
            onMouseLeave={cancel}
            onClick={() => { cancel(); setOpen(true); }}
          >
            <Icon name="chevronRight" className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Dim the page while the sidebar floats over it */}
      {open && !pinned && (
        <div className="fixed inset-0 z-30 bg-gray-900/10" onClick={() => setOpen(false)} aria-hidden="true" />
      )}

      <aside
        ref={panel}
        aria-label="Main menu"
        aria-hidden={!visible}
        inert={visible ? undefined : ""}
        className={cx(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-line bg-white transition-transform duration-200 ease-out",
          visible ? "translate-x-0" : "-translate-x-full",
          open && !pinned && "shadow-modal",
        )}
        onMouseEnter={cancel}
        onMouseLeave={() => { if (!pinned) later(() => setOpen(false), CLOSE_DELAY); }}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white" aria-hidden="true">
            <Icon name="mail" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-bold">NPSB Dispute Email</div>
            <div className="text-[11px] text-muted">Automation</div>
          </div>
          <button
            type="button"
            className={cx("rounded-md p-1.5 hover:bg-gray-100", pinned ? "text-brand" : "text-muted")}
            title={pinned ? "Unpin: hide the menu when not in use" : "Pin: keep the menu open"}
            aria-pressed={pinned}
            onClick={() => { onTogglePin(); setOpen(false); }}
          >
            <Icon name={pinned ? "pinOff" : "pin"} className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 py-3">
          {sections.map((section) => (
            <div key={section.title} className="mb-4 last:mb-0">
              <div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{section.title}</div>
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={item.disabled}
                      title={item.disabled ? item.hint : undefined}
                      aria-current={active === item.id ? "page" : undefined}
                      onClick={() => pick(item)}
                      className={cx(
                        "flex w-full items-center gap-2.5 rounded-md py-2 pr-2.5 text-left text-[13px] transition-colors",
                        item.sub ? "pl-9 text-[12.5px]" : "pl-2.5",
                        "disabled:cursor-not-allowed disabled:opacity-40",
                        active === item.id
                          ? "bg-rose-50 font-semibold text-brand"
                          : item.danger ? "text-red-700 hover:bg-red-50" : "text-ink hover:enabled:bg-gray-100",
                      )}
                    >
                      {item.icon && <Icon name={item.icon} className="h-4 w-4 shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {item.badge != null && (
                        <span className="rounded-full bg-gray-100 px-1.5 text-[11px] font-semibold text-muted">{item.badge}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-line px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-[13px] font-bold text-white" aria-hidden="true">
              {(user.full_name || user.username)[0].toUpperCase()}
            </span>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[13px] font-semibold">{user.full_name || user.username}</div>
              <div className="truncate text-[11px] text-muted">
                {user.role === "admin" ? "Admin" : "User"} · {user.email || user.username}
              </div>
            </div>
          </div>
          {footer && <div className="mt-2 text-[11px] text-muted">{footer}</div>}
        </div>
      </aside>
    </>
  );
}

const ICONS = {
  chevronRight: <path d="m9 6 6 6-6 6" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  home: <><path d="M3 11 12 4l9 7" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>,
  upload: <><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13 7 4 4" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  send: <><path d="M21 3 10 14" /><path d="m21 3-7 18-4-7-7-4 18-7Z" /></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" /></>,
  template: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  sliders: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></>,
  shield: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  logout: <><path d="M15 4h4v16h-4" /><path d="M10 8l-4 4 4 4" /><path d="M6 12h10" /></>,
  pin: <><path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z" /><path d="M12 13v7" /></>,
  pinOff: <><path d="M9 4h6l-1 6 3 3H7l3-3-1-6Z" /><path d="M12 13v7" /><path d="M4 4l16 16" /></>,
};

export function Icon({ name, className = "" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" className={className} aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}
