"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiRequest, errorMessage } from "@/lib/crm-data";
import type { Profile } from "@/lib/types";
import { SettingsNav } from "@/components/settings-nav";
import { SearchableDropdown } from "@/components/searchable-dropdown";

type AccessData = {
  roles: { role: string; permission_key: string; allowed: boolean }[];
  overrides: { user_id: string; permission_key: string; allowed: boolean }[];
  profiles: Profile[];
};
const roles = ["counselor", "team_lead", "manager", "admin"];

export function AccessEditor({ individual = false }: { individual?: boolean }) {
  const [data, setData] = useState<AccessData | null>(null);
  const [selected, setSelected] = useState(individual ? "" : "counselor");
  const [grants, setGrants] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { apiRequest<AccessData>("/api/access").then(setData).catch((error) => setError(errorMessage(error, "Could not load access settings."))); }, []);
  function choose(value: string) {
    setSelected(value); setMessage("");
    const rows = individual ? data?.overrides.filter((row) => row.user_id === value) : data?.roles.filter((row) => row.role === value);
    setGrants(Object.fromEntries((rows ?? []).map((row) => [row.permission_key, row.allowed])));
  }
  useEffect(() => {
    if (!data) return;
    const rows = individual ? data.overrides.filter((row) => row.user_id === selected) : data.roles.filter((row) => row.role === selected);
    setGrants(Object.fromEntries(rows.map((row) => [row.permission_key, row.allowed])));
  }, [data, individual, selected]);
  const keys = [...new Set(data?.roles.map((row) => row.permission_key) ?? [])].sort();
  const groups = [...new Set(keys.map((key) => key.split(".")[0]))];
  const selectedRole = individual ? data?.profiles.find((profile) => profile.id === selected)?.role : selected;
  async function save() {
    setBusy(true); setError(""); setMessage("");
    try {
      await apiRequest("/api/access", { method: "PUT", body: { ...(individual ? { userId: selected } : { role: selected }), grants } });
      setData(await apiRequest<AccessData>("/api/access")); setMessage("Permissions saved and enforced. Refresh the workspace to update navigation.");
    } catch (error) { setError(errorMessage(error, "Could not save permissions.")); }
    finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><div><h1>{individual ? "User access exceptions" : "Role permissions"}</h1><p>Changes are persisted and audited. Super Admin access cannot be modified.</p></div><Link href={individual ? "/settings/access" : "/settings/access/users"} className="button button-secondary">{individual ? "Role permissions" : "User exceptions"}</Link></div>
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
    <div className="settings-layout"><SettingsNav current={individual ? "users" : "roles"} />
    {!data ? <section className="panel settings-content"><p role="status">{error ? "Permissions could not be loaded." : "Loading permissions..."}</p></section> : <section className="panel settings-content">
      <h2>{individual ? "Individual overrides" : "Role access"}</h2><p>{individual ? "Use role inherits the team's default access. Allow or Restrict overrides it for this user." : "Choose a role and configure access to each CRM module."}</p>
      {individual ? <div className="form-field access-selector"><label htmlFor="access-user">Team member</label><SearchableDropdown id="access-user" ariaLabel="Team member" placeholder="Choose a user" value={selected} onChange={choose} options={[{ value: "", label: "Choose a user" }, ...data.profiles.filter(profile => profile.role !== "super_admin").map(profile => ({ value: profile.id, label: `${profile.fullName} (${profile.role.replaceAll("_", " ")})` }))]} /></div> : <div className="role-tabs" role="group" aria-label="Role">{roles.map(role => <button type="button" key={role} className={`role-tab${selected === role ? " selected" : ""}`} aria-pressed={selected === role} onClick={() => choose(role)}>{role.replaceAll("_", " ")}</button>)}</div>}
      <div className="access-permissions">{selected ? groups.map((group) => <section className="permission-group" key={group}><h3 className="permission-group-title">{group.replace(/_/g, " ")}</h3>{keys.filter((key) => key.startsWith(`${group}.`)).map((key) => <div className="permission-row" key={key}><div className="permission-copy"><strong>{key.split(".").slice(1).join(" ").replace(/_/g, " ")}</strong><span>{key}</span></div><select aria-label={key} value={grants[key] === undefined ? individual ? "inherit" : "deny" : grants[key] ? "allow" : "deny"} onChange={(event) => setGrants((current) => {
        const next = { ...current }; if (event.target.value === "inherit") delete next[key]; else next[key] = event.target.value === "allow"; return next;
      })}>{individual && <option value="inherit">Use role</option>}<option value="allow" disabled={key === "users.manage" || (key === "reports.export" && selectedRole !== "manager" && selectedRole !== "admin")}>Allow</option><option value="deny">Restrict</option></select></div>)}</section>) : <p className="empty-state">Choose a team member to view and edit their access exceptions.</p>}</div>
      <div className="form-actions"><button className="button button-primary" disabled={!selected || busy} onClick={save}>{busy ? "Saving..." : "Save permissions"}</button></div>
    </section>}</div>
  </>;
}
