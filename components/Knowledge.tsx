"use client";

import { FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/components/api";
import { useSession } from "@/components/Shell";
import { can } from "@/lib/labels";
import { PHI_PURPOSES } from "@/lib/types";

interface Article {
  id: string;
  number: string;
  title: string;
  category: string;
  state: string;
  containsPhi: boolean;
  body: string;
  authorName: string;
}

export function Knowledge() {
  const session = useSession();
  const params = useSearchParams();
  const [articles, setArticles] = useState<Article[]>([]);
  const [selected, setSelected] = useState<Article | null>(null);
  const [revealed, setRevealed] = useState("");
  const [purpose, setPurpose] = useState("Healthcare operations");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: "", category: "How-to", body: "", containsPhi: false, state: "draft" });
  const [error, setError] = useState("");

  function load() {
    api<{ articles: Article[] }>("/api/knowledge").then((data) => {
      setArticles(data.articles);
      const id = params.get("id");
      if (id) setSelected(data.articles.find((article) => article.id === id) || null);
    }).catch((err) => setError(err.message));
  }

  useEffect(() => { load(); }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api(selected && editing ? `/api/knowledge/${selected.id}` : "/api/knowledge", {
        method: selected && editing ? "PATCH" : "POST",
        body: JSON.stringify(form),
      });
      setEditing(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Knowledge</h1>
          <p className="note">Published answers for the service desk and for staff.</p>
        </div>
        {can(session.user.permissions, "knowledge.write") ? <button className="btn" onClick={() => { setEditing(true); setSelected(null); setForm({ title: "", category: "How-to", body: "", containsPhi: false, state: "draft" }); }}>New article</button> : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="split">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Number</th><th>Title</th><th>State</th></tr></thead>
            <tbody>
              {articles.map((article) => (
                <tr key={article.id} className="clickable" onClick={() => { setSelected(article); setRevealed(""); setEditing(false); }}>
                  <td className="mono">{article.number}</td>
                  <td>{article.title}{article.containsPhi ? " · PHI" : ""}</td>
                  <td>{article.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <section className="card">
          {editing ? (
            <form className="stack" onSubmit={save}>
              <label>Title<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
              <label>Category<input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} /></label>
              <label>Body<textarea value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} /></label>
              <label><input type="checkbox" checked={form.containsPhi} onChange={(event) => setForm({ ...form, containsPhi: event.target.checked })} /> This article contains PHI</label>
              <label>State
                <select value={form.state} onChange={(event) => setForm({ ...form, state: event.target.value })}>
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                </select>
              </label>
              <button className="btn" type="submit">Save article</button>
            </form>
          ) : selected ? (
            <div className="stack">
              <div className="mono">{selected.number}</div>
              <h2>{selected.title}</h2>
              <p className="note">{selected.category} · {selected.authorName}</p>
              {selected.containsPhi ? (
                <div className="phi-box stack">
                  {revealed ? <p className="policy">{revealed}</p> : <p className="note">The body is encrypted.</p>}
                  <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>{PHI_PURPOSES.map((item) => <option key={item}>{item}</option>)}</select>
                  <button className="btn" onClick={() => api<{ body: string }>(`/api/knowledge/${selected.id}/phi`, { method: "POST", body: JSON.stringify({ purpose }) }).then((data) => setRevealed(data.body)).catch((err) => setError(err.message))}>Open PHI</button>
                </div>
              ) : <p className="policy">{selected.body}</p>}
              {can(session.user.permissions, "knowledge.write") ? <button className="btn secondary" onClick={() => { setEditing(true); setForm({ title: selected.title, category: selected.category, body: selected.body, containsPhi: selected.containsPhi, state: selected.state }); }}>Edit</button> : null}
            </div>
          ) : <p className="note">Select an article.</p>}
        </section>
      </div>
    </main>
  );
}
