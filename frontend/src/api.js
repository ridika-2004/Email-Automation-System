// Tiny helper around fetch. Every function returns the JSON body
// or throws an Error with a readable message.
//
// Authentication:
//  * The short-lived access token (JWT) is kept in memory only and sent as
//    "Authorization: Bearer <token>".
//  * The refresh token is an httpOnly cookie that JavaScript never sees. When a request
//    gets 401, we call /api/auth/refresh once (which uses the cookie) and retry.
//  * Signing out in one tab signs out the other open tabs too.

let accessToken = null;
let refreshing = null; // one shared refresh request, even if many calls get 401 at once

// App.jsx listens for this to send the user back to the sign-in page
export const SESSION_EXPIRED_EVENT = "npsb:session-expired";
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("npsb-auth") : null;

export const auth = {
  setToken: (token) => { accessToken = token; },
  hasToken: () => !!accessToken,

  // Restore the session from the refresh cookie (page load). Returns the user or null.
  async restore() {
    try {
      const data = await refreshAccessToken();
      return data.user;
    } catch {
      return null;
    }
  },

  // Tell other tabs about sign-in / sign-out
  broadcast: (type) => channel?.postMessage(type),
  onBroadcast: (fn) => {
    if (!channel) return () => {};
    const handler = (e) => fn(e.data);
    channel.addEventListener("message", handler);
    return () => channel.removeEventListener("message", handler);
  },
};

function refreshAccessToken() {
  if (!refreshing) {
    refreshing = fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin" })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(readableMessage(data.detail) || "Please sign in.");
        accessToken = data.access_token;
        return data;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// Endpoints where 401 means "wrong input", not "session expired"
const NO_REFRESH = ["/api/auth/login", "/api/auth/register", "/api/auth/refresh", "/api/auth/logout",
  "/api/auth/verify-code", "/api/auth/resend-code",
  "/api/auth/forgot-password", "/api/auth/reset-password", "/api/auth/change-password"];

async function request(url, options = {}, retried = false) {
  const headers = { ...options.headers, ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) };
  const res = await fetch(url, { ...options, headers, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));

  if (res.status === 401 && !retried && !NO_REFRESH.some((p) => url.startsWith(p))) {
    try {
      await refreshAccessToken();
      return request(url, options, true);
    } catch (e) {
      accessToken = null;
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: e.message }));
    }
  }
  if (!res.ok) {
    const error = new Error(readableMessage(data.detail) || `Request failed (${res.status})`);
    error.status = res.status;
    error.code = data.detail?.code;
    error.email = data.detail?.email;
    error.details = data.detail?.errors || []; // list of file errors, if any
    throw error;
  }
  return data;
}

// Download a protected file (needs the Authorization header, so a plain link won't do)
async function download(url, filename, retried = false) {
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const res = await fetch(url, { headers, credentials: "same-origin" });

  if (res.status === 401 && !retried) {
    try {
      await refreshAccessToken();
      return download(url, filename, true);
    } catch (e) {
      accessToken = null;
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: e.message }));
    }
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(readableMessage(data.detail) || `Download failed (${res.status})`);
  }

  const link = document.createElement("a");
  link.href = URL.createObjectURL(await res.blob());
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// FastAPI can return the error "detail" as a string, an object or a list
function readableMessage(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg.replace(/^Value error, /, "")).join(", ");
  return detail.message;
}

