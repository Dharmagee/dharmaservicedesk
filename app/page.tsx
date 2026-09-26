"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/components/api";

interface Demo {
  name: string;
  email: string;
  role: string;
  password: string;
}

interface Meta {
  orgName: string;
  tagline: string;
  showDemoBanner: boolean;
  demos: Demo[];
}

export default function LoginPage() {
  const router = useRouter();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timeout = new URLSearchParams(window.location.search).get("timeout");
    if (timeout) setError("Your session ended after a period of inactivity. This keeps health information from staying on screen.");
    api<Meta>("/api/meta").then(setMeta).catch(() => setError("The desk is not available yet."));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      router.push("/desk");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <section className="login-story">
        <div>
          <div className="eyebrow">Dharma Service Desk</div>
          <h1>Work the queue. Protect the record.</h1>
          <p>{meta?.tagline || "A configurable service desk for incidents, requests, changes, and knowledge."}</p>
          <div className="story-points">
            <div>
              <strong>Service management</strong>
              Incidents, problems, changes, a service catalog, knowledge, and a living CMDB.
            </div>
            <div>
              <strong>Shaped by the organization</strong>
              Turn modules on, edit states, SLAs, fields, groups, and assignment rules.
            </div>
            <div>
              <strong>PHI stays in bounds</strong>
              Encrypted fields, purpose-based access, audit history, and an idle lock.
            </div>
          </div>
        </div>
        <p>{meta?.orgName || "Your organization"}</p>
      </section>
      <section className="login-panel">
        <form className="login-card stack" onSubmit={submit}>
          <h2>Sign in</h2>
          <p className="note">Use your workforce account. Demo mode can be turned off in organization settings.</p>
          {error ? <div className="error">{error}</div> : null}
          <label>
            Email
            <input value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required />
          </label>
          <button className="btn full" disabled={busy} type="submit">{busy ? "Signing in…" : "Enter the desk"}</button>
          {meta?.showDemoBanner && meta.demos.length ? (
            <div className="demo-grid">
              {meta.demos.map((demo) => (
                <button
                  key={demo.email}
                  type="button"
                  onClick={() => {
                    setEmail(demo.email);
                    setPassword(demo.password);
                  }}
                >
                  {demo.name}
                  <small>{demo.role} · {demo.email}</small>
                </button>
              ))}
            </div>
          ) : null}
        </form>
      </section>
    </main>
  );
}
