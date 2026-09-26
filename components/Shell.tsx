"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "@/components/api";
import { can } from "@/lib/labels";
import type { SafeUser } from "@/lib/types";

export interface SessionData {
  user: SafeUser;
  settings: {
    orgName: string;
    tagline: string;
    accent: string;
    showDemoBanner: boolean;
    modules: Record<string, boolean>;
    sessionTimeoutMinutes: number;
    hipaaPolicyText: string;
    priorities: { id: string; label: string; tone: string }[];
    states: Record<string, { id: string; label: string; terminal?: boolean }[]>;
    categories: { id: string; type: string; name: string }[];
    customFields: { id: string; label: string; ticketTypes: string[]; input: string; options: string[]; required: boolean; phi: boolean }[];
    groups: { id: string; name: string }[];
    catalog: { id: string; name: string; category: string; summary: string; details: string; groupId: string }[];
  };
  notifications: { id: string; title: string; body: string; href: string; read: boolean }[];
  ackRequired: boolean;
  encryption: { algorithm: string; source?: string; fingerprint?: string };
  refresh: () => Promise<void>;
}

const SessionContext = createContext<SessionData | null>(null);
export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Session missing");
  return value;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [data, setData] = useState<Omit<SessionData, "refresh"> | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ label: string; href: string }[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [formError, setFormError] = useState("");

  async function refresh() {
    const session = await api<Omit<SessionData, "refresh">>("/api/session");
    setData(session);
  }

  useEffect(() => {
    refresh().catch(() => router.replace("/"));
  }, [router]);

  useEffect(() => {
    if (!data) return;
    let last = Date.now();
    const mark = () => {
      last = Date.now();
    };
    window.addEventListener("pointerdown", mark);
    window.addEventListener("keydown", mark);
    const timer = window.setInterval(() => {
      const idle = Date.now() - last;
      const limit = data.settings.sessionTimeoutMinutes * 60 * 1000;
      if (idle > limit) {
        router.replace("/?timeout=1");
        return;
      }
      if (idle < 60000) {
        api("/api/session").catch(() => router.replace("/?timeout=1"));
      }
    }, 30000);
    return () => {
      window.removeEventListener("pointerdown", mark);
      window.removeEventListener("keydown", mark);
      window.clearInterval(timer);
    };
  }, [data, router]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const handle = window.setTimeout(() => {
      api<{ results: { label: string; href: string }[] }>(`/api/search?q=${encodeURIComponent(query)}`)
        .then((payload) => setResults(payload.results))
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(handle);
  }, [query]);

  const value = useMemo(() => (data ? { ...data, refresh } : null), [data]);

  if (!data || !value) return <main className="page">Opening the desk…</main>;

  const modules = data.settings.modules;
  const agent = can(data.user.permissions, "ticket.update") || can(data.user.permissions, "audit.read");
  const links = agent
    ? [
        ["/desk", "Home"],
        modules.incidents ? ["/desk/incidents", "Incidents"] : null,
        modules.problems ? ["/desk/problems", "Problems"] : null,
        modules.changes ? ["/desk/changes", "Changes"] : null,
        modules.requests ? ["/desk/requests", "Requests"] : null,
        modules.catalog ? ["/desk/catalog", "Catalog"] : null,
        modules.knowledge ? ["/desk/knowledge", "Knowledge"] : null,
        modules.cmdb ? ["/desk/cmdb", "CMDB"] : null,
        modules.reports && can(data.user.permissions, "report.read") ? ["/desk/reports", "Reports"] : null,
        ["/desk/hipaa", "HIPAA"],
        can(data.user.permissions, "admin.settings") || can(data.user.permissions, "admin.users") ? ["/desk/admin", "Configure"] : null,
      ]
    : [
        ["/desk", "Home"],
        modules.catalog ? ["/desk/catalog", "Catalog"] : null,
        modules.requests ? ["/desk/requests", "My requests"] : null,
        modules.knowledge ? ["/desk/knowledge", "Knowledge"] : null,
      ];

  return (
    <SessionContext.Provider value={value}>
      <div className="shell" style={{ ["--accent" as string]: data.settings.accent }}>
        <aside className="sidebar">
          <div className="brand">
            <strong>Dharma</strong>
            <span>Service desk</span>
          </div>
          <nav className="nav">
            {links.filter(Boolean).map((link) => (
              <Link key={link![0]} href={link![0]} className={pathname === link![0] ? "active" : ""}>
                {link![1]}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="workspace">
          <header className="topbar">
            <div className="search">
              <input
                aria-label="Search"
                placeholder="Search tickets, knowledge, and systems"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {results.length ? (
                <div className="search-results">
                  {results.map((result) => (
                    <Link key={result.href + result.label} href={result.href} onClick={() => setQuery("")}>
                      {result.label}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
            <span className="phi-pill">PHI encrypted · access audited</span>
            <div className="user-menu">
              <button className="icon-btn" onClick={() => setNotesOpen((open) => !open)}>
                Alerts {data.notifications.filter((note) => !note.read).length}
              </button>
              {notesOpen ? (
                <div className="menu">
                  {data.notifications.length ? data.notifications.map((note) => (
                    <Link key={note.id} href={note.href} onClick={() => api("/api/notifications", { method: "POST", body: JSON.stringify({ ids: [note.id] }) }).then(refresh)}>
                      <strong>{note.title}</strong>
                      <div className="note">{note.body}</div>
                    </Link>
                  )) : <div className="note">No alerts</div>}
                  <button onClick={() => api("/api/notifications", { method: "POST", body: JSON.stringify({ all: true }) }).then(refresh)}>Mark all read</button>
                </div>
              ) : null}
            </div>
            <div className="user-menu">
              <button className="icon-btn" onClick={() => setMenuOpen((open) => !open)}>{data.user.name}</button>
              {menuOpen ? (
                <div className="menu">
                  <div className="note">{data.user.roleNames.join(", ")}</div>
                  <button onClick={() => { setMenuOpen(false); setPasswordOpen(true); }}>Change password</button>
                  <button onClick={() => api("/api/auth/logout", { method: "POST", body: "{}" }).then(() => router.replace("/"))}>Sign out</button>
                </div>
              ) : null}
            </div>
          </header>
          {data.settings.showDemoBanner ? (
            <div className="banner">
              Sample organization with fictional records. Change the demo passwords and set PHI_MASTER_KEY before real use. This software does not by itself make an organization HIPAA compliant.
            </div>
          ) : null}
          {error ? <div className="banner">{error}</div> : null}
          {children}
        </div>
      </div>
      {data.ackRequired ? (
        <div className="dialog-back">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="policy-title">
            <h2 id="policy-title">HIPAA policy acknowledgement</h2>
            <div className="policy">{data.settings.hipaaPolicyText}</div>
            <button
              className="btn"
              onClick={() => api("/api/auth/acknowledge", { method: "POST", body: "{}" }).then(refresh).catch((err) => setError(err.message))}
            >
              I understand and will follow this policy
            </button>
          </div>
        </div>
      ) : null}
      {passwordOpen ? (
        <div className="dialog-back">
          <form
            className="dialog stack"
            onSubmit={(event) => {
              event.preventDefault();
              setFormError("");
              api("/api/account/password", { method: "POST", body: JSON.stringify({ current, next: nextPassword }) })
                .then(() => {
                  setPasswordOpen(false);
                  setCurrent("");
                  setNextPassword("");
                })
                .catch((err) => setFormError(err.message));
            }}
          >
            <h2>Change password</h2>
            {formError ? <div className="error">{formError}</div> : null}
            <label>Current password<input type="password" value={current} onChange={(event) => setCurrent(event.target.value)} required /></label>
            <label>New password<input type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} required /></label>
            <div className="row-actions">
              <button className="btn" type="submit">Save password</button>
              <button className="btn secondary" type="button" onClick={() => setPasswordOpen(false)}>Cancel</button>
            </div>
          </form>
        </div>
      ) : null}
    </SessionContext.Provider>
  );
}
