"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/api";

interface Report {
  open: Record<string, number>;
  byPriority: { label: string; count: number }[];
  byGroup: { name: string; count: number }[];
  breaches: number;
  mttrHours: number;
  phiReveals: number;
  breakGlass: number;
  pendingApprovals: number;
}

export function Reports() {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Report>("/api/reports").then(setReport).catch((err) => setError(err.message));
  }, []);

  if (!report) return <main className="page">{error || "Loading reports…"}</main>;
  const max = Math.max(1, ...report.byPriority.map((item) => item.count), ...report.byGroup.map((item) => item.count));

  return (
    <main className="page">
      <div className="page-head"><h1>Reports</h1></div>
      <div className="cards">
        <div className="card"><div className="muted">Mean time to resolve</div><div className="count">{report.mttrHours.toFixed(1)}h</div></div>
        <div className="card"><div className="muted">Resolve breaches</div><div className="count">{report.breaches}</div></div>
        <div className="card"><div className="muted">PHI opens</div><div className="count">{report.phiReveals}</div></div>
        <div className="card"><div className="muted">Pending approvals</div><div className="count">{report.pendingApprovals}</div></div>
      </div>
      <div className="split" style={{ marginTop: 16 }}>
        <section className="card">
          <h2>Open by priority</h2>
          <div className="bars">
            {report.byPriority.map((item) => (
              <div className="bar" key={item.label}><strong>{item.label}</strong><span><i style={{ width: `${(item.count / max) * 100}%` }} /></span>{item.count}</div>
            ))}
          </div>
        </section>
        <section className="card">
          <h2>Open by group</h2>
          <div className="bars">
            {report.byGroup.map((item) => (
              <div className="bar" key={item.name}><strong>{item.name}</strong><span><i style={{ width: `${(item.count / max) * 100}%` }} /></span>{item.count}</div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
