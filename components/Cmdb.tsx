"use client";

import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/components/api";
import { useSession } from "@/components/Shell";

interface Item {
  id: string;
  number: string;
  name: string;
  className: string;
  status: string;
  environment: string;
  ownerGroupId: string;
  ownerGroupName: string;
  assetTag: string;
  description: string;
}

export function Cmdb() {
  const session = useSession();
  const params = useSearchParams();
  const [items, setItems] = useState<Item[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [selected, setSelected] = useState<Item | null>(null);
  const [error, setError] = useState("");

  function load() {
    api<{ items: Item[]; canWrite: boolean }>("/api/cmdb").then((data) => {
      setItems(data.items);
      setCanWrite(data.canWrite);
      const id = params.get("id");
      if (id) setSelected(data.items.find((item) => item.id === id) || null);
    }).catch((err) => setError(err.message));
  }

  useEffect(() => { load(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    try {
      const created = !items.some((item) => item.id === selected.id);
      await api(created ? "/api/cmdb" : `/api/cmdb/${selected.id}`, {
        method: created ? "POST" : "PATCH",
        body: JSON.stringify(selected),
      });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Configuration items</h1>
          <p className="note">The systems and devices this desk supports.</p>
        </div>
        {canWrite ? <button className="btn" onClick={() => setSelected({ id: "new", number: "New", name: "", className: "Application", status: "in_service", environment: "Production", ownerGroupId: "", ownerGroupName: "", assetTag: "", description: "" })}>Add item</button> : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="split">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Number</th><th>Name</th><th>Class</th><th>Status</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="clickable" onClick={() => setSelected(item)}>
                  <td className="mono">{item.number}</td>
                  <td>{item.name}</td>
                  <td>{item.className}</td>
                  <td>{item.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected ? (
          <form className="card stack" onSubmit={save}>
            <h2>{selected.number}</h2>
            <label>Name<input value={selected.name} onChange={(event) => setSelected({ ...selected, name: event.target.value })} /></label>
            <label>Class<input value={selected.className} onChange={(event) => setSelected({ ...selected, className: event.target.value })} /></label>
            <label>Status<input value={selected.status} onChange={(event) => setSelected({ ...selected, status: event.target.value })} /></label>
            <label>Environment<input value={selected.environment} onChange={(event) => setSelected({ ...selected, environment: event.target.value })} /></label>
            <label>Asset tag<input value={selected.assetTag} onChange={(event) => setSelected({ ...selected, assetTag: event.target.value })} /></label>
            <label>Owner group
              <select value={selected.ownerGroupId} onChange={(event) => setSelected({ ...selected, ownerGroupId: event.target.value })}>
                <option value="">None</option>
                {session.settings.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
            </label>
            <label>Description<textarea value={selected.description} onChange={(event) => setSelected({ ...selected, description: event.target.value })} /></label>
            {canWrite ? <button className="btn" type="submit">Save item</button> : null}
          </form>
        ) : <p className="note">Select a configuration item.</p>}
      </div>
    </main>
  );
}
