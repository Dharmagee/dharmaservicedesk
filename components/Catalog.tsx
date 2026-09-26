"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { api } from "@/components/api";
import { useSession } from "@/components/Shell";
import { PHI_PURPOSES } from "@/lib/types";

export function Catalog() {
  const session = useSession();
  const router = useRouter();
  const [itemId, setItemId] = useState("");
  const [details, setDetails] = useState("");
  const [patientRef, setPatientRef] = useState("");
  const [phiPurpose, setPhiPurpose] = useState("");
  const [error, setError] = useState("");
  const item = session.settings.catalog.find((entry) => entry.id === itemId);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ id: string }>("/api/catalog/request", {
        method: "POST",
        body: JSON.stringify({ itemId, details, patientRef, phiPurpose }),
      });
      router.push(`/desk/tickets/${result.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Service catalog</h1>
          <p className="note">Order a standard service. The desk opens a request and routes it to the right group.</p>
        </div>
      </div>
      <div className="catalog-grid">
        {session.settings.catalog.map((entry) => (
          <button key={entry.id} className="card" onClick={() => setItemId(entry.id)}>
            <div className="muted">{entry.category}</div>
            <h2>{entry.name}</h2>
            <p className="note">{entry.summary}</p>
          </button>
        ))}
      </div>
      {item ? (
        <form className="dialog stack" style={{ marginTop: 16 }} onSubmit={submit}>
          <h2>{item.name}</h2>
          <p className="note">{item.details}</p>
          {error ? <div className="error">{error}</div> : null}
          <label>Details<textarea value={details} onChange={(event) => setDetails(event.target.value)} /></label>
          <div className="phi-box stack">
            <strong>PHI, only if this request cannot be fulfilled without it</strong>
            <label>Patient reference<input value={patientRef} onChange={(event) => setPatientRef(event.target.value)} /></label>
            <label>Purpose
              <select value={phiPurpose} onChange={(event) => setPhiPurpose(event.target.value)}>
                <option value="">Not applicable</option>
                {PHI_PURPOSES.map((purpose) => <option key={purpose}>{purpose}</option>)}
              </select>
            </label>
          </div>
          <button className="btn" type="submit">Submit request</button>
        </form>
      ) : null}
    </main>
  );
}
