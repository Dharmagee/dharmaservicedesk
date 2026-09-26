export type TicketType = "incident" | "problem" | "change" | "request";

export interface EncryptedBlob {
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  permissions: string[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  roleIds: string[];
  groupIds: string[];
  active: boolean;
  acknowledgedPolicyVersion?: string;
  createdAt: string;
}

export interface Session {
  token: string;
  userId: string;
  createdAt: string;
  lastSeen: string;
}

export interface Group {
  id: string;
  name: string;
  description: string;
}

export interface Priority {
  id: string;
  label: string;
  responseMinutes: number;
  resolveMinutes: number;
  tone: "critical" | "high" | "moderate" | "low" | "planning";
}

export interface StateDef {
  id: string;
  label: string;
  terminal?: boolean;
}

export interface Category {
  id: string;
  type: TicketType | "knowledge" | "catalog";
  name: string;
}

export interface CustomField {
  id: string;
  label: string;
  ticketTypes: TicketType[];
  input: "text" | "textarea" | "select";
  options: string[];
  required: boolean;
  phi: boolean;
}

export interface WorkflowRule {
  id: string;
  name: string;
  enabled: boolean;
  event: "created" | "updated";
  type: TicketType | "any";
  priority: string | "any";
  action: "assign_group" | "set_state" | "require_approval";
  actionValue: string;
}

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  summary: string;
  details: string;
  groupId: string;
  active: boolean;
}

export interface BusinessHours {
  start: string;
  end: string;
  days: number[];
}

export interface ModuleFlags {
  incidents: boolean;
  problems: boolean;
  changes: boolean;
  requests: boolean;
  catalog: boolean;
  knowledge: boolean;
  cmdb: boolean;
  reports: boolean;
}

export interface Settings {
  orgName: string;
  tagline: string;
  accent: string;
  showDemoBanner: boolean;
  modules: ModuleFlags;
  sessionTimeoutMinutes: number;
  retentionDays: number;
  requireHipaaAcknowledgement: boolean;
  hipaaPolicyText: string;
  webhookUrl: string;
  priorities: Priority[];
  states: Record<TicketType, StateDef[]>;
  transitions: Record<TicketType, Record<string, string[]>>;
  categories: Category[];
  customFields: CustomField[];
  rules: WorkflowRule[];
  groups: Group[];
  catalog: CatalogItem[];
  businessHours: BusinessHours;
}

export interface PhiPayload {
  present: boolean;
  purpose: string;
  patientRef?: EncryptedBlob;
  clinicalNote?: EncryptedBlob;
  custom: Record<string, EncryptedBlob>;
}

export interface Ticket {
  id: string;
  number: string;
  type: TicketType;
  title: string;
  description: string;
  state: string;
  priority: string;
  impact: "high" | "medium" | "low";
  urgency: "high" | "medium" | "low";
  category: string;
  channel: string;
  assignmentGroupId: string;
  assigneeId: string;
  requesterId: string;
  cmdbId: string;
  knowledgeId: string;
  relatedIds: string[];
  catalogItemId: string;
  changeRisk: string;
  windowStart: string;
  windowEnd: string;
  approvalStatus: "none" | "pending" | "approved" | "rejected";
  approvalComment: string;
  custom: Record<string, string>;
  phi: PhiPayload;
  responseDue: string;
  resolveDue: string;
  resolvedAt: string;
  respondedAt: string;
  recordHash: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface Activity {
  id: string;
  ticketId: string;
  kind: "comment" | "work_note" | "system";
  body: string;
  authorId: string;
  createdAt: string;
}

export interface Article {
  id: string;
  number: string;
  title: string;
  category: string;
  body: string;
  phiBody?: EncryptedBlob;
  containsPhi: boolean;
  state: "draft" | "published";
  authorId: string;
  updatedAt: string;
  createdAt: string;
}

export interface Ci {
  id: string;
  number: string;
  name: string;
  className: string;
  status: string;
  environment: string;
  ownerGroupId: string;
  assetTag: string;
  description: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  title: string;
  body: string;
  href: string;
  read: boolean;
  createdAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  actorId: string;
  actorEmail: string;
  action: string;
  target: string;
  detail: string;
  prevHash: string;
  hash: string;
}

export interface Grant {
  id: string;
  userId: string;
  target: string;
  expiresAt: string;
  reason: string;
  emergency: boolean;
}

export interface Database {
  version: 1;
  settings: Settings;
  roles: Role[];
  users: User[];
  sessions: Session[];
  tickets: Ticket[];
  activities: Activity[];
  knowledge: Article[];
  cmdb: Ci[];
  notifications: Notification[];
  audit: AuditEvent[];
  grants: Grant[];
  counters: Record<string, number>;
}

export interface SafeUser {
  id: string;
  name: string;
  email: string;
  roleIds: string[];
  roleNames: string[];
  groupIds: string[];
  active: boolean;
  permissions: string[];
  acknowledgedPolicyVersion?: string;
}

export const PERMISSIONS: { id: string; label: string }[] = [
  { id: "ticket.read", label: "Read queues" },
  { id: "ticket.create", label: "Create records" },
  { id: "ticket.update", label: "Update any record" },
  { id: "ticket.assign", label: "Assign work" },
  { id: "ticket.delete", label: "Dispose records" },
  { id: "phi.view", label: "View PHI for a stated purpose" },
  { id: "phi.export", label: "Export PHI" },
  { id: "phi.breakglass", label: "Emergency break-the-glass" },
  { id: "change.approve", label: "Approve changes" },
  { id: "knowledge.write", label: "Write knowledge" },
  { id: "knowledge.publish", label: "Publish knowledge" },
  { id: "cmdb.write", label: "Update CMDB" },
  { id: "catalog.request", label: "Order from catalog" },
  { id: "admin.users", label: "Manage people" },
  { id: "admin.settings", label: "Configure the organization" },
  { id: "audit.read", label: "Read the audit trail" },
  { id: "report.read", label: "View reports" },
];

export const PHI_PURPOSES = [
  "Treatment",
  "Payment",
  "Healthcare operations",
  "Privacy review",
] as const;
