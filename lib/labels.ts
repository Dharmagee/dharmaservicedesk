import type { TicketType } from "./types";

export const TYPE_LABEL: Record<TicketType, string> = {
  incident: "Incidents",
  problem: "Problems",
  change: "Changes",
  request: "Requests",
};

export const TYPE_SINGULAR: Record<TicketType, string> = {
  incident: "Incident",
  problem: "Problem",
  change: "Change",
  request: "Request",
};

export const PREFIX: Record<TicketType, string> = {
  incident: "INC",
  problem: "PRB",
  change: "CHG",
  request: "REQ",
};

export function formatWhen(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function can(permissions: string[] | undefined, permission: string): boolean {
  if (!permissions) return false;
  return permissions.includes("*") || permissions.includes(permission);
}
