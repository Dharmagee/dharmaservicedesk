"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/api";
import { useSession } from "@/components/Shell";
import { can, formatWhen } from "@/lib/labels";

interface HipaaStatus {
  policy: string;
  version: string;
  sessionTimeoutMinutes: number;
  retentionDays: number;
  acknowledgementRequired: boolean;
  encryption: { algorithm: string; source: string; fingerprint: string };
  chain: { intact: boolean; brokenAt?: string };
  events: { id: string; at: string; actorEmail: string; action: string; target: string; detail: string }[];
}

export function Hipaa() {
  const session = useSession();
  const [status, setStatus] = useState<HipaaStatus | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<HipaaStatus>("/api/hipaa").then(setStatus).catch((err) => setError(err.message));
  }, []);

  async function download() {
    const data = await api<{ csv: string }>("/api/audit/export", { method: "POST", body: "{}" });
    const blob = new Blob([data.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "dharma-audit.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!status) return <main className="page">{error || "Loading safeguards…"}</main>;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>HIPAA safeguards</h1>
          <p className="note">Technical controls for access, audit, integrity, and encryption. They support a compliance program. They do not replace one.</p>
        </div>
        {can(session.user.permissions, "audit.read") ? <button className="btn" onClick={download}>Export audit</button> : null}
      </div>
      <div className="cards">
        <div className="card"><div className="muted">Encryption</div><strong>{status.encryption.algorithm}</strong><p className="note">Key {status.encryption.source} · {status.encryption.fingerprint || "hidden"}</p></div>
        <div className="card"><div className="muted">Idle lock</div><div className="count">{status.sessionTimeoutMinutes}m</div></div>
        <div className="card"><div className="muted">Retention</div><div className="count">{status.retentionDays}d</div></div>
        <div className="card"><div className="muted">Audit chain</div><strong>{status.chain.intact ? "Intact" : `Broken at ${status.chain.brokenAt}`}</strong></div>
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Policy</h2>
        <div className="policy">{status.policy}</div>
        <p className="note">Version {status.version.slice(0, 12)}. Acknowledgement is {status.acknowledgementRequired ? "required" : "optional"}.</p>
      </section>
      {status.events.length ? (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
            <tbody>
              {status.events.slice(0, 80).map((event) => (
                <tr key={event.id}>
                  <td>{formatWhen(event.at)}</td>
                  <td>{event.actorEmail || "—"}</td>
                  <td className="mono">{event.action}</td>
                  <td>{event.target}</td>
                  <td>{event.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
}
