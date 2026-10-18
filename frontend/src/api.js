// Tiny helper around fetch. Every function returns the JSON body
// or throws an Error with a readable message.

async function request(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(readableMessage(data.detail) || `Request failed (${res.status})`);
    error.details = data.detail?.errors || []; // list of file errors, if any
    throw error;
  }
  return data;
}

// FastAPI can return the error "detail" as a string, an object or a list
function readableMessage(detail) {
  if (!detail) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg).join(", ");
  return detail.message;
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  getConfig: () => request("/api/config"),

  uploadFile: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request("/api/uploads", { method: "POST", body: form });
  },
  getGroups: (uploadId) => request(`/api/uploads/${uploadId}`),

  listPartners: () => request("/api/partners"),
  createPartner: (partner) => request("/api/partners", json("POST", partner)),
  updatePartner: (id, partner) => request(`/api/partners/${id}`, json("PUT", partner)),

  getEmails: (uploadId) => request(`/api/uploads/${uploadId}/emails`),
  prepareEmails: (uploadId) => request(`/api/uploads/${uploadId}/prepare-emails`, { method: "POST" }),
  sendEmails: (uploadId) => request(`/api/uploads/${uploadId}/send`, { method: "POST" }),
};

export const formatAmount = (n) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
