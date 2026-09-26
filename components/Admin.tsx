"use client";

import { FormEvent, useEffect, useState } from "react";
import { api } from "@/components/api";
import { useSession } from "@/components/Shell";
import { can } from "@/lib/labels";
import { PERMISSIONS, type Role, type Settings, type TicketType } from "@/lib/types";
import type { SafeUser } from "@/lib/types";

const TABS = ["Organization", "Modules", "Workflow", "Catalog", "People", "Policy"] as const;

export function Admin() {
  const session = useSession();
  const [tab, setTab] = useState<(typeof TABS)[number]>("Organization");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [person, setPerson] = useState({ name: "", email: "", password: "", roleIds: ["requester"], groupIds: [] as string[], active: true });

  useEffect(() => {
    if (can(session.user.permissions, "admin.settings")) {
      api<{ settings: Settings; roles: Role[] }>("/api/settings").then((data) => {
        setSettings(data.settings);
        setRoles(data.roles);
      }).catch((err) => setError(err.message));
    }
    if (can(session.user.permissions, "admin.users")) {
      api<{ users: SafeUser[] }>("/api/users").then((data) => setUsers(data.users)).catch((err) => setError(err.message));
    }
  }, [session.user.permissions]);

  async function saveConfig() {
    if (!settings) return;
    setError("");
    setMessage("");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ settings, roles }) });
      setMessage("Organization settings saved.");
      await session.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function savePerson(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/users", { method: "POST", body: JSON.stringify(person) });
      const data = await api<{ users: SafeUser[] }>("/api/users");
      setUsers(data.users);
      setPerson({ name: "", email: "", password: "", roleIds: ["requester"], groupIds: [], active: true });
      setMessage("Person added.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that person");
    }
  }

  if (!settings && can(session.user.permissions, "admin.settings")) return <main className="page">{error || "Loading configuration…"}</main>;

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Configure</h1>
          <p className="note">Shape the desk for this organization. Changes apply to new work immediately.</p>
        </div>
        {settings ? <button className="btn" onClick={saveConfig}>Save configuration</button> : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      {message ? <div className="banner">{message}</div> : null}
      <div className="section-nav">
        {TABS.map((item) => <button key={item} className={tab === item ? "btn active" : "btn secondary"} onClick={() => setTab(item)}>{item}</button>)}
      </div>
      {tab === "Organization" && settings ? (
        <section className="card stack">
          <label>Organization name<input value={settings.orgName} onChange={(event) => setSettings({ ...settings, orgName: event.target.value })} /></label>
          <label>Tagline<input value={settings.tagline} onChange={(event) => setSettings({ ...settings, tagline: event.target.value })} /></label>
          <label>Accent<input value={settings.accent} onChange={(event) => setSettings({ ...settings, accent: event.target.value })} /></label>
          <label>Session timeout (minutes)<input type="number" value={settings.sessionTimeoutMinutes} onChange={(event) => setSettings({ ...settings, sessionTimeoutMinutes: Number(event.target.value) })} /></label>
          <label>PHI retention (days)<input type="number" value={settings.retentionDays} onChange={(event) => setSettings({ ...settings, retentionDays: Number(event.target.value) })} /></label>
          <label>HTTPS webhook for alerts<input value={settings.webhookUrl} onChange={(event) => setSettings({ ...settings, webhookUrl: event.target.value })} placeholder="https://example.com/hooks/desk" /></label>
          <label><input type="checkbox" checked={settings.showDemoBanner} onChange={(event) => setSettings({ ...settings, showDemoBanner: event.target.checked })} /> Show the demo banner and sample accounts</label>
          <h2>Business hours</h2>
          <div className="filters">
            <label>Start<input value={settings.businessHours.start} onChange={(event) => setSettings({ ...settings, businessHours: { ...settings.businessHours, start: event.target.value } })} /></label>
            <label>End<input value={settings.businessHours.end} onChange={(event) => setSettings({ ...settings, businessHours: { ...settings.businessHours, end: event.target.value } })} /></label>
          </div>
          <div className="check-grid">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => (
              <label key={day}>
                <input
                  type="checkbox"
                  checked={settings.businessHours.days.includes(index)}
                  onChange={(event) => {
                    const days = event.target.checked
                      ? [...settings.businessHours.days, index]
                      : settings.businessHours.days.filter((value) => value !== index);
                    setSettings({ ...settings, businessHours: { ...settings.businessHours, days } });
                  }}
                /> {day}
              </label>
            ))}
          </div>
          <h2>Groups</h2>
          {settings.groups.map((group, index) => (
            <div className="filters" key={group.id}>
              <input value={group.name} onChange={(event) => {
                const groups = [...settings.groups];
                groups[index] = { ...group, name: event.target.value };
                setSettings({ ...settings, groups });
              }} />
              <input value={group.description} onChange={(event) => {
                const groups = [...settings.groups];
                groups[index] = { ...group, description: event.target.value };
                setSettings({ ...settings, groups });
              }} />
            </div>
          ))}
          <button className="btn secondary" onClick={() => setSettings({ ...settings, groups: [...settings.groups, { id: `g-${Date.now()}`, name: "New group", description: "" }] })}>Add group</button>
        </section>
      ) : null}
      {tab === "Modules" && settings ? (
        <section className="card check-grid">
          {(Object.keys(settings.modules) as (keyof Settings["modules"])[]).map((key) => (
            <label key={key}>
              <input type="checkbox" checked={settings.modules[key]} onChange={(event) => setSettings({ ...settings, modules: { ...settings.modules, [key]: event.target.checked } })} /> {key}
            </label>
          ))}
        </section>
      ) : null}
      {tab === "Workflow" && settings ? (
        <section className="stack">
          <div className="card stack">
            <h2>Priorities and SLA minutes</h2>
            {settings.priorities.map((priority, index) => (
              <div className="filters" key={priority.id}>
                <input value={priority.label} onChange={(event) => {
                  const priorities = [...settings.priorities];
                  priorities[index] = { ...priority, label: event.target.value };
                  setSettings({ ...settings, priorities });
                }} />
                <label>Respond<input type="number" value={priority.responseMinutes} onChange={(event) => {
                  const priorities = [...settings.priorities];
                  priorities[index] = { ...priority, responseMinutes: Number(event.target.value) };
                  setSettings({ ...settings, priorities });
                }} /></label>
                <label>Resolve<input type="number" value={priority.resolveMinutes} onChange={(event) => {
                  const priorities = [...settings.priorities];
                  priorities[index] = { ...priority, resolveMinutes: Number(event.target.value) };
                  setSettings({ ...settings, priorities });
                }} /></label>
              </div>
            ))}
          </div>
          {(["incident", "problem", "change", "request"] as TicketType[]).map((type) => (
            <div className="card stack" key={type}>
              <h2>{type} states</h2>
              {settings.states[type].map((state, index) => (
                <div className="filters" key={state.id}>
                  <span className="mono">{state.id}</span>
                  <input value={state.label} onChange={(event) => {
                    const states = { ...settings.states, [type]: settings.states[type].map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item) };
                    setSettings({ ...settings, states });
                  }} />
                  <label><input type="checkbox" checked={Boolean(state.terminal)} onChange={(event) => {
                    const states = { ...settings.states, [type]: settings.states[type].map((item, itemIndex) => itemIndex === index ? { ...item, terminal: event.target.checked } : item) };
                    setSettings({ ...settings, states });
                  }} /> Terminal</label>
                  <input
                    value={(settings.transitions[type]?.[state.id] || []).join(", ")}
                    onChange={(event) => {
                      const next = event.target.value.split(",").map((item) => item.trim()).filter(Boolean);
                      setSettings({ ...settings, transitions: { ...settings.transitions, [type]: { ...settings.transitions[type], [state.id]: next } } });
                    }}
                    placeholder="Next states, comma separated"
                  />
                </div>
              ))}
            </div>
          ))}
          <div className="card stack">
            <h2>Assignment rules</h2>
            {settings.rules.map((rule, index) => (
              <div className="filters" key={rule.id}>
                <input value={rule.name} onChange={(event) => {
                  const rules = [...settings.rules];
                  rules[index] = { ...rule, name: event.target.value };
                  setSettings({ ...settings, rules });
                }} />
                <label><input type="checkbox" checked={rule.enabled} onChange={(event) => {
                  const rules = [...settings.rules];
                  rules[index] = { ...rule, enabled: event.target.checked };
                  setSettings({ ...settings, rules });
                }} /> Enabled</label>
                <span className="note">{rule.event} · {rule.type} · {rule.priority} → {rule.action} {rule.actionValue}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tab === "Catalog" && settings ? (
        <section className="stack">
          {settings.catalog.map((item, index) => (
            <div className="card stack" key={item.id}>
              <label>Name<input value={item.name} onChange={(event) => {
                const catalog = [...settings.catalog];
                catalog[index] = { ...item, name: event.target.value };
                setSettings({ ...settings, catalog });
              }} /></label>
              <label>Summary<input value={item.summary} onChange={(event) => {
                const catalog = [...settings.catalog];
                catalog[index] = { ...item, summary: event.target.value };
                setSettings({ ...settings, catalog });
              }} /></label>
              <label>Fulfillment group
                <select value={item.groupId} onChange={(event) => {
                  const catalog = [...settings.catalog];
                  catalog[index] = { ...item, groupId: event.target.value };
                  setSettings({ ...settings, catalog });
                }}>
                  {settings.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </label>
              <label><input type="checkbox" checked={item.active} onChange={(event) => {
                const catalog = [...settings.catalog];
                catalog[index] = { ...item, active: event.target.checked };
                setSettings({ ...settings, catalog });
              }} /> Offered in the catalog</label>
            </div>
          ))}
          <button className="btn secondary" onClick={() => setSettings({
            ...settings,
            catalog: [...settings.catalog, { id: `cat-${Date.now()}`, name: "New service", category: "Workplace", summary: "", details: "", groupId: settings.groups[0]?.id || "", active: true }],
          })}>Add catalog item</button>
        </section>
      ) : null}
      {tab === "People" ? (
        <section className="stack">
          <form className="card stack" onSubmit={savePerson}>
            <h2>Add a person</h2>
            <label>Name<input value={person.name} onChange={(event) => setPerson({ ...person, name: event.target.value })} required /></label>
            <label>Email<input value={person.email} onChange={(event) => setPerson({ ...person, email: event.target.value })} required /></label>
            <label>Temporary password<input value={person.password} onChange={(event) => setPerson({ ...person, password: event.target.value })} required /></label>
            <div className="check-grid">
              {roles.map((role) => (
                <label key={role.id}>
                  <input type="checkbox" checked={person.roleIds.includes(role.id)} onChange={(event) => {
                    const roleIds = event.target.checked ? [...person.roleIds, role.id] : person.roleIds.filter((id) => id !== role.id);
                    setPerson({ ...person, roleIds });
                  }} /> {role.name}
                </label>
              ))}
            </div>
            <button className="btn" type="submit">Add person</button>
          </form>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Active</th></tr></thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td>{user.name}</td>
                    <td>{user.email}</td>
                    <td>{user.roleNames.join(", ")}</td>
                    <td>{user.active ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {roles.length ? (
            <div className="card stack">
              <h2>Role permissions</h2>
              {roles.map((role, index) => (
                <div key={role.id}>
                  <strong>{role.name}</strong>
                  <div className="check-grid">
                    {role.permissions.includes("*") ? <span className="note">Full access</span> : PERMISSIONS.map((permission) => (
                      <label key={permission.id}>
                        <input type="checkbox" checked={role.permissions.includes(permission.id)} onChange={(event) => {
                          const permissions = event.target.checked
                            ? [...role.permissions, permission.id]
                            : role.permissions.filter((id) => id !== permission.id);
                          const next = [...roles];
                          next[index] = { ...role, permissions };
                          setRoles(next);
                        }} /> {permission.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {tab === "Policy" && settings ? (
        <section className="card stack">
          <label>HIPAA policy<textarea style={{ minHeight: 220 }} value={settings.hipaaPolicyText} onChange={(event) => setSettings({ ...settings, hipaaPolicyText: event.target.value })} /></label>
          <label><input type="checkbox" checked={settings.requireHipaaAcknowledgement} onChange={(event) => setSettings({ ...settings, requireHipaaAcknowledgement: event.target.checked })} /> Require acknowledgement when the policy changes</label>
          <p className="note">Saving a changed policy asks every person to acknowledge it again. Replace this sample with language your privacy officer approves. It is not legal advice.</p>
          <button className="btn secondary" onClick={() => {
            const blob = new Blob([JSON.stringify({ settings, roles }, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = "dharma-configuration.json";
            anchor.click();
            URL.revokeObjectURL(url);
          }}>Download configuration</button>
          <label>Restore configuration
            <input type="file" accept="application/json" onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              const text = await file.text();
              const parsed = JSON.parse(text) as { settings: Settings; roles: Role[] };
              setSettings(parsed.settings);
              setRoles(parsed.roles);
              setMessage("Configuration loaded. Save it to apply.");
            }} />
          </label>
        </section>
      ) : null}
    </main>
  );
}
