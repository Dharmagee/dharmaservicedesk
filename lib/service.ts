import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { ApiError } from "./errors";
import {
  decryptString,
  dummyPasswordHash,
  encryptString,
  hashPassword,
  phiKey,
  phiKeyStatus,
  randomToken,
  sha256,
  verifyPassword,
} from "./crypto";
import { addBusinessMinutes } from "./sla";
import type {
  Activity,
  Article,
  AuditEvent,
  CatalogItem,
  Ci,
  CustomField,
  Database,
  EncryptedBlob,
  Grant,
  Notification,
  PhiPayload,
  Role,
  SafeUser,
  Settings,
  Ticket,
  TicketType,
  User,
} from "./types";
import { PHI_PURPOSES } from "./types";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "db.json");
const DEMO_PASSWORD = "Northwind-2026";
const IDENTIFIER = /(\b\d{3}-\d{2}-\d{4}\b|\b(?:mrn|ssn|dob)\s*[:#-]?\s*[A-Z0-9-]{4,})/i;

let queue: Promise<void> = Promise.resolve();
const loginAttempts = new Map<string, { count: number; reset: number }>();

function nowIso(): string {
  return new Date().toISOString();
}

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
}

function assertNoLoosePhi(label: string, value: string) {
  if (value && IDENTIFIER.test(value)) {
    throw new ApiError(
      400,
      `${label} looks like a direct identifier. Put patient details in the protected PHI fields.`,
    );
  }
}

function policyVersion(text: string): string {
  return sha256(text);
}

function persist(db: Database) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${dbPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmp, dbPath);
}

function exclusive<T>(fn: (db: Database) => { result: T; save: boolean }): Promise<T> {
  const run = queue.then(() => {
    phiKey();
    const db = load();
    try {
      const out = fn(db);
      if (out.save) persist(db);
      return out.result;
    } catch (error) {
      if (error instanceof ApiError && error.save) persist(db);
      throw error;
    }
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function load(): Database {
  if (!fs.existsSync(dbPath)) {
    const seeded = seed();
    persist(seeded);
    return seeded;
  }
  return JSON.parse(fs.readFileSync(dbPath, "utf8")) as Database;
}

function signTicket(ticket: Ticket): string {
  return sha256(
    JSON.stringify({
      id: ticket.id,
      number: ticket.number,
      type: ticket.type,
      title: ticket.title,
      description: ticket.description,
      state: ticket.state,
      priority: ticket.priority,
      requesterId: ticket.requesterId,
      custom: ticket.custom,
      phi: ticket.phi,
    }),
  );
}

function permissionsFor(db: Database, user: User): string[] {
  const set = new Set<string>();
  for (const roleId of user.roleIds) {
    const role = db.roles.find((item) => item.id === roleId);
    role?.permissions.forEach((permission) => set.add(permission));
  }
  return [...set];
}

function allowed(perms: string[], permission: string): boolean {
  return perms.includes("*") || perms.includes(permission);
}

function toSafeUser(db: Database, user: User): SafeUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roleIds: user.roleIds,
    roleNames: user.roleIds.map((id) => db.roles.find((role) => role.id === id)?.name || id),
    groupIds: user.groupIds,
    active: user.active,
    permissions: permissionsFor(db, user),
    acknowledgedPolicyVersion: user.acknowledgedPolicyVersion,
  };
}

function requireSession(db: Database, token: string | undefined): { user: User; safe: SafeUser; perms: string[] } {
  if (!token) throw new ApiError(401, "Sign in to continue.");
  const session = db.sessions.find((item) => item.token === token);
  if (!session) throw new ApiError(401, "Sign in to continue.");
  const timeoutMs = db.settings.sessionTimeoutMinutes * 60 * 1000;
  if (Date.now() - Date.parse(session.lastSeen) > timeoutMs) {
    const idleUser = db.users.find((item) => item.id === session.userId);
    db.sessions = db.sessions.filter((item) => item.token !== token);
    if (idleUser) appendAudit(db, idleUser, "session.timeout", idleUser.id, "Idle timeout");
    const error = new ApiError(401, "Your session ended after a period of inactivity.");
    error.save = true;
    throw error;
  }
  const user = db.users.find((item) => item.id === session.userId && item.active);
  if (!user) throw new ApiError(401, "Sign in to continue.");
  if (Date.now() - Date.parse(session.lastSeen) > 60 * 1000) {
    session.lastSeen = nowIso();
  }
  const safe = toSafeUser(db, user);
  return { user, safe, perms: safe.permissions };
}

function touchSave(db: Database, token: string | undefined): boolean {
  const session = token ? db.sessions.find((item) => item.token === token) : undefined;
  if (!session) return false;
  return Date.now() - Date.parse(session.lastSeen) < 2000;
}

function seesAll(perms: string[]): boolean {
  return allowed(perms, "*") || allowed(perms, "ticket.update") || allowed(perms, "audit.read");
}

function canSeeTicket(perms: string[], user: User, ticket: Ticket): boolean {
  if (seesAll(perms)) return true;
  return ticket.requesterId === user.id || ticket.assigneeId === user.id;
}

function moduleKey(type: TicketType): keyof Settings["modules"] {
  if (type === "incident") return "incidents";
  if (type === "problem") return "problems";
  if (type === "change") return "changes";
  return "requests";
}

function initialState(settings: Settings, type: TicketType): string {
  return settings.states[type][0]?.id || "new";
}

function isTerminal(settings: Settings, ticket: Ticket): boolean {
  return settings.states[ticket.type].some((state) => state.id === ticket.state && state.terminal);
}

function priorityFromMatrix(impact: Ticket["impact"], urgency: Ticket["urgency"]): string {
  const matrix: Record<string, string> = {
    "high-high": "critical",
    "high-medium": "high",
    "high-low": "moderate",
    "medium-high": "high",
    "medium-medium": "moderate",
    "medium-low": "low",
    "low-high": "moderate",
    "low-medium": "low",
    "low-low": "planning",
  };
  return matrix[`${impact}-${urgency}`] || "moderate";
}

function dueDates(settings: Settings, priorityId: string, from: Date) {
  const priority = settings.priorities.find((item) => item.id === priorityId) || settings.priorities[0];
  return {
    responseDue: addBusinessMinutes(from, priority.responseMinutes, settings.businessHours).toISOString(),
    resolveDue: addBusinessMinutes(from, priority.resolveMinutes, settings.businessHours).toISOString(),
  };
}

function appendAudit(
  db: Database,
  actor: { id: string; email: string } | undefined,
  action: string,
  target: string,
  detail: string,
) {
  const prevHash = db.audit.length ? db.audit[db.audit.length - 1].hash : "GENESIS";
  const event = {
    id: randomUUID(),
    at: nowIso(),
    actorId: actor?.id || "",
    actorEmail: actor?.email || "",
    action,
    target,
    detail: detail.slice(0, 500),
    prevHash,
  };
  const hash = sha256(
    JSON.stringify([event.id, event.at, event.actorId, event.actorEmail, event.action, event.target, event.detail, event.prevHash]),
  );
  db.audit.push({ ...event, hash });
}

function verifyChain(events: AuditEvent[]): { intact: boolean; brokenAt?: string } {
  let prev = "GENESIS";
  for (const event of events) {
    const hash = sha256(
      JSON.stringify([event.id, event.at, event.actorId, event.actorEmail, event.action, event.target, event.detail, event.prevHash]),
    );
    if (event.prevHash !== prev || event.hash !== hash) return { intact: false, brokenAt: event.id };
    prev = event.hash;
  }
  return { intact: true };
}

function userName(db: Database, id: string): string {
  return db.users.find((user) => user.id === id)?.name || "Unassigned";
}

function groupName(db: Database, id: string): string {
  return db.settings.groups.find((group) => group.id === id)?.name || "Unassigned";
}

function notify(db: Database, userId: string, title: string, body: string, href: string, exceptUserId?: string) {
  if (!userId || userId === exceptUserId) return;
  const note: Notification = {
    id: randomUUID(),
    userId,
    title: title.slice(0, 140),
    body: body.slice(0, 300),
    href,
    read: false,
    createdAt: nowIso(),
  };
  db.notifications.unshift(note);
  db.notifications = db.notifications.slice(0, 2000);
  queueWebhook(db, { kind: "notification", title: note.title, body: note.body, href: note.href });
}

function notifyGroup(db: Database, groupId: string, title: string, body: string, href: string, exceptUserId?: string) {
  if (!groupId) return;
  for (const user of db.users) {
    if (user.active && user.groupIds.includes(groupId)) notify(db, user.id, title, body, href, exceptUserId);
  }
}

function notifyPrivacy(db: Database, title: string, body: string, href: string) {
  for (const user of db.users) {
    const perms = permissionsFor(db, user);
    if (user.active && (allowed(perms, "audit.read") || allowed(perms, "*"))) {
      notify(db, user.id, title, body, href);
    }
  }
}

function queueWebhook(db: Database, payload: unknown) {
  const url = db.settings.webhookUrl?.trim();
  if (!url || !safeWebhook(url)) return;
  setImmediate(() => {
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch((error) => {
      console.error("Webhook delivery failed", error);
    });
  });
}

function safeWebhook(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return true;
    const a = Number(match[1]);
    const b = Number(match[2]);
    if (a === 10 || a === 127 || a === 0 || a === 255) return false;
    if (a === 169 && b === 254) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    return true;
  } catch {
    return false;
  }
}

function publicSettings(settings: Settings) {
  return {
    orgName: settings.orgName,
    tagline: settings.tagline,
    accent: settings.accent,
    showDemoBanner: settings.showDemoBanner,
    modules: settings.modules,
    sessionTimeoutMinutes: settings.sessionTimeoutMinutes,
    retentionDays: settings.retentionDays,
    requireHipaaAcknowledgement: settings.requireHipaaAcknowledgement,
    hipaaPolicyText: settings.hipaaPolicyText,
    hipaaPolicyVersion: policyVersion(settings.hipaaPolicyText),
    priorities: settings.priorities,
    states: settings.states,
    categories: settings.categories,
    customFields: settings.customFields,
    groups: settings.groups,
    catalog: settings.catalog.filter((item) => item.active),
    businessHours: settings.businessHours,
  };
}