// { a: 1, b: "" } -> "a=1" (empty filters are left out)
const queryString = (filters) =>
  new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== "" && v != null)).toString();

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  // ---- authentication
  authSettings: () => request("/api/auth/settings"),
  login: (login, password, remember_me) =>
    request("/api/auth/login", json("POST", { login, password, remember_me })),
  register: (account) => request("/api/auth/register", json("POST", account)),
  // sign-in step 2: the 6-digit code emailed after the password was accepted
  verifyCode: (login, code, remember_me = false) =>
    request("/api/auth/verify-code", json("POST", { login, code, remember_me })),
  resendCode: (login) => request("/api/auth/resend-code", json("POST", { login })),
  confirmEmailChange: (code) => request("/api/auth/me/confirm-email", json("POST", { code })),
  resendEmailChangeCode: () => request("/api/auth/me/resend-email-code", { method: "POST" }),
  cancelEmailChange: () => request("/api/auth/me/pending-email", { method: "DELETE" }),
  logout: () => request("/api/auth/logout", { method: "POST" }),
  logoutAll: () => request("/api/auth/logout-all", { method: "POST" }),
  me: () => request("/api/auth/me"),
  updateProfile: (profile) => request("/api/auth/me", json("PUT", profile)),
  changePassword: (current_password, new_password) =>
    request("/api/auth/change-password", json("POST", { current_password, new_password })),
  forgotPassword: (email) => request("/api/auth/forgot-password", json("POST", { email })),
  checkResetToken: (token) => request(`/api/auth/reset-password/${encodeURIComponent(token)}`),
  resetPassword: (token, new_password) =>
    request("/api/auth/reset-password", json("POST", { token, new_password })),
  listSessions: () => request("/api/auth/sessions"),
  revokeSession: (id) => request(`/api/auth/sessions/${id}`, { method: "DELETE" }),
  myActivity: () => request("/api/auth/activity"),

  // ---- users & security (every signed-in user)
  listUsers: () => request("/api/users"),
  createUser: (user) => request("/api/users", json("POST", user)),
  updateUser: (id, changes) => request(`/api/users/${id}`, json("PATCH", changes)),
  auditLog: (limit = 200) => request(`/api/users/events?limit=${limit}`),

  // ---- app
  getConfig: () => request("/api/config"),
  // Email Configuration page (admins change it)
  emailSettings: () => request("/api/email-settings"),
  saveEmailSettings: (values) => request("/api/email-settings", json("PUT", values)),
  runFollowupsNow: () => request("/api/email-settings/run-followups", { method: "POST" }),
  sendTestEmail: (to) => request("/api/email-settings/test-email", json("POST", { to })),

  uploadFile: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("/api/uploads", { method: "POST", body: form });
  },
  downloadTemplate: () => download("/api/upload-template", "dispute_transactions_template.xlsx"),
  // kind: "valid" or "faulty"
  downloadRows: (uploadId, kind, filename) => download(`/api/uploads/${uploadId}/rows/${kind}`, filename),
  getGroups: (uploadId) => request(`/api/uploads/${uploadId}`),

  listPartners: () => request("/api/partners"),
  createPartner: (partner) => request("/api/partners", json("POST", partner)),
  updatePartner: (id, partner) => request(`/api/partners/${id}`, json("PUT", partner)),

  // email templates (users change them, everyone reads them)
  listTemplates: () => request("/api/email-templates"),
  createTemplate: (template) => request("/api/email-templates", json("POST", template)),
  updateTemplate: (id, template) => request(`/api/email-templates/${id}`, json("PUT", template)),
  setDefaultTemplate: (id) => request(`/api/email-templates/${id}/default`, { method: "POST" }),
  deleteTemplate: (id) => request(`/api/email-templates/${id}`, { method: "DELETE" }),

  getEmails: (uploadId) => request(`/api/uploads/${uploadId}/emails`),
  // templates: { inward: id, outward: id } rebuilds every draft of that mail type from the template
  prepareEmails: (uploadId, templates) =>
    request(`/api/uploads/${uploadId}/prepare-emails`, templates ? json("POST", { templates }) : { method: "POST" }),
  editEmail: (id, email) => request(`/api/emails/${id}`, json("PUT", email)),
  discardEmailEdits: (id) => request(`/api/emails/${id}/edits`, { method: "DELETE" }),
  applyTemplate: (id, template_id) => request(`/api/emails/${id}/template`, json("PUT", { template_id })),
  // users: drafts -> pending (waits for an admin)
  submitEmails: (uploadId) => request(`/api/uploads/${uploadId}/submit`, { method: "POST" }),
  pendingEmails: () => request("/api/pending-emails"),
  // filters: { q, partner_id, date_from, date_to, sort: "newest" | "oldest", reply: status | "due" }
  sentEmails: (filters = {}) => request(`/api/sent-emails?${queryString(filters)}`),
  // counts per reply status for the same filters (without sort / reply)
  sentSummary: (filters = {}) => request(`/api/sent-emails/summary?${queryString(filters)}`),
  emailEvents: (id) => request(`/api/emails/${id}/events`),
  // admins only: send the ticked pending emails
  sendSelected: (ids) => request("/api/pending-emails/send", json("POST", { ids })),
  // admins only: follow-up of sent emails
  setReplyStatus: (id, status, note = "") => request(`/api/emails/${id}/reply-status`, json("PUT", { status, note })),
  addEmailNote: (id, note) => request(`/api/emails/${id}/notes`, json("POST", { note })),
  downloadAttachment: (id, filename) => download(`/api/emails/${id}/attachment`, filename),
  setRemarks: (id, remarks) => request(`/api/emails/${id}/remarks`, json("PUT", { remarks })),
  followupDraft: (id) => request(`/api/emails/${id}/followup-draft`),
  sendFollowup: (id, followup) => request(`/api/emails/${id}/followups`, json("POST", followup)),
};

export const formatAmount = (n) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const formatDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

// "Chrome on Windows" from a user-agent string
export function describeDevice(ua = "") {
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Unknown browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "unknown OS";
  return `${browser} on ${os}`;
}
