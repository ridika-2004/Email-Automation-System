import { useEffect, useRef } from "react";
import { cx } from "./ui";

// Showing and editing email HTML inside the app (previews, templates, follow-ups).
// The HTML itself keeps its inline styles: that is what email clients read when it is sent.

// Looks like the email as sent: the backend's BODY_WRAP and paragraph spacing
export const emailBody = "bg-white p-3 font-[Arial,sans-serif] text-[14px] leading-[1.45] text-[#222] [&_p]:mb-3";

// Email HTML comes from users (templates, edits) and partners (replies): drop anything that could run
// in the app (scripts, event handlers, javascript: links) before it is shown. DOMParser never runs
// scripts itself. external: links open in a new tab (read-only views), not in place of the app.
export function sanitize(html, { external = false } = {}) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  doc.body.querySelectorAll("script,style,iframe,frame,object,embed,link,meta,base,form,input,button,textarea,select,svg,math")
    .forEach((el) => el.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    for (const { name, value } of [...el.attributes]) {
      if (/^on/i.test(name) || (/^(href|src|action|formaction|xlink:href)$/i.test(name) && /^\s*(javascript|vbscript|data):/i.test(value))) {
        el.removeAttribute(name);
      }
    }
  });
  if (external) {
    doc.body.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
  }
  return doc.body.innerHTML;
}

// Read-only email body. [contain:paint] keeps it inside its box: a reply's position:fixed styles
// can't cover the app.
export function EmailView({ html, className = "" }) {
  return (
    <div className={cx(emailBody, "overflow-y-auto rounded-md border border-line [contain:paint]", className)}
      dangerouslySetInnerHTML={{ __html: sanitize(html, { external: true }) }} />
  );
}

// Editable email body (WYSIWYG). `html` is loaded when it mounts; every change goes to onChange.
// Ctrl+B / Ctrl+I / Ctrl+U work as in any editor; Enter starts a new paragraph.
export function EmailEditor({ html, onChange, onFocus, editorRef, className = "", label = "Email body" }) {
  const own = useRef(null);
  const ref = editorRef || own;

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = sanitize(html);
  }, []);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      className={cx(emailBody, "overflow-y-auto rounded-md border border-line outline outline-2 -outline-offset-1 outline-brand", className)}
      onFocus={() => {
        document.execCommand("defaultParagraphSeparator", false, "p");
        onFocus?.();
      }}
      onInput={(e) => onChange(e.currentTarget.innerHTML)}
    />
  );
}