function slaView(settings: Settings, ticket: Ticket) {
  const now = Date.now();
  const terminal = isTerminal(settings, ticket);
  return {
    responseBreached: !terminal && !ticket.respondedAt && now > Date.parse(ticket.responseDue),
    resolveBreached: !terminal && !ticket.resolvedAt && now > Date.parse(ticket.resolveDue),
  };
}

function integrityOf(ticket: Ticket): "ok" | "mismatch" {
  return signTicket(ticket) === ticket.recordHash ? "ok" : "mismatch";
}

function publicTicket(db: Database, ticket: Ticket, includeInternal: boolean) {
  const activities = db.activities
    .filter((item) => item.ticketId === ticket.id && (includeInternal || item.kind !== "work_note"))
    .map((item) => ({
      ...item,
      authorName: userName(db, item.authorId),
    }));
  return {
    id: ticket.id,
    number: ticket.number,
    type: ticket.type,
    title: ticket.title,
    description: ticket.description,
    state: ticket.state,
    priority: ticket.priority,
    impact: ticket.impact,
    urgency: ticket.urgency,
    category: ticket.category,
    channel: ticket.channel,
    assignmentGroupId: ticket.assignmentGroupId,
    assignmentGroupName: groupName(db, ticket.assignmentGroupId),
    assigneeId: ticket.assigneeId,
    assigneeName: ticket.assigneeId ? userName(db, ticket.assigneeId) : "",
    requesterId: ticket.requesterId,
    requesterName: userName(db, ticket.requesterId),
    cmdbId: ticket.cmdbId,
    knowledgeId: ticket.knowledgeId,
    relatedIds: ticket.relatedIds,
    catalogItemId: ticket.catalogItemId,
    changeRisk: ticket.changeRisk,
    windowStart: ticket.windowStart,
    windowEnd: ticket.windowEnd,
    approvalStatus: ticket.approvalStatus,
    approvalComment: ticket.approvalComment,
    custom: ticket.custom,
    phi: {
      present: ticket.phi.present,
      purpose: ticket.phi.present ? ticket.phi.purpose : "",
      fields: [
        ticket.phi.patientRef ? "Patient reference" : "",
        ticket.phi.clinicalNote ? "Clinical context" : "",
        ...Object.keys(ticket.phi.custom || {}),
      ].filter(Boolean),
    },
    responseDue: ticket.responseDue,
    resolveDue: ticket.resolveDue,
    resolvedAt: ticket.resolvedAt,
    respondedAt: ticket.respondedAt,
    sla: slaView(db.settings, ticket),
    integrity: integrityOf(ticket),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    activities,
  };
}

function nextNumber(db: Database, counter: string, prefix: string): string {
  db.counters[counter] = (db.counters[counter] || 1000) + 1;
  return `${prefix}${String(db.counters[counter]).padStart(7, "0")}`;
}

function blankPhi(): PhiPayload {
  return { present: false, purpose: "", custom: {} };
}

function applyPhi(ticket: Ticket, input: Record<string, unknown>, fields: CustomField[]) {
  const patientRef = "patientRef" in input ? clean(input.patientRef, 200) : undefined;
  const clinicalNote = "clinicalNote" in input ? clean(input.clinicalNote, 4000) : undefined;
  const customPhi = (input.customPhi && typeof input.customPhi === "object" ? input.customPhi : {}) as Record<string, unknown>;
  const purpose = clean(input.phiPurpose, 80);
  const writesPhi =
    patientRef !== undefined || clinicalNote !== undefined || Object.keys(customPhi).length > 0;
  if (!writesPhi) return;
  const next: PhiPayload = {
    present: ticket.phi.present,
    purpose: ticket.phi.purpose,
    patientRef: ticket.phi.patientRef,
    clinicalNote: ticket.phi.clinicalNote,
    custom: { ...(ticket.phi.custom || {}) },
  };
  if (patientRef !== undefined) {
    if (patientRef) next.patientRef = encryptString(patientRef);
    else delete next.patientRef;
  }
  if (clinicalNote !== undefined) {
    if (clinicalNote) next.clinicalNote = encryptString(clinicalNote);
    else delete next.clinicalNote;
  }
  for (const field of fields.filter((item) => item.phi)) {
    if (!(field.id in customPhi)) continue;
    const value = clean(customPhi[field.id], 2000);
    if (value) next.custom[field.id] = encryptString(value);
    else delete next.custom[field.id];
  }
  const hasValue = Boolean(next.patientRef || next.clinicalNote || Object.keys(next.custom).length);
  if (hasValue) {
    if (!PHI_PURPOSES.includes(purpose as (typeof PHI_PURPOSES)[number]) && !next.purpose) {
      throw new ApiError(400, "Choose why this PHI is needed: treatment, payment, healthcare operations, or privacy review.");
    }
    if (PHI_PURPOSES.includes(purpose as (typeof PHI_PURPOSES)[number])) next.purpose = purpose;
    next.present = true;
  } else {
    next.present = false;
    next.purpose = "";
  }
  ticket.phi = next;
}

function applyRules(db: Database, ticket: Ticket, event: "created" | "updated") {
  for (const rule of db.settings.rules) {
    if (!rule.enabled || rule.event !== event) continue;
    if (rule.type !== "any" && rule.type !== ticket.type) continue;
    if (rule.priority !== "any" && rule.priority !== ticket.priority) continue;
    if (rule.action === "assign_group" && rule.actionValue && !ticket.assignmentGroupId) {
      ticket.assignmentGroupId = rule.actionValue;
    }
    if (rule.action === "set_state" && rule.actionValue) ticket.state = rule.actionValue;
    if (rule.action === "require_approval") ticket.approvalStatus = "pending";
  }
}

function assertTransition(settings: Settings, ticket: Ticket, next: string, perms: string[]) {
  if (!settings.states[ticket.type].some((state) => state.id === next)) {
    throw new ApiError(400, "That state is not configured for this record type.");
  }
  if (allowed(perms, "*")) return;
  const allowedNext = settings.transitions[ticket.type]?.[ticket.state];
  if (allowedNext && !allowedNext.includes(next)) {
    throw new ApiError(400, "That state change is not allowed by the workflow.");
  }
  if (ticket.type === "change" && !["new", "assess", "authorize", "cancelled"].includes(next) && ticket.approvalStatus !== "approved") {
    throw new ApiError(400, "Approve this change before it moves into the schedule or implementation.");
  }
}

function findVisibleTicket(db: Database, user: User, perms: string[], id: string): Ticket {
  const ticket = db.tickets.find((item) => item.id === id);
  if (!ticket || !canSeeTicket(perms, user, ticket)) throw new ApiError(404, "Record not found.");
  return ticket;
}

function grantActive(db: Database, userId: string, target: string): Grant | undefined {
  const now = Date.now();
  return db.grants.find((grant) => grant.userId === userId && grant.target === target && Date.parse(grant.expiresAt) > now);
}

function revealPayload(ticket: Ticket) {
  try {
    const custom: Record<string, string> = {};
    for (const [key, blob] of Object.entries(ticket.phi.custom || {})) {
      custom[key] = decryptString(blob);
    }
    return {
      patientRef: ticket.phi.patientRef ? decryptString(ticket.phi.patientRef) : "",
      clinicalNote: ticket.phi.clinicalNote ? decryptString(ticket.phi.clinicalNote) : "",
      custom,
      purpose: ticket.phi.purpose,
    };
  } catch {
    throw new ApiError(409, "PHI could not be decrypted. The encryption key does not match this record.");
  }
}

function rateLimit(email: string) {
  const now = Date.now();
  const current = loginAttempts.get(email);
  if (!current || current.reset < now) {
    loginAttempts.set(email, { count: 1, reset: now + 10 * 60 * 1000 });
    return;
  }
  current.count += 1;
  if (current.count > 8) throw new ApiError(429, "Too many sign-in attempts. Wait a few minutes and try again.");
}

function clearRateLimit(email: string) {
  loginAttempts.delete(email);
}

function demoAccounts() {
  return [
    ["Avery Chen", "avery.chen@northwind.example", "Platform admin"],
    ["Jordan Blake", "jordan.blake@northwind.example", "Privacy officer"],
    ["Samir Patel", "samir.patel@northwind.example", "Service desk"],
    ["Riley Nguyen", "riley.nguyen@northwind.example", "Change manager"],
    ["Quinn Alvarez", "quinn.alvarez@northwind.example", "Requester"],
    ["Morgan Ellis", "morgan.ellis@northwind.example", "Knowledge author"],
  ].map(([name, email, role]) => ({ name, email, role, password: DEMO_PASSWORD }));
}

export function meta() {
  return exclusive((db) => ({
    save: false,
    result: {
      orgName: db.settings.orgName,
      tagline: db.settings.tagline,
      accent: db.settings.accent,
      showDemoBanner: db.settings.showDemoBanner,
      demos: db.settings.showDemoBanner ? demoAccounts() : [],
    },
  }));
}

export function login(emailRaw: unknown, passwordRaw: unknown) {
  const email = clean(emailRaw, 160).toLowerCase();
  const password = typeof passwordRaw === "string" ? passwordRaw : "";
  rateLimit(email || "unknown");
  return exclusive<{ token: string; user: SafeUser } | { error: string; status: 401 }>((db) => {
    const user = db.users.find((item) => item.email === email && item.active);
    const hash = user?.passwordHash || dummyPasswordHash();
    const ok = verifyPassword(password, hash) && Boolean(user);
    if (!ok || !user) {
      appendAudit(db, undefined, "login.failure", email, "Rejected sign-in");
      return { save: true, result: { error: "Email or password is incorrect.", status: 401 as const } };
    }
    clearRateLimit(email);
    const token = randomToken();
    db.sessions.push({ token, userId: user.id, createdAt: nowIso(), lastSeen: nowIso() });
    appendAudit(db, user, "login.success", user.id, "Interactive sign-in");
    return { save: true, result: { token, user: toSafeUser(db, user) } };
  });
}

