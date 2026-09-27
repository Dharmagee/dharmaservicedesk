"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { api } from "@/components/api";
import { useSession } from "@/components/Shell";
import { PublicTicket } from "@/components/models";
import { PHI_PURPOSES } from "@/lib/types";
import { TYPE_LABEL, can, formatWhen } from "@/lib/labels";
import type { TicketType } from "@/lib/types";

export function TicketQueue({ type }: { type: TicketType }) {
  const session = useSession();
  const router = useRouter();
  const [tickets, setTickets] = useState<PublicTicket[]>([]);
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [priority, setPriority] = useState("");
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    impact: "medium",
    urgency: "medium",
    priority: "",
    category: "",
    assignmentGroupId: "",
    patientRef: "",
    clinicalNote: "",
    phiPurpose: "",
    changeRisk: "moderate",
    windowStart: "",
    windowEnd: "",
  });

  function filters() {
    const params = new URLSearchParams({ type });
    if (q) params.set("q", q);
    if (state) params.set("state", state);
    if (priority) params.set("priority", priority);
    const seesAll = can(session.user.permissions, "ticket.update") || can(session.user.permissions, "audit.read");
    if (mine || !seesAll) params.set("mine", "1");
    return params;
  }

  function load() {
    api<{ tickets: PublicTicket[] }>(`/api/tickets?${filters().toString()}`).then((data) => setTickets(data.tickets)).catch((err) => setError(err.message));
  }

  async function exportExcel() {
    setError("");
    setExporting(true);
    try {
      const response = await fetch(`/api/tickets/export?${filters().toString()}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Could not export incidents");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const match = (response.headers.get("Content-Disposition") || "").match(/filename="([^"]+)"/);
      anchor.href = url;
      anchor.download = match?.[1] || "incidents.xlsx";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export incidents");
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, state, priority, mine]);

  function labelState(id: string) {
    return session.settings.states[type]?.find((item) => item.id === id)?.label || id;
  }

  function tone(id: string) {
    return session.settings.priorities.find((item) => item.id === id)?.tone || "planning";
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ ticket: PublicTicket }>("/api/tickets", {
        method: "POST",
        body: JSON.stringify({ type, ...form, priority: form.priority || undefined }),
      });
      setOpen(false);
      router.push(`/desk/tickets/${result.ticket.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the record");
    }
  }

  const categories = session.settings.categories.filter((item) => item.type === type);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>{TYPE_LABEL[type]}</h1>
          <p className="note">{session.settings.orgName}</p>
        </div>
        <div className="row-actions">
          {type === "incident" ? (
            <button className="btn secondary" type="button" onClick={exportExcel} disabled={exporting}>
              {exporting ? "Exporting…" : "Export to Excel"}
            </button>
          ) : null}
          {can(session.user.permissions, "ticket.create") ? <button className="btn" onClick={() => setOpen(true)}>New {type}</button> : null}
        </div>
      </div>
      {error ? <div className="error" style={{ marginBottom: 12 }}>{error}</div> : null}
      <div className="filters">
        <input placeholder="Search titles" value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") load(); }} />
        <select value={state} onChange={(event) => setState(event.target.value)}>
          <option value="">Any state</option>
          {session.settings.states[type]?.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <select value={priority} onChange={(event) => setPriority(event.target.value)}>
          <option value="">Any priority</option>
          {session.settings.priorities.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        {can(session.user.permissions, "ticket.update") || can(session.user.permissions, "audit.read") ? (
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} /> Mine
          </label>
        ) : null}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Number</th><th>Title</th><th>State</th><th>Priority</th><th>Group</th><th>SLA</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {tickets.length ? tickets.map((ticket) => (
              <tr key={ticket.id} className="clickable" onClick={() => router.push(`/desk/tickets/${ticket.id}`)}>
                <td className="mono"><Link href={`/desk/tickets/${ticket.id}`}>{ticket.number}{ticket.phi.present ? " · PHI" : ""}</Link></td>
                <td>{ticket.title}</td>
                <td>{labelState(ticket.state)}</td>
                <td><span className={`pill ${tone(ticket.priority)}`}>{session.settings.priorities.find((item) => item.id === ticket.priority)?.label || ticket.priority}</span></td>
                <td>{ticket.assignmentGroupName}</td>
                <td>{ticket.sla.resolveBreached || ticket.sla.responseBreached ? <span className="pill critical">Breached</span> : "On track"}</td>
                <td>{formatWhen(ticket.updatedAt)}</td>
              </tr>
            )) : <tr><td colSpan={7}>No records in this view.</td></tr>}
          </tbody>
        </table>
      </div>
      {open ? (
        <div className="dialog-back">
          <form className="dialog stack" onSubmit={create}>
            <h2>New {type}</h2>
            <label>Title<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required /></label>
            <label>What happened<textarea value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
            <div className="filters">
              <label>Impact
                <select value={form.impact} onChange={(event) => setForm({ ...form, impact: event.target.value })}>
                  <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                </select>
              </label>
              <label>Urgency
                <select value={form.urgency} onChange={(event) => setForm({ ...form, urgency: event.target.value })}>
                  <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                </select>
              </label>
              <label>Priority
                <select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}>
                  <option value="">From impact and urgency</option>
                  {session.settings.priorities.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
              <label>Category
                <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
                  <option value="">None</option>
                  {categories.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
                </select>
              </label>
            </div>
            {can(session.user.permissions, "ticket.assign") ? (
              <label>Assignment group
                <select value={form.assignmentGroupId} onChange={(event) => setForm({ ...form, assignmentGroupId: event.target.value })}>
                  <option value="">Unassigned</option>
                  {session.settings.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </label>
            ) : null}
            {type === "change" ? (
              <div className="filters">
                <label>Risk<select value={form.changeRisk} onChange={(event) => setForm({ ...form, changeRisk: event.target.value })}><option>low</option><option>moderate</option><option>high</option></select></label>
                <label>Window start<input type="datetime-local" value={form.windowStart} onChange={(event) => setForm({ ...form, windowStart: event.target.value })} /></label>
                <label>Window end<input type="datetime-local" value={form.windowEnd} onChange={(event) => setForm({ ...form, windowEnd: event.target.value })} /></label>
              </div>
            ) : null}
            <div className="phi-box stack">
              <strong>Protected health information</strong>
              <p className="note">Leave this blank unless the ticket cannot be worked without it. These fields are encrypted and every open is audited.</p>
              <label>Patient reference<input value={form.patientRef} onChange={(event) => setForm({ ...form, patientRef: event.target.value })} /></label>
              <label>Clinical context<textarea value={form.clinicalNote} onChange={(event) => setForm({ ...form, clinicalNote: event.target.value })} /></label>
              <label>Purpose
                <select value={form.phiPurpose} onChange={(event) => setForm({ ...form, phiPurpose: event.target.value })}>
                  <option value="">Not applicable</option>
                  {PHI_PURPOSES.map((purpose) => <option key={purpose}>{purpose}</option>)}
                </select>
              </label>
            </div>
            <div className="row-actions">
              <button className="btn" type="submit">Create</button>
              <button className="btn secondary" type="button" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  );
}
