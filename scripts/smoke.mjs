const base = "http://localhost:3000";

async function call(path, { method = "GET", body, token } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-requested-with": "DharmaServiceDesk",
      ...(token ? { cookie: `dsd_session=${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  const raw = response.headers.get("set-cookie") || "";
  const match = raw.match(/dsd_session=([^;]+)/);
  return { status: response.status, data, token: match ? match[1] : token };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const health = await call("/api/health");
assert(health.status === 200 && health.data.ok, "health");

const meta = await call("/api/meta");
assert(meta.data.demos?.length === 6, "demo accounts");

const admin = await call("/api/auth/login", {
  method: "POST",
  body: { email: "avery.chen@northwind.example", password: "Northwind-2026" },
});
assert(admin.status === 200 && admin.token, `admin login ${admin.status}`);

const ack = await call("/api/auth/acknowledge", { method: "POST", body: {}, token: admin.token });
assert(ack.status === 200, "acknowledge");

const incidents = await call("/api/tickets?type=incident", { token: admin.token });
assert(incidents.data.tickets?.length >= 4, "incidents seeded");
const phi = incidents.data.tickets.find((ticket) => ticket.phi.present);
assert(phi, "phi ticket");
assert(!JSON.stringify(phi).includes("DEMO-00421"), "phi not in list payload");

const revealed = await call(`/api/tickets/${phi.id}/phi`, {
  method: "POST",
  body: { purpose: "Privacy review" },
  token: admin.token,
});
assert(revealed.status === 200 && revealed.data.patientRef === "Case token DEMO-00421", "reveal phi");

const blocked = await call("/api/auth/login", {
  method: "POST",
  body: { email: "morgan.ellis@northwind.example", password: "Northwind-2026" },
});
const morganSees = await call(`/api/tickets/${phi.id}`, { token: blocked.token });
assert(morganSees.status === 404, "knowledge author cannot open another person's PHI ticket");

const requester = await call("/api/auth/login", {
  method: "POST",
  body: { email: "quinn.alvarez@northwind.example", password: "Northwind-2026" },
});
const own = await call(`/api/tickets/${phi.id}/phi`, {
  method: "POST",
  body: { purpose: "Healthcare operations" },
  token: requester.token,
});
assert(own.status === 200, "requester can open PHI on their own ticket");

const loose = await call("/api/tickets", {
  method: "POST",
  body: { type: "incident", title: "SSN 123-45-6789 in the title", description: "test" },
  token: admin.token,
});
assert(loose.status === 400, "identifier in title blocked");

const created = await call("/api/tickets", {
  method: "POST",
  body: {
    type: "incident",
    title: "Badge reader offline at clinic B",
    description: "Staff are using the side door.",
    impact: "medium",
    urgency: "high",
    category: "Access",
  },
  token: admin.token,
});
assert(created.status === 200 && created.data.ticket.number.startsWith("INC"), "create incident");

const change = incidents.data.tickets.find((ticket) => ticket.number === "CHG0001001")
  || (await call("/api/tickets?type=change", { token: admin.token })).data.tickets.find((ticket) => ticket.number === "CHG0001001");
const manager = await call("/api/auth/login", {
  method: "POST",
  body: { email: "riley.nguyen@northwind.example", password: "Northwind-2026" },
});
const approved = await call(`/api/tickets/${change.id}/approval`, {
  method: "POST",
  body: { decision: "approved", comment: "Window is acceptable." },
  token: manager.token,
});
assert(approved.status === 200 && approved.data.ticket.approvalStatus === "approved", "change approval");

const hipaa = await call("/api/hipaa", { token: admin.token });
assert(hipaa.data.chain.intact === true, "audit chain");
assert(hipaa.data.encryption.algorithm === "AES-256-GCM", "encryption");

console.log("smoke ok", created.data.ticket.number, hipaa.data.encryption.fingerprint);