export function logout(token: string | undefined) {
  return exclusive((db) => {
    const session = token ? db.sessions.find((item) => item.token === token) : undefined;
    const user = session ? db.users.find((item) => item.id === session.userId) : undefined;
    db.sessions = db.sessions.filter((item) => item.token !== token);
    if (user) appendAudit(db, user, "logout", user.id, "Signed out");
    return { save: true, result: { ok: true } };
  });
}

export function session(token: string | undefined) {
  return exclusive((db) => {
    const { safe } = requireSession(db, token);
    const ackRequired =
      db.settings.requireHipaaAcknowledgement && safe.acknowledgedPolicyVersion !== policyVersion(db.settings.hipaaPolicyText);
    return {
      save: touchSave(db, token),
      result: {
        user: safe,
        settings: publicSettings(db.settings),
        notifications: db.notifications.filter((item) => item.userId === safe.id).slice(0, 12),
        ackRequired,
        encryption: allowed(safe.permissions, "admin.settings") || allowed(safe.permissions, "audit.read")
          ? phiKeyStatus()
          : { algorithm: "AES-256-GCM", source: "protected", fingerprint: "" },
      },
    };
  });
}

export function acknowledge(token: string | undefined) {
  return exclusive((db) => {
    const { user } = requireSession(db, token);
    user.acknowledgedPolicyVersion = policyVersion(db.settings.hipaaPolicyText);
    appendAudit(db, user, "hipaa.acknowledge", user.id, "Acknowledged the HIPAA policy");
    return { save: true, result: { ok: true } };
  });
}

export function changePassword(token: string | undefined, current: unknown, next: unknown) {
  return exclusive((db) => {
    const { user } = requireSession(db, token);
    const currentPassword = typeof current === "string" ? current : "";
    const nextPassword = typeof next === "string" ? next : "";
    if (!verifyPassword(currentPassword, user.passwordHash)) throw new ApiError(400, "Current password is incorrect.");
    assertPassword(nextPassword);
    user.passwordHash = hashPassword(nextPassword);
    appendAudit(db, user, "user.password", user.id, "Changed own password");
    return { save: true, result: { ok: true } };
  });
}

function assertPassword(password: string) {
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new ApiError(400, "Use at least 12 characters with a letter and a number.");
  }
}

export function listTickets(token: string | undefined, query: URLSearchParams) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    const type = clean(query.get("type"), 20) as TicketType;
    let rows = db.tickets.filter((ticket) => canSeeTicket(perms, user, ticket));
    if (type) rows = rows.filter((ticket) => ticket.type === type);
    const state = clean(query.get("state"), 40);
    const priority = clean(query.get("priority"), 40);
    const group = clean(query.get("group"), 40);
    const q = clean(query.get("q"), 80).toLowerCase();
    const mine = query.get("mine") === "1";
    const breached = query.get("breached") === "1";
    if (state) rows = rows.filter((ticket) => ticket.state === state);
    if (priority) rows = rows.filter((ticket) => ticket.priority === priority);
    if (group) rows = rows.filter((ticket) => ticket.assignmentGroupId === group);
    if (mine) rows = rows.filter((ticket) => ticket.assigneeId === user.id || ticket.requesterId === user.id);
    if (q) {
      rows = rows.filter((ticket) =>
        `${ticket.number} ${ticket.title} ${ticket.description} ${ticket.category}`.toLowerCase().includes(q),
      );
    }
    if (breached) rows = rows.filter((ticket) => slaView(db.settings, ticket).resolveBreached || slaView(db.settings, ticket).responseBreached);
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      save: touchSave(db, token),
      result: { tickets: rows.slice(0, 200).map((ticket) => publicTicket(db, ticket, false)) },
    };
  });
}

export function getTicket(token: string | undefined, id: string) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    const ticket = findVisibleTicket(db, user, perms, id);
    if (integrityOf(ticket) === "mismatch") {
      appendAudit(db, user, "integrity.alert", ticket.number, "Record hash did not match its contents");
    }
    return {
      save: integrityOf(ticket) === "mismatch" || touchSave(db, token),
      result: { ticket: publicTicket(db, ticket, allowed(perms, "ticket.update") || allowed(perms, "*")) },
    };
  });
}

export function createTicket(token: string | undefined, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "ticket.create") && !allowed(perms, "*")) throw new ApiError(403, "You cannot create records.");
    const type = clean(body.type, 20) as TicketType;
    if (!["incident", "problem", "change", "request"].includes(type)) throw new ApiError(400, "Choose a record type.");
    if (!db.settings.modules[moduleKey(type)]) throw new ApiError(400, "This module is turned off for the organization.");
    if (!allowed(perms, "ticket.update") && !allowed(perms, "*") && !["incident", "request"].includes(type)) {
      throw new ApiError(403, "Your role can open incidents and catalog requests.");
    }
    const title = clean(body.title, 180);
    const description = clean(body.description, 8000);
    if (title.length < 4) throw new ApiError(400, "Add a short title.");
    assertNoLoosePhi("Title", title);
    assertNoLoosePhi("Description", description);
    const impact = (clean(body.impact, 10) || "medium") as Ticket["impact"];
    const urgency = (clean(body.urgency, 10) || "medium") as Ticket["urgency"];
    if (!["high", "medium", "low"].includes(impact) || !["high", "medium", "low"].includes(urgency)) {
      throw new ApiError(400, "Impact and urgency must be high, medium, or low.");
    }
    const priority = clean(body.priority, 40) || priorityFromMatrix(impact, urgency);
    if (!db.settings.priorities.some((item) => item.id === priority)) throw new ApiError(400, "Unknown priority.");
    const createdAt = nowIso();
    const dues = dueDates(db.settings, priority, new Date(createdAt));
    const assigner = allowed(perms, "ticket.assign") || allowed(perms, "*");
    const ticket: Ticket = {
      id: randomUUID(),
      number: nextNumber(db, type, type === "incident" ? "INC" : type === "problem" ? "PRB" : type === "change" ? "CHG" : "REQ"),
      type,
      title,
      description,
      state: initialState(db.settings, type),
      priority,
      impact,
      urgency,
      category: clean(body.category, 80),
      channel: clean(body.channel, 40) || "portal",
      assignmentGroupId: assigner ? clean(body.assignmentGroupId, 40) : "",
      assigneeId: assigner ? clean(body.assigneeId, 40) : "",
      requesterId: assigner && clean(body.requesterId, 40) ? clean(body.requesterId, 40) : user.id,
      cmdbId: clean(body.cmdbId, 40),
      knowledgeId: clean(body.knowledgeId, 40),
      relatedIds: Array.isArray(body.relatedIds) ? body.relatedIds.map((item) => clean(item, 40)).filter(Boolean).slice(0, 12) : [],
      catalogItemId: clean(body.catalogItemId, 40),
      changeRisk: clean(body.changeRisk, 20),
      windowStart: clean(body.windowStart, 40),
      windowEnd: clean(body.windowEnd, 40),
      approvalStatus: "none",
      approvalComment: "",
      custom: readCustom(db.settings.customFields, type, body.custom),
      phi: blankPhi(),
      responseDue: dues.responseDue,
      resolveDue: dues.resolveDue,
      resolvedAt: "",
      respondedAt: "",
      recordHash: "",
      createdAt,
      updatedAt: createdAt,
      createdBy: user.id,
    };
    applyPhi(ticket, body, db.settings.customFields.filter((field) => field.ticketTypes.includes(type)));
    for (const field of db.settings.customFields) {
      if (field.ticketTypes.includes(type) && field.required && !field.phi && !ticket.custom[field.id]) {
        throw new ApiError(400, `${field.label} is required.`);
      }
    }
    applyRules(db, ticket, "created");
    ticket.recordHash = signTicket(ticket);
    db.tickets.unshift(ticket);
    db.activities.push({
      id: randomUUID(),
      ticketId: ticket.id,
      kind: "system",
      body: `Opened ${ticket.number}`,
      authorId: user.id,
      createdAt,
    });
    appendAudit(db, user, "ticket.create", ticket.number, type);
    const href = `/desk/tickets/${ticket.id}`;
    notify(db, ticket.assigneeId, `Assigned ${ticket.number}`, ticket.title, href, user.id);
    notifyGroup(db, ticket.assignmentGroupId, `New ${ticket.number}`, ticket.title, href, user.id);
    return { save: true, result: { ticket: publicTicket(db, ticket, true) } };
  });
}

function readCustom(fields: CustomField[], type: TicketType, raw: unknown): Record<string, string> {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const custom: Record<string, string> = {};
  for (const field of fields) {
    if (!field.ticketTypes.includes(type) || field.phi) continue;
    const value = clean(source[field.id], 2000);
    if (value) assertNoLoosePhi(field.label, value);
    if (value) custom[field.id] = value;
  }
  return custom;
}

