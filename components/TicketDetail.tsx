"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { api } from "@/components/api";
import { PublicTicket } from "@/components/models";
import { useSession } from "@/components/Shell";
import { can, formatWhen } from "@/lib/labels";
import { PHI_PURPOSES } from "@/lib/types";

export function TicketDetail({ id }: { id: string }) {
  const session = useSession();
  const router = useRouter();
  const [ticket, setTicket] = useState<PublicTicket | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [internal, setInternal] = useState(false);
  const [phi, setPhi] = useState<{ patientRef: string; clinicalNote: string; purpose: string } | null>(null);
  const [purpose, setPurpose] = useState("Healthcare operations");
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");

  function load() {
    api<{ ticket: PublicTicket }>(`/api/tickets/${id}`).then((data) => setTicket(data.ticket)).catch((err) => setError(err.message));
  }

  useEffect(() => { load(); }, [id]);

  if (!ticket) return <main className="page">{error || "Loading record…"}</main>;

  const states = session.settings.states[ticket.type] || [];
  const editable = can(session.user.permissions, "ticket.update");
  const tone = session.settings.priorities.find((item) => item.id === ticket.priority)?.tone || "planning";

  async function save(patch: Record<string, unknown>) {
    setError("");
    try {
      const data = await api<{ ticket: PublicTicket }>(`/api/tickets/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      setTicket(data.ticket);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    }
  }

  async function addNote(event: FormEvent) {
    event.preventDefault();
    try {
      const data = await api<{ ticket: PublicTicket }>(`/api/tickets/${id}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: note, internal }),
      });
      setTicket(data.ticket);
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Note failed");
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="mono">{ticket.number}</div>
          <h1>{ticket.title}</h1>
          <p className="note">Opened by {ticket.requesterName} · {formatWhen(ticket.createdAt)}</p>
        </div>
        <Link className="btn secondary" href={`/desk/${ticket.type}s`}>Back to queue</Link>
      </div>
      {error ? <div className="error" style={{ marginBottom: 12 }}>{error}</div> : null}
      {ticket.integrity === "mismatch" ? <div className="warn" style={{ marginBottom: 12 }}>This record no longer matches its integrity hash. Treat the contents as untrusted and tell the privacy officer.</div> : null}
      <div className="split">
        <div className="stack">
          <section className="card">
            <p>{ticket.description || "No description."}</p>
            <div className="row-actions">
              <span className={`pill ${tone}`}>{session.settings.priorities.find((item) => item.id === ticket.priority)?.label}</span>
              {ticket.phi.present ? <span className="phi-pill">PHI · {ticket.phi.purpose}</span> : null}
              {ticket.sla.resolveBreached || ticket.sla.responseBreached ? <span className="pill critical">SLA breached</span> : <span className="pill low">SLA on track</span>}
            </div>
          </section>
          {ticket.phi.present ? (
            <section className="phi-box stack">
              <strong>Protected fields</strong>
              <p className="note">Stored with AES-256-GCM. Opening them writes an audit event. Fields on file: {ticket.phi.fields.join(", ") || "none"}.</p>
              {phi ? (
                <div>
                  <p><strong>Patient reference.</strong> {phi.patientRef || "—"}</p>
                  <p><strong>Clinical context.</strong> {phi.clinicalNote || "—"}</p>
                </div>
              ) : (
                <div className="filters">
                  <label>Purpose
                    <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
                      {PHI_PURPOSES.map((item) => <option key={item}>{item}</option>)}
                    </select>
                  </label>
                  <button className="btn" onClick={() => api(`/api/tickets/${id}/phi`, { method: "POST", body: JSON.stringify({ purpose }) }).then((data) => setPhi(data as typeof phi)).catch((err) => setError(err.message))}>Open PHI</button>
                </div>
              )}
              {can(session.user.permissions, "phi.breakglass") ? (
                <form className="stack" onSubmit={(event) => {
                  event.preventDefault();
                  api(`/api/tickets/${id}/break-glass`, { method: "POST", body: JSON.stringify({ reason }) })
                    .then(() => setReason(""))
                    .catch((err) => setError(err.message));
                }}>
                  <label>Emergency reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this cannot wait for normal access" /></label>
                  <button className="btn secondary" type="submit">Break the glass for 15 minutes</button>
                </form>
              ) : null}
              {can(session.user.permissions, "phi.export") ? (
                <button className="btn secondary" onClick={() => api(`/api/tickets/${id}/export`, { method: "POST", body: JSON.stringify({ purpose }) }).then((data) => {
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = `${ticket.number}-phi.json`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                }).catch((err) => setError(err.message))}>Export PHI</button>
              ) : null}
            </section>
          ) : null}
          <section className="stack">
            <h2>Activity</h2>
            <form className="stack" onSubmit={addNote}>
              <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Update the requester, or add an internal work note" />
              {editable ? <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} /> Work note, hidden from the requester</label> : null}
              <button className="btn" type="submit">Add note</button>
            </form>
            <div className="timeline">
              {ticket.activities.slice().reverse().map((activity) => (
                <article key={activity.id} className={activity.kind === "work_note" ? "bubble internal" : "bubble"}>
                  <strong>{activity.authorName}</strong> <span className="muted">{activity.kind.replace("_", " ")} · {formatWhen(activity.createdAt)}</span>
                  <p>{activity.body}</p>
                </article>
              ))}
            </div>
          </section>
        </div>
        <aside className="stack">
          <section className="card stack">
            <label>State
              <select disabled={!editable} value={ticket.state} onChange={(event) => save({ state: event.target.value })}>
                {states.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>Priority
              <select disabled={!editable} value={ticket.priority} onChange={(event) => save({ priority: event.target.value })}>
                {session.settings.priorities.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label>Group
              <select disabled={!can(session.user.permissions, "ticket.assign")} value={ticket.assignmentGroupId} onChange={(event) => save({ assignmentGroupId: event.target.value })}>
                <option value="">Unassigned</option>
                {session.settings.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <p className="note">Assignee: {ticket.assigneeName || "Unassigned"}</p>
            <p className="note">Response due {formatWhen(ticket.responseDue)}</p>
            <p className="note">Resolve due {formatWhen(ticket.resolveDue)}</p>
            {ticket.type === "change" ? (
              <>
                <p className="note">Risk {ticket.changeRisk || "not set"} · Approval {ticket.approvalStatus}</p>
                <p className="note">Window {ticket.windowStart || "—"} to {ticket.windowEnd || "—"}</p>
                {ticket.approvalComment ? <p className="note">{ticket.approvalComment}</p> : null}
                {can(session.user.permissions, "change.approve") && ticket.approvalStatus === "pending" ? (
                  <form className="stack" onSubmit={(event) => {
                    event.preventDefault();
                    const decision = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-decision") || "approved";
                    api(`/api/tickets/${id}/approval`, { method: "POST", body: JSON.stringify({ decision, comment }) })
                      .then((data) => setTicket((data as { ticket: PublicTicket }).ticket))
                      .catch((err) => setError(err.message));
                  }}>
                    <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Approval note" />
                    <div className="row-actions">
                      <button className="btn" data-decision="approved" type="submit">Approve</button>
                      <button className="btn secondary" data-decision="rejected" type="submit">Reject</button>
                    </div>
                  </form>
                ) : null}
              </>
            ) : null}
            {can(session.user.permissions, "ticket.delete") ? (
              <button className="btn danger" onClick={() => {
                if (!window.confirm("Dispose of this record? PHI disposal is audited.")) return;
                api(`/api/tickets/${id}`, { method: "DELETE", body: JSON.stringify({ confirmDisposal: true }) })
                  .then(() => router.push("/desk"))
                  .catch((err) => setError(err.message));
              }}>Dispose record</button>
            ) : null}
          </section>
        </aside>
      </div>
    </main>
  );
}
