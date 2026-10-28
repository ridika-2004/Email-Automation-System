import { useEffect } from "react";
import { cx } from "./ui";

// Pop-up dialog. Closes on Escape or a click outside the box.
export default function Modal({ title, children, actions, onClose, wide = false }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-900/45 p-4 max-[640px]:p-2"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cx("w-full rounded-[10px] bg-white p-[22px] shadow-modal max-[640px]:p-4", "max-h-[92vh] overflow-y-auto", wide ? "max-w-[860px]" : "max-w-[480px]")}
        role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <h2 id="modal-title" className="mb-2.5 text-base font-bold">{title}</h2>
        <div className="[&_p]:my-1.5 [&_p]:break-words">{children}</div>
        <div className="mt-[18px] flex flex-wrap items-center justify-end gap-2">{actions}</div>
      </div>
    </div>
  );
}