export function updateTicket(token: string | undefined, id: string, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "ticket.update") && !allowed(perms, "*")) throw new ApiError(403, "You cannot update this record.");
    const ticket = findVisibleTicket(db, user, perms, id);
    const before = {
      state: ticket.state,
      priority: ticket.priority,
      assignmentGroupId: ticket.assignmentGroupId,
      assigneeId: ticket.assigneeId,
      category: ticket.category,
    };
    if ("title" in body) {
      const title = clean(body.title, 180);
      if (title.length < 4) throw new ApiError(400, "Add a short title.");
      assertNoLoosePhi("Title", title);
      ticket.title = title;
    }
    if ("description" in body) {
      const description = clean(body.description, 8000);
      assertNoLoosePhi("Description", description);
      ticket.description = description;
    }
    if ("priority" in body) {
      const priority = clean(body.priority, 40);
      if (!db.settings.priorities.some((item) => item.id === priority)) throw new ApiError(400, "Unknown priority.");
      ticket.priority = priority;
      const dues = dueDates(db.settings, priority, new Date(ticket.createdAt));
      ticket.responseDue = dues.responseDue;
      ticket.resolveDue = dues.resolveDue;
    }
    if ("impact" in body && ["high", "medium", "low"].includes(clean(body.impact, 10))) ticket.impact = clean(body.impact, 10) as Ticket["impact"];
    if ("urgency" in body && ["high", "medium", "low"].includes(clean(body.urgency, 10))) ticket.urgency = clean(body.urgency, 10) as Ticket["urgency"];
    if ("category" in body) ticket.category = clean(body.category, 80);
    if ("cmdbId" in body) ticket.cmdbId = clean(body.cmdbId, 40);
    if ("knowledgeId" in body) ticket.knowledgeId = clean(body.knowledgeId, 40);
    if ("changeRisk" in body) ticket.changeRisk = clean(body.changeRisk, 20);
    if ("windowStart" in body) ticket.windowStart = clean(body.windowStart, 40);
    if ("windowEnd" in body) ticket.windowEnd = clean(body.windowEnd, 40);
    if ("relatedIds" in body && Array.isArray(body.relatedIds)) {
      ticket.relatedIds = body.relatedIds.map((item) => clean(item, 40)).filter(Boolean).slice(0, 12);
    }
    if (allowed(perms, "ticket.assign") || allowed(perms, "*")) {
      if ("assignmentGroupId" in body) ticket.assignmentGroupId = clean(body.assignmentGroupId, 40);
      if ("assigneeId" in body) ticket.assigneeId = clean(body.assigneeId, 40);
    }
    if ("custom" in body) ticket.custom = { ...ticket.custom, ...readCustom(db.settings.customFields, ticket.type, body.custom) };
    applyPhi(ticket, body, db.settings.customFields);
    if ("state" in body) {
      const next = clean(body.state, 40);
      assertTransition(db.settings, ticket, next, perms);
      ticket.state = next;
      if (ticket.type === "change" && next === "authorize") ticket.approvalStatus = "pending";
      if (!ticket.respondedAt && next !== initialState(db.settings, ticket.type)) ticket.respondedAt = nowIso();
      if (isTerminal(db.settings, ticket) && !ticket.resolvedAt) ticket.resolvedAt = nowIso();
      if (!isTerminal(db.settings, ticket)) ticket.resolvedAt = "";
    }
    applyRules(db, ticket, "updated");
    if (isTerminal(db.settings, ticket) && !ticket.resolvedAt) ticket.resolvedAt = nowIso();
    if (!isTerminal(db.settings, ticket)) ticket.resolvedAt = "";
    ticket.updatedAt = nowIso();
    ticket.recordHash = signTicket(ticket);
    const notes: string[] = [];
    if (before.state !== ticket.state) notes.push(`State changed from ${before.state} to ${ticket.state}`);
    if (before.priority !== ticket.priority) notes.push(`Priority changed from ${before.priority} to ${ticket.priority}`);
    if (before.assignmentGroupId !== ticket.assignmentGroupId) notes.push(`Group changed to ${groupName(db, ticket.assignmentGroupId)}`);
    if (before.assigneeId !== ticket.assigneeId) notes.push(`Assignee changed to ${ticket.assigneeId ? userName(db, ticket.assigneeId) : "Unassigned"}`);
    if (before.category !== ticket.category) notes.push("Category updated");
    if ("patientRef" in body || "clinicalNote" in body || "customPhi" in body) notes.push("Protected health information fields were updated");
    for (const note of notes) {
      db.activities.push({ id: randomUUID(), ticketId: ticket.id, kind: "system", body: note, authorId: user.id, createdAt: ticket.updatedAt });
    }
    appendAudit(db, user, "ticket.update", ticket.number, notes.join("; ") || "Fields updated");
    const href = `/desk/tickets/${ticket.id}`;
    if (before.assigneeId !== ticket.assigneeId) notify(db, ticket.assigneeId, `Assigned ${ticket.number}`, ticket.title, href, user.id);
    if (before.assignmentGroupId !== ticket.assignmentGroupId) {
      notifyGroup(db, ticket.assignmentGroupId, `Queued ${ticket.number}`, ticket.title, href, user.id);
    }
    if (ticket.approvalStatus === "pending" && before.state !== ticket.state) {
      for (const person of db.users) {
        const personPerms = permissionsFor(db, person);
        if (allowed(personPerms, "change.approve")) notify(db, person.id, `Approval needed ${ticket.number}`, ticket.title, href, user.id);
      }
    }
    return { save: true, result: { ticket: publicTicket(db, ticket, true) } };
  });
}

export function addNote(token: string | undefined, id: string, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    const ticket = findVisibleTicket(db, user, perms, id);
    const text = clean(body.body, 4000);
    if (text.length < 2) throw new ApiError(400, "Write a note before saving.");
    assertNoLoosePhi("Note", text);
    const internal = Boolean(body.internal);
    if (internal && !allowed(perms, "ticket.update") && !allowed(perms, "*")) {
      throw new ApiError(403, "Work notes are visible to the service desk only.");
    }
    if (!internal && ticket.requesterId !== user.id && !allowed(perms, "ticket.update") && !allowed(perms, "*")) {
      throw new ApiError(403, "You can comment on your own requests.");
    }
    const activity: Activity = {
      id: randomUUID(),
      ticketId: ticket.id,
      kind: internal ? "work_note" : "comment",
      body: text,
      authorId: user.id,
      createdAt: nowIso(),
    };
    db.activities.push(activity);
    if (!internal && (allowed(perms, "ticket.update") || allowed(perms, "*")) && !ticket.respondedAt) {
      ticket.respondedAt = activity.createdAt;
    }
    ticket.updatedAt = activity.createdAt;
    ticket.recordHash = signTicket(ticket);
    appendAudit(db, user, internal ? "ticket.work_note" : "ticket.comment", ticket.number, internal ? "Work note" : "Public comment");
    if (!internal && ticket.requesterId !== user.id) {
      notify(db, ticket.requesterId, `Update on ${ticket.number}`, text, `/desk/tickets/${ticket.id}`, user.id);
    }
    return { save: true, result: { ticket: publicTicket(db, ticket, allowed(perms, "ticket.update") || allowed(perms, "*")) } };
  });
}

export function revealPhi(token: string | undefined, id: string, body: Record<string, unknown>, kind: "ticket" | "knowledge") {
  return exclusive<{ body: string; purpose: string } | ReturnType<typeof revealPayload>>((db) => {
    const { user, perms } = requireSession(db, token);
    const purpose = clean(body.purpose, 80);
    if (!PHI_PURPOSES.includes(purpose as (typeof PHI_PURPOSES)[number])) {
      throw new ApiError(400, "Select a purpose before opening PHI.");
    }
    if (kind === "knowledge") {
      const article = db.knowledge.find((item) => item.id === id);
      if (!article || !article.containsPhi || !article.phiBody) throw new ApiError(404, "Article not found.");
      const canOpen = allowed(perms, "phi.view") || allowed(perms, "*") || article.authorId === user.id || grantActive(db, user.id, article.id);
      if (!canOpen) throw new ApiError(403, "You do not have access to PHI in knowledge.");
      appendAudit(db, user, "phi.reveal", article.number, `purpose=${purpose}`);
      try {
        return { save: true, result: { body: decryptString(article.phiBody), purpose } };
      } catch {
        throw new ApiError(409, "PHI could not be decrypted. The encryption key does not match this article.");
      }
    }
    const ticket = findVisibleTicket(db, user, perms, id);
    if (!ticket.phi.present) throw new ApiError(400, "This record has no PHI.");
    const emergency = grantActive(db, user.id, ticket.id);
    const canOpen = allowed(perms, "phi.view") || allowed(perms, "*") || ticket.requesterId === user.id || Boolean(emergency);
    if (!canOpen) throw new ApiError(403, "You do not have access to PHI. A privacy officer can grant emergency access.");
    appendAudit(db, user, emergency?.emergency ? "phi.breakglass" : "phi.reveal", ticket.number, `purpose=${purpose}`);
    return { save: true, result: revealPayload(ticket) };
  });
}

export function breakGlass(token: string | undefined, id: string, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "phi.breakglass") && !allowed(perms, "*")) {
      throw new ApiError(403, "Your role does not include emergency access.");
    }
    const ticket = findVisibleTicket(db, user, perms, id);
    const reason = clean(body.reason, 500);
    if (reason.length < 15) throw new ApiError(400, "Describe the emergency in at least 15 characters. This reason is audited.");
    const grant: Grant = {
      id: randomUUID(),
      userId: user.id,
      target: ticket.id,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      reason,
      emergency: true,
    };
    db.grants.push(grant);
    appendAudit(db, user, "phi.breakglass", ticket.number, "Emergency access granted for 15 minutes");
    notifyPrivacy(db, `Break-the-glass on ${ticket.number}`, `${user.name}: ${reason}`, `/desk/tickets/${ticket.id}`);
    return { save: true, result: { expiresAt: grant.expiresAt } };
  });
}

export function exportPhi(token: string | undefined, id: string, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "phi.export") && !allowed(perms, "*")) throw new ApiError(403, "PHI export is limited to the privacy role.");
    const purpose = clean(body.purpose, 80);
    if (!PHI_PURPOSES.includes(purpose as (typeof PHI_PURPOSES)[number])) throw new ApiError(400, "Select an export purpose.");
    const ticket = findVisibleTicket(db, user, perms, id);
    if (!ticket.phi.present) throw new ApiError(400, "This record has no PHI.");
    appendAudit(db, user, "phi.export", ticket.number, `purpose=${purpose}`);
    return { save: true, result: { number: ticket.number, ...revealPayload(ticket) } };
  });
}

