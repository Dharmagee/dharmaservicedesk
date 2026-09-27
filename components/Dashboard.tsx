"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/components/api";
import { useSession } from "@/components/Shell";
import { can } from "@/lib/labels";

interface Report {
  open: { incident: number; problem: number; change: number; request: number };
  breaches: number;
  pendingApprovals: number;
  phiReveals: number;
  breakGlass: number;
}

export function Dashboard() {
  const session = useSession();
  const [report, setReport] = useState<Report | null>(null);
  const agent = can(session.user.permissions, "ticket.update") || can(session.user.permissions, "audit.read");

  useEffect(() => {
    if (!can(session.user.permissions, "report.read")) return;
    api<Report>("/api/reports").then(setReport).catch(() => setReport(null));
  }, [session.user.permissions]);

  if (!agent) {
    return (
      <main className="page">
        <div className="page-head">
          <div>
            <h1>Hello, {session.user.name.split(" ")[0]}</h1>
            <p className="note">Request something, check a how-to, or follow a ticket you opened.</p>
          </div>
        </div>
        <div className="catalog-grid">
          {session.settings.catalog.slice(0, 4).map((item) => (
            <Link key={item.id} className="card" href="/desk/catalog">
              <strong>{item.name}</strong>
              <p className="note">{item.summary}</p>
            </Link>
          ))}
        </div>
      </main>
    );
  }

  const cards: { label: string; count: number | string; href: string; tone: string }[] = [
    { label: "Incidents", count: report?.open.incident ?? "–", href: "/desk/incidents", tone: "incident" },
    { label: "Problems", count: report?.open.problem ?? "–", href: "/desk/problems", tone: "problem" },
    { label: "Changes", count: report?.open.change ?? "–", href: "/desk/changes", tone: "change" },
    { label: "Requests", count: report?.open.request ?? "–", href: "/desk/requests", tone: "request" },
  ];

  return (
    <main className="page home-page">
      <div className="page-head">
        <div>
          <h1>{session.settings.orgName}</h1>
          <p className="note">Open work, approvals, and privacy activity for this desk.</p>
        </div>
      </div>
      <div className="cards">
        {cards.map((card) => (
          <Link key={card.label} className={`card dash-card tone-${card.tone}`} href={card.href}>
            <div className="muted">{card.label}</div>
            <div className="count">{card.count}</div>
          </Link>
        ))}
      </div>
      <div className="cards">
        <div className="card dash-card tone-breach"><div className="muted">SLA breaches</div><div className="count">{report?.breaches ?? "–"}</div></div>
        <div className="card dash-card tone-approval"><div className="muted">Approvals waiting</div><div className="count">{report?.pendingApprovals ?? "–"}</div></div>
        <div className="card dash-card tone-phi"><div className="muted">PHI opens, 30 days</div><div className="count">{report?.phiReveals ?? "–"}</div></div>
        <div className="card dash-card tone-glass"><div className="muted">Break-the-glass</div><div className="count">{report?.breakGlass ?? "–"}</div></div>
      </div>
    </main>
  );
}