export function decideApproval(token: string | undefined, id: string, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "change.approve") && !allowed(perms, "*")) throw new ApiError(403, "You cannot approve changes.");
    const ticket = findVisibleTicket(db, user, perms, id);
    if (ticket.type !== "change") throw new ApiError(400, "Only changes use this approval.");
    const decision = clean(body.decision, 20);
    const comment = clean(body.comment, 1000);
    if (decision !== "approved" && decision !== "rejected") throw new ApiError(400, "Choose approve or reject.");
    ticket.approvalStatus = decision;
    ticket.approvalComment = comment;
    if (decision === "approved" && ticket.state === "authorize" && db.settings.states.change.some((state) => state.id === "scheduled")) {
      ticket.state = "scheduled";
    }
    if (decision === "rejected") ticket.state = db.settings.states.change.some((state) => state.id === "assess") ? "assess" : ticket.state;
    ticket.updatedAt = nowIso();
    ticket.recordHash = signTicket(ticket);
    db.activities.push({
      id: randomUUID(),
      ticketId: ticket.id,
      kind: "system",
      body: `Change ${decision}${comment ? `: ${comment}` : ""}`,
      authorId: user.id,
      createdAt: ticket.updatedAt,
    });
    appendAudit(db, user, "change.approval", ticket.number, decision);
    notify(db, ticket.requesterId, `${ticket.number} ${decision}`, ticket.title, `/desk/tickets/${ticket.id}`, user.id);
    notify(db, ticket.assigneeId, `${ticket.number} ${decision}`, ticket.title, `/desk/tickets/${ticket.id}`, user.id);
    return { save: true, result: { ticket: publicTicket(db, ticket, true) } };
  });
}

export function deleteTicket(token: string | undefined, id: string, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "ticket.delete") && !allowed(perms, "*")) throw new ApiError(403, "You cannot dispose of records.");
    const ticket = findVisibleTicket(db, user, perms, id);
    if (ticket.phi.present) {
      if (body.confirmDisposal !== true) {
        throw new ApiError(400, "PHI disposal needs an explicit confirmation.");
      }
      const ageDays = (Date.now() - Date.parse(ticket.createdAt)) / 86400000;
      if (ageDays < db.settings.retentionDays && !allowed(perms, "phi.export") && !allowed(perms, "*")) {
        throw new ApiError(400, `This PHI record is inside the ${db.settings.retentionDays}-day retention window.`);
      }
    }
    db.tickets = db.tickets.filter((item) => item.id !== ticket.id);
    db.activities = db.activities.filter((item) => item.ticketId !== ticket.id);
    appendAudit(db, user, "record.disposal", ticket.number, ticket.phi.present ? "Disposed a PHI record" : "Disposed a record");
    return { save: true, result: { ok: true } };
  });
}

function visibleArticle(perms: string[], user: User, article: Article): boolean {
  if (article.state === "draft" && article.authorId !== user.id && !allowed(perms, "knowledge.publish") && !allowed(perms, "knowledge.write") && !allowed(perms, "*")) {
    return false;
  }
  if (article.containsPhi && !allowed(perms, "phi.view") && !allowed(perms, "*") && article.authorId !== user.id) return false;
  return true;
}

export function listKnowledge(token: string | undefined) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!db.settings.modules.knowledge) throw new ApiError(400, "Knowledge is turned off.");
    const articles = db.knowledge
      .filter((article) => visibleArticle(perms, user, article))
      .map((article) => ({
        id: article.id,
        number: article.number,
        title: article.title,
        category: article.category,
        state: article.state,
        containsPhi: article.containsPhi,
        body: article.containsPhi ? "" : article.body,
        authorName: userName(db, article.authorId),
        updatedAt: article.updatedAt,
      }));
    return { save: touchSave(db, token), result: { articles } };
  });
}

export function saveKnowledge(token: string | undefined, id: string | undefined, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "knowledge.write") && !allowed(perms, "*")) throw new ApiError(403, "You cannot edit knowledge.");
    const title = clean(body.title, 180);
    const category = clean(body.category, 80);
    const text = clean(body.body, 12000);
    const containsPhi = Boolean(body.containsPhi);
    const state = clean(body.state, 20) === "published" ? "published" : "draft";
    if (title.length < 4) throw new ApiError(400, "Add a title.");
    assertNoLoosePhi("Title", title);
    if (!containsPhi) assertNoLoosePhi("Article", text);
    if (state === "published" && !allowed(perms, "knowledge.publish") && !allowed(perms, "*")) {
      throw new ApiError(403, "Publishing is limited to knowledge publishers.");
    }
    let article = id ? db.knowledge.find((item) => item.id === id) : undefined;
    if (id && !article) throw new ApiError(404, "Article not found.");
    if (!article) {
      article = {
        id: randomUUID(),
        number: nextNumber(db, "knowledge", "KB"),
        title,
        category,
        body: "",
        containsPhi,
        state,
        authorId: user.id,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.knowledge.unshift(article);
    }
    article.title = title;
    article.category = category;
    article.containsPhi = containsPhi;
    article.state = state;
    article.updatedAt = nowIso();
    if (containsPhi) {
      article.body = "";
      article.phiBody = text ? encryptString(text) : article.phiBody;
    } else {
      article.body = text;
      delete article.phiBody;
    }
    appendAudit(db, user, "knowledge.save", article.number, state);
    return { save: true, result: { id: article.id, number: article.number } };
  });
}

export function listCmdb(token: string | undefined) {
  return exclusive((db) => {
    const { perms } = requireSession(db, token);
    if (!db.settings.modules.cmdb) throw new ApiError(400, "CMDB is turned off.");
    return {
      save: touchSave(db, token),
      result: {
        items: db.cmdb.map((item) => ({ ...item, ownerGroupName: groupName(db, item.ownerGroupId) })),
        canWrite: allowed(perms, "cmdb.write") || allowed(perms, "*"),
      },
    };
  });
}

export function saveCmdb(token: string | undefined, id: string | undefined, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "cmdb.write") && !allowed(perms, "*")) throw new ApiError(403, "You cannot edit the CMDB.");
    const name = clean(body.name, 160);
    if (name.length < 2) throw new ApiError(400, "Name the configuration item.");
    let item = id ? db.cmdb.find((row) => row.id === id) : undefined;
    if (id && !item) throw new ApiError(404, "Configuration item not found.");
    if (!item) {
      item = {
        id: randomUUID(),
        number: nextNumber(db, "cmdb", "CI"),
        name,
        className: "Application",
        status: "in_service",
        environment: "Production",
        ownerGroupId: "",
        assetTag: "",
        description: "",
        updatedAt: nowIso(),
      };
      db.cmdb.unshift(item);
    }
    item.name = name;
    item.className = clean(body.className, 60) || item.className;
    item.status = clean(body.status, 40) || item.status;
    item.environment = clean(body.environment, 40) || item.environment;
    item.ownerGroupId = clean(body.ownerGroupId, 40);
    item.assetTag = clean(body.assetTag, 60);
    item.description = clean(body.description, 2000);
    assertNoLoosePhi("Description", item.description);
    item.updatedAt = nowIso();
    appendAudit(db, user, "cmdb.save", item.number, item.name);
    return { save: true, result: { id: item.id } };
  });
}

export function requestCatalog(token: string | undefined, body: Record<string, unknown>) {
  const itemId = clean(body.itemId, 40);
  const answers = clean(body.details, 4000);
  const patientRef = clean(body.patientRef, 200);
  const phiPurpose = clean(body.phiPurpose, 80);
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!db.settings.modules.catalog || !db.settings.modules.requests) throw new ApiError(400, "The catalog is turned off.");
    if (!allowed(perms, "catalog.request") && !allowed(perms, "ticket.create") && !allowed(perms, "*")) {
      throw new ApiError(403, "You cannot order from the catalog.");
    }
    const item = db.settings.catalog.find((row) => row.id === itemId && row.active);
    if (!item) throw new ApiError(404, "Catalog item not found.");
    assertNoLoosePhi("Request details", answers);
    const createdAt = nowIso();
    const priority = "moderate";
    const dues = dueDates(db.settings, priority, new Date(createdAt));
    const ticket: Ticket = {
      id: randomUUID(),
      number: nextNumber(db, "request", "REQ"),
      type: "request",
      title: item.name,
      description: answers || item.summary,
      state: initialState(db.settings, "request"),
      priority,
      impact: "low",
      urgency: "medium",
      category: item.category,
      channel: "catalog",
      assignmentGroupId: item.groupId,
      assigneeId: "",
      requesterId: user.id,
      cmdbId: "",
      knowledgeId: "",
      relatedIds: [],
      catalogItemId: item.id,
      changeRisk: "",
      windowStart: "",
      windowEnd: "",
      approvalStatus: "none",
      approvalComment: "",
      custom: {},
      phi: blankPhi(),
      responseDue: dues.responseDue,
      resolveDue: dues.resolveDue,
      resolvedAt: "",
      respondedAt: "",
      recordHash: "",
      createdAt,
      updatedAt: createdAt,
      createdBy: user.id,
    };
    if (patientRef) applyPhi(ticket, { patientRef, phiPurpose }, []);
    applyRules(db, ticket, "created");
    ticket.recordHash = signTicket(ticket);
    db.tickets.unshift(ticket);
    db.activities.push({
      id: randomUUID(),
      ticketId: ticket.id,
      kind: "system",
      body: `Requested from the catalog: ${item.name}`,
      authorId: user.id,
      createdAt,
    });
    appendAudit(db, user, "catalog.request", ticket.number, item.name);
    notifyGroup(db, item.groupId, `Catalog request ${ticket.number}`, item.name, `/desk/tickets/${ticket.id}`, user.id);
    return { save: true, result: { id: ticket.id, number: ticket.number } };
  });
}

export function reports(token: string | undefined) {
  return exclusive((db) => {
    const { perms } = requireSession(db, token);
    if (!allowed(perms, "report.read") && !allowed(perms, "*")) throw new ApiError(403, "Reports are hidden for this role.");
    const open = (type: TicketType) => db.tickets.filter((ticket) => ticket.type === type && !isTerminal(db.settings, ticket)).length;
    const byPriority = db.settings.priorities.map((priority) => ({
      id: priority.id,
      label: priority.label,
      tone: priority.tone,
      count: db.tickets.filter((ticket) => ticket.priority === priority.id && !isTerminal(db.settings, ticket)).length,
    }));
    const breaches = db.tickets.filter((ticket) => slaView(db.settings, ticket).resolveBreached).length;
    const resolved = db.tickets.filter((ticket) => ticket.resolvedAt);
    const mttrHours = resolved.length
      ? resolved.reduce((sum, ticket) => sum + (Date.parse(ticket.resolvedAt) - Date.parse(ticket.createdAt)) / 3600000, 0) / resolved.length
      : 0;
    const since = Date.now() - 30 * 86400000;
    const phiEvents = db.audit.filter((event) => event.action.startsWith("phi.") && Date.parse(event.at) >= since);
    const byGroup = db.settings.groups.map((group) => ({
      name: group.name,
      count: db.tickets.filter((ticket) => ticket.assignmentGroupId === group.id && !isTerminal(db.settings, ticket)).length,
    }));
    return {
      save: touchSave(db, token),
      result: {
        open: {
          incident: open("incident"),
          problem: open("problem"),
          change: open("change"),
          request: open("request"),
        },
        byPriority,
        byGroup,
        breaches,
        mttrHours,
        phiReveals: phiEvents.filter((event) => event.action === "phi.reveal").length,
        breakGlass: phiEvents.filter((event) => event.action === "phi.breakglass").length,
        pendingApprovals: db.tickets.filter((ticket) => ticket.approvalStatus === "pending").length,
      },
    };
  });
}

export function hipaa(token: string | undefined) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    const chain = verifyChain(db.audit);
    const canAudit = allowed(perms, "audit.read") || allowed(perms, "*");
    return {
      save: touchSave(db, token),
      result: {
        policy: db.settings.hipaaPolicyText,
        version: policyVersion(db.settings.hipaaPolicyText),
        sessionTimeoutMinutes: db.settings.sessionTimeoutMinutes,
        retentionDays: db.settings.retentionDays,
        acknowledgementRequired: db.settings.requireHipaaAcknowledgement,
        encryption: phiKeyStatus(),
        chain: canAudit ? chain : { intact: chain.intact },
        events: canAudit ? db.audit.slice(-200).reverse() : [],
        grants: db.grants.filter((grant) => grant.userId === user.id && Date.parse(grant.expiresAt) > Date.now()),
      },
    };
  });
}

export function auditCsv(token: string | undefined) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "audit.read") && !allowed(perms, "*")) throw new ApiError(403, "The audit trail is limited to privacy and admin roles.");
    appendAudit(db, user, "audit.export", "audit", "Exported the audit trail");
    const header = ["at", "actor", "action", "target", "detail", "hash"];
    const lines = [header.join(",")];
    for (const event of db.audit) {
      lines.push([event.at, event.actorEmail, event.action, event.target, event.detail, event.hash].map(csvCell).join(","));
    }
    return { save: true, result: { csv: lines.join("\n") } };
  });
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function search(token: string | undefined, qRaw: string) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    const q = clean(qRaw, 80).toLowerCase();
    if (q.length < 2) return { save: false, result: { results: [] } };
    const tickets = db.tickets
      .filter((ticket) => canSeeTicket(perms, user, ticket))
      .filter((ticket) => `${ticket.number} ${ticket.title} ${ticket.description}`.toLowerCase().includes(q))
      .slice(0, 8)
      .map((ticket) => ({ kind: "ticket", id: ticket.id, label: `${ticket.number} ${ticket.title}`, href: `/desk/tickets/${ticket.id}` }));
    const articles = db.knowledge
      .filter((article) => visibleArticle(perms, user, article))
      .filter((article) => `${article.number} ${article.title} ${article.containsPhi ? "" : article.body}`.toLowerCase().includes(q))
      .slice(0, 5)
      .map((article) => ({ kind: "knowledge", id: article.id, label: `${article.number} ${article.title}`, href: `/desk/knowledge?id=${article.id}` }));
    const items = db.settings.modules.cmdb
      ? db.cmdb
          .filter((item) => `${item.number} ${item.name} ${item.className}`.toLowerCase().includes(q))
          .slice(0, 5)
          .map((item) => ({ kind: "cmdb", id: item.id, label: `${item.number} ${item.name}`, href: `/desk/cmdb?id=${item.id}` }))
      : [];
    return { save: touchSave(db, token), result: { results: [...tickets, ...articles, ...items] } };
  });
}

export function markNotifications(token: string | undefined, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user } = requireSession(db, token);
    const all = body.all === true;
    const ids = Array.isArray(body.ids) ? body.ids.map((item) => clean(item, 40)) : [];
    for (const note of db.notifications) {
      if (note.userId === user.id && (all || ids.includes(note.id))) note.read = true;
    }
    return { save: true, result: { ok: true } };
  });
}

export function getSettings(token: string | undefined) {
  return exclusive((db) => {
    const { perms } = requireSession(db, token);
    if (!allowed(perms, "admin.settings") && !allowed(perms, "*")) throw new ApiError(403, "Organization settings are limited to administrators.");
    return { save: false, result: { settings: db.settings, roles: db.roles } };
  });
}

export function saveSettings(token: string | undefined, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user, perms } = requireSession(db, token);
    if (!allowed(perms, "admin.settings") && !allowed(perms, "*")) throw new ApiError(403, "Organization settings are limited to administrators.");
    const settings = body.settings as Settings;
    validateSettings(settings);
    if (settings.webhookUrl && !safeWebhook(settings.webhookUrl)) {
      throw new ApiError(400, "The webhook must be an https URL on a public host.");
    }
    const roles = Array.isArray(body.roles) ? (body.roles as Role[]) : db.roles;
    if (!roles.some((role) => role.permissions.includes("*"))) {
      throw new ApiError(400, "Keep one role with full administrative access.");
    }
    db.settings = settings;
    db.roles = roles.map((role) => ({
      id: clean(role.id, 40),
      name: clean(role.name, 80),
      description: clean(role.description, 200),
      permissions: Array.isArray(role.permissions) ? role.permissions.map((item) => clean(item, 40)).filter(Boolean) : [],
    }));
    appendAudit(db, user, "settings.update", "organization", "Updated organization configuration");
    return { save: true, result: { ok: true, version: policyVersion(settings.hipaaPolicyText) } };
  });
}

function validateSettings(settings: Settings) {
  if (!settings || typeof settings !== "object") throw new ApiError(400, "Settings are missing.");
  if (!clean(settings.orgName, 80)) throw new ApiError(400, "Organization name is required.");
  if (!/^#[0-9a-fA-F]{6}$/.test(settings.accent || "")) throw new ApiError(400, "Accent color must be a hex value like #0E6B64.");
  if (settings.sessionTimeoutMinutes < 5 || settings.sessionTimeoutMinutes > 240) {
    throw new ApiError(400, "Session timeout must be between 5 and 240 minutes.");
  }
  if (settings.retentionDays < 30 || settings.retentionDays > 3650) {
    throw new ApiError(400, "Retention must be between 30 and 3650 days.");
  }
  if (!settings.businessHours?.days?.length) throw new ApiError(400, "Choose at least one business day for SLA clocks.");
  for (const type of ["incident", "problem", "change", "request"] as TicketType[]) {
    if (!settings.states?.[type]?.length) throw new ApiError(400, `Add at least one state for ${type}.`);
  }
  if (!settings.priorities?.length) throw new ApiError(400, "Add at least one priority.");
}

export function listUsers(token: string | undefined) {
  return exclusive((db) => {
    const { perms } = requireSession(db, token);
    if (!allowed(perms, "admin.users") && !allowed(perms, "*")) throw new ApiError(403, "People administration is limited to administrators.");
    return {
      save: false,
      result: { users: db.users.map((user) => toSafeUser(db, user)), roles: db.roles, groups: db.settings.groups },
    };
  });
}

export function saveUser(token: string | undefined, id: string | undefined, body: Record<string, unknown>) {
  return exclusive((db) => {
    const { user: actor, perms } = requireSession(db, token);
    if (!allowed(perms, "admin.users") && !allowed(perms, "*")) throw new ApiError(403, "People administration is limited to administrators.");
    const name = clean(body.name, 80);
    const email = clean(body.email, 160).toLowerCase();
    const roleIds = Array.isArray(body.roleIds) ? body.roleIds.map((item) => clean(item, 40)).filter(Boolean) : [];
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds.map((item) => clean(item, 40)).filter(Boolean) : [];
    const active = body.active !== false;
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Name and a valid email are required.");
    if (!roleIds.length) throw new ApiError(400, "Assign at least one role.");
    let person = id ? db.users.find((item) => item.id === id) : undefined;
    if (id && !person) throw new ApiError(404, "Person not found.");
    if (db.users.some((item) => item.email === email && item.id !== person?.id)) throw new ApiError(400, "That email is already in use.");
    if (!person) {
      const password = typeof body.password === "string" ? body.password : "";
      assertPassword(password);
      person = {
        id: randomUUID(),
        name,
        email,
        passwordHash: hashPassword(password),
        roleIds,
        groupIds,
        active,
        createdAt: nowIso(),
      };
      db.users.push(person);
    } else {
      person.name = name;
      person.email = email;
      person.roleIds = roleIds;
      person.groupIds = groupIds;
      person.active = active;
      if (typeof body.password === "string" && body.password) {
        assertPassword(body.password);
        person.passwordHash = hashPassword(body.password);
      }
    }
    const admins = db.users.filter((item) => item.active && permissionsFor(db, item).includes("*"));
    if (!admins.length) throw new ApiError(400, "Keep at least one active administrator.");
    appendAudit(db, actor, "user.update", person.email, id ? "Updated a person" : "Added a person");
    return { save: true, result: { user: toSafeUser(db, person) } };
  });
}

function role(id: string, name: string, description: string, permissions: string[]): Role {
  return { id, name, description, permissions };
}

function user(id: string, name: string, email: string, roleIds: string[], groupIds: string[]): User {
  return {
    id,
    name,
    email,
    passwordHash: hashPassword(DEMO_PASSWORD),
    roleIds,
    groupIds,
    active: true,
    createdAt: nowIso(),
  };
}

function ticket(partial: Pick<Ticket, "id" | "number" | "type" | "title" | "description" | "state" | "priority" | "impact" | "urgency" | "category" | "assignmentGroupId" | "assigneeId" | "requesterId"> & Partial<Ticket>, settings: Settings): Ticket {
  const createdAt = partial.createdAt || new Date(Date.now() - 1000 * 60 * 90).toISOString();
  const dues = dueDates(settings, partial.priority, new Date(createdAt));
  const row: Ticket = {
    cmdbId: "",
    knowledgeId: "",
    relatedIds: [],
    catalogItemId: "",
    changeRisk: "",
    windowStart: "",
    windowEnd: "",
    approvalStatus: "none",
    approvalComment: "",
    custom: {},
    phi: blankPhi(),
    channel: "phone",
    responseDue: dues.responseDue,
    resolveDue: dues.resolveDue,
    resolvedAt: "",
    respondedAt: "",
    recordHash: "",
    createdAt,
    updatedAt: partial.updatedAt || createdAt,
    createdBy: partial.requesterId,
    ...partial,
  };
  if (!partial.respondedAt && partial.state !== "new") row.respondedAt = createdAt;
  row.recordHash = signTicket(row);
  return row;
}

function seed(): Database {
  const settings: Settings = {
    orgName: "Northwind Community Health",
    tagline: "Care operations, requests, and changes in one desk.",
    accent: "#0E6B64",
    showDemoBanner: true,
    modules: {
      incidents: true,
      problems: true,
      changes: true,
      requests: true,
      catalog: true,
      knowledge: true,
      cmdb: true,
      reports: true,
    },
    sessionTimeoutMinutes: 20,
    retentionDays: 2555,
    requireHipaaAcknowledgement: true,
    hipaaPolicyText:
      "Use Dharma Service Desk for the minimum information needed to restore a service, fulfill a request, or investigate a privacy event. Protected health information belongs only in fields marked PHI. Do not place it in titles, public comments, or knowledge articles unless that article is itself marked PHI. Open PHI only for treatment, payment, healthcare operations, or a privacy review, and expect every open to be logged. Report a misdirected record to the Privacy Office before you copy it anywhere else. Sessions lock after inactivity so a shared workstation does not stay signed in. This text is a sample policy your organization can replace. It is not legal advice, and installing this software does not by itself make an organization HIPAA compliant.",
    webhookUrl: "",
    priorities: [
      { id: "critical", label: "Critical", responseMinutes: 15, resolveMinutes: 240, tone: "critical" },
      { id: "high", label: "High", responseMinutes: 60, resolveMinutes: 480, tone: "high" },
      { id: "moderate", label: "Moderate", responseMinutes: 240, resolveMinutes: 1440, tone: "moderate" },
      { id: "low", label: "Low", responseMinutes: 480, resolveMinutes: 4320, tone: "low" },
      { id: "planning", label: "Planning", responseMinutes: 1440, resolveMinutes: 10080, tone: "planning" },
    ],
    states: {
      incident: [
        { id: "new", label: "New" },
        { id: "in_progress", label: "In progress" },
        { id: "on_hold", label: "On hold" },
        { id: "resolved", label: "Resolved", terminal: true },
        { id: "closed", label: "Closed", terminal: true },
      ],
      problem: [
        { id: "new", label: "New" },
        { id: "root_cause", label: "Root cause analysis" },
        { id: "known_error", label: "Known error" },
        { id: "resolved", label: "Resolved", terminal: true },
        { id: "closed", label: "Closed", terminal: true },
      ],
      change: [
        { id: "new", label: "New" },
        { id: "assess", label: "Assess" },
        { id: "authorize", label: "Authorize" },
        { id: "scheduled", label: "Scheduled" },
        { id: "implement", label: "Implement" },
        { id: "review", label: "Review" },
        { id: "closed", label: "Closed", terminal: true },
        { id: "cancelled", label: "Cancelled", terminal: true },
      ],
      request: [
        { id: "new", label: "New" },
        { id: "in_progress", label: "In progress" },
        { id: "fulfilled", label: "Fulfilled", terminal: true },
        { id: "closed", label: "Closed", terminal: true },
      ],
    },
    transitions: {
      incident: {
        new: ["in_progress", "on_hold", "resolved"],
        in_progress: ["on_hold", "resolved"],
        on_hold: ["in_progress", "resolved"],
        resolved: ["closed", "in_progress"],
        closed: [],
      },
      problem: {
        new: ["root_cause", "known_error"],
        root_cause: ["known_error", "resolved"],
        known_error: ["resolved"],
        resolved: ["closed", "root_cause"],
        closed: [],
      },
      change: {
        new: ["assess", "cancelled"],
        assess: ["authorize", "cancelled"],
        authorize: ["assess", "cancelled"],
        scheduled: ["implement", "cancelled"],
        implement: ["review", "cancelled"],
        review: ["closed", "implement"],
        closed: [],
        cancelled: [],
      },
      request: {
        new: ["in_progress", "fulfilled"],
        in_progress: ["fulfilled", "new"],
        fulfilled: ["closed", "in_progress"],
        closed: [],
      },
    },
    categories: [
      { id: "ehr", type: "incident", name: "EHR" },
      { id: "access", type: "incident", name: "Access" },
      { id: "network", type: "incident", name: "Network" },
      { id: "device", type: "incident", name: "Clinical device" },
      { id: "privacy", type: "incident", name: "Privacy" },
      { id: "interface", type: "problem", name: "Interface" },
      { id: "patch", type: "change", name: "Patch" },
      { id: "network-change", type: "change", name: "Network" },
      { id: "identity", type: "catalog", name: "Identity" },
      { id: "workplace", type: "catalog", name: "Workplace" },
      { id: "howto", type: "knowledge", name: "How-to" },
      { id: "privacy-kb", type: "knowledge", name: "Privacy" },
    ],
    customFields: [
      {
        id: "location",
        label: "Location",
        ticketTypes: ["incident", "request"],
        input: "text",
        options: [],
        required: false,
        phi: false,
      },
      {
        id: "callback",
        label: "Callback extension",
        ticketTypes: ["incident", "request"],
        input: "text",
        options: [],
        required: false,
        phi: false,
      },
    ],
    rules: [
      {
        id: "critical-major",
        name: "Critical incidents go to Major Incident",
        enabled: true,
        event: "created",
        type: "incident",
        priority: "critical",
        action: "assign_group",
        actionValue: "g-major",
      },
    ],
    groups: [
      { id: "g-desk", name: "Service Desk", description: "First contact for staff" },
      { id: "g-clinical", name: "Clinical Applications", description: "EHR and ancillary systems" },
      { id: "g-infra", name: "Infrastructure", description: "Network, identity, and platforms" },
      { id: "g-major", name: "Major Incident", description: "Sev-1 coordination" },
      { id: "g-privacy", name: "Privacy Office", description: "HIPAA and privacy events" },
    ],
    catalog: [
      {
        id: "cat-laptop",
        name: "New laptop",
        category: "Workplace",
        summary: "Standard clinical or business laptop with encryption.",
        details: "Include the department, start date, and whether the person needs EHR access.",
        groupId: "g-desk",
        active: true,
      },
      {
        id: "cat-ehr",
        name: "EHR access",
        category: "Identity",
        summary: "Request a role in the inpatient EHR.",
        details: "Name the role template and the supervising manager. Do not include a patient record.",
        groupId: "g-clinical",
        active: true,
      },
      {
        id: "cat-reset",
        name: "Password reset",
        category: "Identity",
        summary: "Unlock a workforce account after the service desk verifies identity.",
        details: "Share the callback extension only.",
        groupId: "g-desk",
        active: true,
      },
      {
        id: "cat-badge",
        name: "Badge access",
        category: "Workplace",
        summary: "Door access for a unit or department.",
        details: "Name the doors and the end date for temporary access.",
        groupId: "g-infra",
        active: true,
      },
    ],
    businessHours: { start: "08:00", end: "18:00", days: [1, 2, 3, 4, 5] },
  };

  const roles = [
    role("admin", "Administrator", "Configures the organization and people", ["*"]),
    role("privacy_officer", "Privacy officer", "Reviews PHI access and the audit trail", ["ticket.read", "phi.view", "phi.export", "phi.breakglass", "audit.read", "report.read"]),
    role("agent", "Service desk agent", "Works the queues", ["ticket.read", "ticket.create", "ticket.update", "ticket.assign", "phi.view", "knowledge.write", "catalog.request", "report.read"]),
    role("change_manager", "Change manager", "Approves and schedules changes", ["ticket.read", "ticket.create", "ticket.update", "ticket.assign", "change.approve", "cmdb.write", "phi.view", "report.read", "catalog.request"]),
    role("requester", "Requester", "Opens incidents and catalog requests", ["ticket.read", "ticket.create", "catalog.request"]),
    role("knowledge_author", "Knowledge author", "Writes and publishes articles", ["ticket.read", "knowledge.write", "knowledge.publish", "catalog.request"]),
  ];

  const users = [
    user("user-avery", "Avery Chen", "avery.chen@northwind.example", ["admin"], ["g-desk"]),
    user("user-jordan", "Jordan Blake", "jordan.blake@northwind.example", ["privacy_officer"], ["g-privacy"]),
    user("user-samir", "Samir Patel", "samir.patel@northwind.example", ["agent"], ["g-desk", "g-major"]),
    user("user-riley", "Riley Nguyen", "riley.nguyen@northwind.example", ["change_manager"], ["g-infra"]),
    user("user-quinn", "Quinn Alvarez", "quinn.alvarez@northwind.example", ["requester"], []),
    user("user-morgan", "Morgan Ellis", "morgan.ellis@northwind.example", ["knowledge_author"], ["g-clinical"]),
  ];

  const phiTicket = ticket(
    {
      id: "t-phi",
      number: "INC0001004",
      type: "incident",
      title: "Printed lab summary left in the wrong clinic bin",
      description: "A staff member found a printed lab summary in the outpatient bin. The paper is secured at the nurses station. No identifier is written here.",
      state: "in_progress",
      priority: "critical",
      impact: "high",
      urgency: "high",
      category: "Privacy",
      assignmentGroupId: "g-privacy",
      assigneeId: "user-jordan",
      requesterId: "user-quinn",
      channel: "phone",
      phi: {
        present: true,
        purpose: "Privacy review",
        patientRef: encryptString("Case token DEMO-00421"),
        clinicalNote: encryptString("Fictional demo only: a printed lab summary for case token DEMO-00421 was placed in the outpatient bin instead of the inpatient bin. No real patient is described."),
        custom: {},
      },
    },
    settings,
  );

  const tickets: Ticket[] = [
    ticket(
      {
        id: "t-ehr",
        number: "INC0001001",
        type: "incident",
        title: "Inpatient EHR is slow on 4 West",
        description: "Nurses report 20 second chart opens since 07:10. Pharmacy verification is also delayed. No patient detail in this note.",
        state: "in_progress",
        priority: "high",
        impact: "high",
        urgency: "medium",
        category: "EHR",
        assignmentGroupId: "g-clinical",
        assigneeId: "user-samir",
        requesterId: "user-quinn",
        cmdbId: "ci-ehr",
        custom: { location: "4 West" },
      },
      settings,
    ),
    ticket(
      {
        id: "t-vpn",
        number: "INC0001002",
        type: "incident",
        title: "VPN token expired for the night hospitalist",
        description: "Remote chart access fails at the token prompt. Identity verification is complete. Callback extension 4412.",
        state: "new",
        priority: "moderate",
        impact: "medium",
        urgency: "medium",
        category: "Access",
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(),
        assignmentGroupId: "g-desk",
        assigneeId: "",
        requesterId: "user-quinn",
        custom: { callback: "4412" },
      },
      settings,
    ),
    ticket(
      {
        id: "t-badge",
        number: "INC0001003",
        type: "incident",
        title: "Badge printer at the east entrance is jammed",
        description: "New staff cannot be badged on site. Facilities has the spare printer staged.",
        state: "on_hold",
        priority: "low",
        impact: "low",
        urgency: "medium",
        category: "Access",
        assignmentGroupId: "g-infra",
        assigneeId: "user-riley",
        requesterId: "user-samir",
      },
      settings,
    ),
    phiTicket,
    ticket(
      {
        id: "t-problem",
        number: "PRB0001001",
        type: "problem",
        title: "Lab interface timeouts after the nightly extract",
        description: "Results queue backs up for about 15 minutes every night at 01:00. Related to the inpatient EHR slowness reports.",
        state: "root_cause",
        priority: "high",
        impact: "high",
        urgency: "medium",
        category: "Interface",
        assignmentGroupId: "g-clinical",
        assigneeId: "user-samir",
        requesterId: "user-samir",
        cmdbId: "ci-lab",
        relatedIds: ["t-ehr"],
        knowledgeId: "kb-vpn",
      },
      settings,
    ),
    ticket(
      {
        id: "t-change",
        number: "CHG0001001",
        type: "change",
        title: "Monthly inpatient EHR patch window",
        description: "Apply the vendor maintenance pack on Saturday 01:00-03:00. Rollback is the previous application snapshot.",
        state: "authorize",
        priority: "moderate",
        impact: "high",
        urgency: "low",
        category: "Patch",
        assignmentGroupId: "g-clinical",
        assigneeId: "user-riley",
        requesterId: "user-riley",
        cmdbId: "ci-ehr",
        changeRisk: "moderate",
        windowStart: "2026-10-04T05:00",
        windowEnd: "2026-10-04T07:00",
        approvalStatus: "pending",
      },
      settings,
    ),
    ticket(
      {
        id: "t-fw",
        number: "CHG0001002",
        type: "change",
        title: "Allow imaging archive traffic from clinic B",
        description: "Open the documented imaging port from clinic B to the archive. Change is already approved.",
        state: "scheduled",
        priority: "low",
        impact: "medium",
        urgency: "low",
        category: "Network",
        assignmentGroupId: "g-infra",
        assigneeId: "user-riley",
        requesterId: "user-riley",
        cmdbId: "ci-pacs",
        changeRisk: "low",
        approvalStatus: "approved",
        approvalComment: "Window is outside clinic hours.",
      },
      settings,
    ),
    ticket(
      {
        id: "t-laptop",
        number: "REQ0001001",
        type: "request",
        title: "New laptop",
        description: "Nurse educator starts Monday in clinical education. Standard encrypted laptop, no patient information attached.",
        state: "in_progress",
        priority: "moderate",
        impact: "low",
        urgency: "medium",
        category: "Workplace",
        assignmentGroupId: "g-desk",
        assigneeId: "user-samir",
        requesterId: "user-quinn",
        catalogItemId: "cat-laptop",
        channel: "catalog",
      },
      settings,
    ),
    ticket(
      {
        id: "t-access",
        number: "REQ0001002",
        type: "request",
        title: "EHR access",
        description: "Float pool nurse needs the inpatient nurse template. Manager approval is attached in the staffing office.",
        state: "new",
        priority: "moderate",
        impact: "medium",
        urgency: "medium",
        category: "Identity",
        assignmentGroupId: "g-clinical",
        assigneeId: "",
        requesterId: "user-quinn",
        catalogItemId: "cat-ehr",
        channel: "catalog",
      },
      settings,
    ),
  ];

  const activities: Activity[] = [
    { id: randomUUID(), ticketId: "t-ehr", kind: "work_note", body: "Checked the application nodes. CPU is fine. Looking at the lab interface next.", authorId: "user-samir", createdAt: nowIso() },
    { id: randomUUID(), ticketId: "t-ehr", kind: "comment", body: "We can still document on paper downtime forms if chart opens stay over 30 seconds.", authorId: "user-samir", createdAt: nowIso() },
    { id: randomUUID(), ticketId: "t-phi", kind: "work_note", body: "Paper is in the privacy lockbox. Waiting on the unit to confirm who printed it.", authorId: "user-jordan", createdAt: nowIso() },
    { id: randomUUID(), ticketId: "t-change", kind: "system", body: "Waiting on change approval before the Saturday window.", authorId: "user-riley", createdAt: nowIso() },
  ];

  const knowledge: Article[] = [
    {
      id: "kb-workstation",
      number: "KB0001001",
      title: "Restart a frozen clinical workstation",
      category: "How-to",
      body: "Save any open administrative note that does not contain patient detail. Hold the power button for five seconds, wait ten seconds, and sign back in with your own workforce account. Do not use a shared password.",
      containsPhi: false,
      state: "published",
      authorId: "user-morgan",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: "kb-vpn",
      number: "KB0001002",
      title: "Request a replacement VPN token",
      category: "How-to",
      body: "Call the service desk from a known callback number. The analyst will verify your employee id and department, then issue a temporary token. Do not send a photo of a patient chart to prove who you are.",
      containsPhi: false,
      state: "published",
      authorId: "user-morgan",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: "kb-phi",
      number: "KB0001003",
      title: "What to do with a misdirected clinical paper",
      category: "Privacy",
      body: "",
      phiBody: encryptString("Fictional procedure: cover the paper, walk it to the privacy lockbox, and open a privacy incident. Record only a case token in the PHI field. Do not read the document aloud at the desk."),
      containsPhi: true,
      state: "published",
      authorId: "user-jordan",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
    {
      id: "kb-freeze",
      number: "KB0001004",
      title: "Change freeze on the inpatient EHR",
      category: "How-to",
      body: "No routine EHR changes on Fridays after 15:00 local time, or on hospital holidays. Emergency changes still go through the change manager and need a rollback note.",
      containsPhi: false,
      state: "published",
      authorId: "user-riley",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    },
  ];

  const cmdb: Ci[] = [
    { id: "ci-ehr", number: "CI0001001", name: "Inpatient EHR", className: "Application", status: "in_service", environment: "Production", ownerGroupId: "g-clinical", assetTag: "APP-EHR", description: "Primary inpatient charting application.", updatedAt: nowIso() },
    { id: "ci-lab", number: "CI0001002", name: "Lab interface engine", className: "Application", status: "in_service", environment: "Production", ownerGroupId: "g-clinical", assetTag: "APP-LAB", description: "Routes lab results into the EHR.", updatedAt: nowIso() },
    { id: "ci-vpn", number: "CI0001003", name: "Remote access gateway", className: "Network", status: "in_service", environment: "Production", ownerGroupId: "g-infra", assetTag: "NET-VPN", description: "Workforce VPN concentrator.", updatedAt: nowIso() },
    { id: "ci-pacs", number: "CI0001004", name: "Imaging archive", className: "Application", status: "in_service", environment: "Production", ownerGroupId: "g-infra", assetTag: "APP-IMG", description: "Stores diagnostic images.", updatedAt: nowIso() },
    { id: "ci-ws", number: "CI0001005", name: "4 West nurse station", className: "Workstation", status: "in_service", environment: "Production", ownerGroupId: "g-desk", assetTag: "WS-4W-02", description: "Shared workstation. Individual sign-in is required.", updatedAt: nowIso() },
    { id: "ci-id", number: "CI0001006", name: "Workforce identity provider", className: "Application", status: "in_service", environment: "Production", ownerGroupId: "g-infra", assetTag: "APP-IDP", description: "Single sign-on for workforce applications.", updatedAt: nowIso() },
  ];

  const db: Database = {
    version: 1,
    settings,
    roles,
    users,
    sessions: [],
    tickets,
    activities,
    knowledge,
    cmdb,
    notifications: [
      {
        id: randomUUID(),
        userId: "user-riley",
        title: "Approval needed CHG0001001",
        body: "Monthly inpatient EHR patch window",
        href: "/desk/tickets/t-change",
        read: false,
        createdAt: nowIso(),
      },
      {
        id: randomUUID(),
        userId: "user-samir",
        title: "Assigned INC0001001",
        body: "Inpatient EHR is slow on 4 West",
        href: "/desk/tickets/t-ehr",
        read: false,
        createdAt: nowIso(),
      },
    ],
    audit: [],
    grants: [],
    counters: { incident: 1004, problem: 1001, change: 1002, request: 1002, knowledge: 1004, cmdb: 1006 },
  };
  appendAudit(db, users[0], "seed", "organization", "Loaded the Northwind sample organization");
  appendAudit(db, users[1], "phi.reveal", "INC0001004", "purpose=Privacy review");
  return db;
}
