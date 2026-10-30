"use client";

import { useEffect, useState } from "react";
import { apiRequest, errorMessage, formatDateTime } from "@/lib/crm-data";
import type { Profile } from "@/lib/types";
import { createCredentialPdf, downloadCredentialPdf } from "@/lib/credential-pdf";
import { KeyRound, Plus, Search, Trash2, Users } from "lucide-react";

type UserData = { profiles: Profile[]; activity: { user_id: string; signed_in_at: string; last_seen_at: string }[]; canManage: boolean; currentUserId: string };
const blank: Omit<Profile, "id" | "deletedAt"> = { fullName: "", email: "", phone: "", role: "counselor", reportingTo: null, status: "active", ivrExtension: "" };

export default function UsersPage() {
  const [data, setData] = useState<UserData | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [passwordTarget, setPasswordTarget] = useState<Profile | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [downloadCredentials, setDownloadCredentials] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Profile | null>(null);
  const [deleteEmail, setDeleteEmail] = useState("");
  function clearPassword() { setPassword(""); setConfirmPassword(""); }
  async function load() { setData(await apiRequest<UserData>("/api/users")); }
  useEffect(() => { load().catch((error) => setError(errorMessage(error, "Could not load users."))); }, []);
  async function action(callback: () => Promise<unknown>, success: string) {
    setError(""); setMessage(""); setBusy(true);
    try { await callback(); clearPassword(); setPasswordTarget(null); setEditing(null); setMessage(success); await load(); }
    catch (error) { setError(errorMessage(error, "User operation failed.")); await load().catch((loadError) => setError(errorMessage(loadError, "Could not refresh users."))); }
    finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><div><h1>Users & hierarchy</h1><p>Manage your admissions team, reporting relationships and account access.</p></div>{data?.canManage && <button disabled={busy} className="button button-primary" onClick={() => { setForm(blank); setPasswordTarget(null); setDeleteTarget(null); setDownloadCredentials(true); clearPassword(); setError(""); setMessage(""); setEditing("new"); }}><Plus size={16} />Add user</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
    {editing && <section className="panel settings-content users-form"><h2>{editing === "new" ? "Add user" : "Edit user"}</h2><p>{editing === "new" ? "Create an account and set its initial password. Email verification remains required at login." : "Update profile details and reporting access. Use Change password to manage credentials."}</p><form onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      if (editing === "new" && password !== confirmPassword) { setError("Passwords do not match."); return; }
      action(async () => {
        const pdf = editing === "new" && downloadCredentials ? await createCredentialPdf(form.email.trim(), password) : null;
        await apiRequest("/api/users", { method: editing === "new" ? "POST" : "PATCH", body: editing === "new" ? { ...form, password } : { action: "update", id: editing, profile: form } });
        if (pdf) {
          try { downloadCredentialPdf(pdf); }
          catch (error) { setError(`User was created, but the credential PDF could not be downloaded. Do not create the user again. ${errorMessage(error, "Check browser download permissions.")}`); }
        }
      }, editing === "new" ? "User created. Share the password through a secure channel; email verification is required at login." : "User saved.");
    }}><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><div className="form-grid">
      <label className="form-field">Name<input required value={form.fullName} onChange={(event) => setForm({ ...form, fullName: event.target.value })} /></label>
      <label className="form-field">Email<input type="email" required disabled={editing !== "new"} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
      <label className="form-field">Role<select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Profile["role"] })}>{["counselor", "team_lead", "manager", "admin", "super_admin"].map((role) => <option key={role} value={role}>{role.replace(/_/g, " ")}</option>)}</select></label>
      <label className="form-field">Reports to<select value={form.reportingTo ?? ""} onChange={(event) => setForm({ ...form, reportingTo: event.target.value || null })}><option value="">No manager</option>{data?.profiles.filter((profile) => profile.id !== editing && profile.status === "active").map((profile) => <option key={profile.id} value={profile.id}>{profile.fullName}</option>)}</select></label>
      <label className="form-field">Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
      <label className="form-field">IVR extension<input value={form.ivrExtension} onChange={(event) => setForm({ ...form, ivrExtension: event.target.value })} /></label>
      {editing === "new" && <><label className="form-field">Password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label><label className="form-field">Confirm password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label></>}
      <label className="checkbox-field"><input type="checkbox" checked={form.status === "active"} onChange={(event) => setForm({ ...form, status: event.target.checked ? "active" : "inactive" })} /> Active account</label>
    </div>{editing === "new" && <><label className="checkbox-field"><input type="checkbox" checked={downloadCredentials} onChange={(event) => setDownloadCredentials(event.target.checked)} /> Download email and password as a PDF when saved</label><p className="form-hint">The PDF contains a plaintext password. Store it securely and delete it after securely sharing the credentials.</p></>}<div className="form-actions"><button className="button button-primary" disabled={busy}>{busy ? "Saving..." : "Save user"}</button><button type="button" className="button button-secondary" onClick={() => { setEditing(null); clearPassword(); }}>Cancel</button></div></fieldset></form></section>}
    {passwordTarget && <section className="panel settings-content" aria-labelledby="change-password-heading"><h2 id="change-password-heading">Change password</h2><p>Set a new password for {passwordTarget.fullName} ({passwordTarget.email}). Existing sessions will be signed out. No reset email is sent.</p>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        if (password !== confirmPassword) { setError("Passwords do not match."); return; }
        setBusy(true); setError(""); setMessage("");
        try {
          const result = await apiRequest<{ signInRequired: boolean }>("/api/users", { method: "PATCH", body: { action: "password", id: passwordTarget.id, password } });
          clearPassword(); setPasswordTarget(null);
          if (result.signInRequired) { window.location.assign("/login?passwordUpdated=1"); return; }
          setMessage("Password changed. The user must sign in again with the new password and email verification code.");
        } catch (error) { setError(errorMessage(error, "Password could not be changed.")); }
        finally { setBusy(false); }
      }}><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}><div className="form-grid">
        <label className="form-field">New password<input autoFocus type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label className="form-field">Confirm new password<input type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      </div><p className="form-hint">Use a unique password of 12 to 128 characters. Share it only through a secure channel.</p><div className="form-actions"><button className="button button-primary" type="submit">{busy ? "Changing password..." : "Change password"}</button><button type="button" className="button button-secondary" onClick={() => { setPasswordTarget(null); clearPassword(); }}>Cancel</button></div></fieldset></form>
    </section>}
    {deleteTarget && <section className="panel settings-content" aria-labelledby="delete-user-heading"><h2 id="delete-user-heading">Delete user</h2>
      <p>Permanently delete the login account for {deleteTarget.fullName}? This cannot be undone. Existing sessions will be revoked. CRM records and historical attribution remain. Reassign their leads and team members before deletion if needed.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        action(async () => {
          await apiRequest("/api/users", { method: "DELETE", body: { id: deleteTarget.id, email: deleteEmail.trim() } });
          setDeleteTarget(null); setDeleteEmail("");
        }, "Login account permanently deleted. CRM records and history were preserved.");
      }}><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}><label className="form-field">Type {deleteTarget.email} to confirm<input type="email" autoComplete="off" required value={deleteEmail} onChange={(event) => setDeleteEmail(event.target.value)} /></label>
        <div className="form-actions"><button type="submit" className="button button-danger" disabled={deleteEmail.trim().toLowerCase() !== deleteTarget.email.toLowerCase()}>Permanently delete user</button>
        <button type="button" className="button button-secondary" onClick={() => { setDeleteTarget(null); setDeleteEmail(""); }}>Cancel</button>
      </div></fieldset></form>
    </section>}
    <section className="panel"><div className="panel-heading"><div><h2>Team directory</h2><p>Only Super Admin can create accounts or change passwords.</p></div><Users size={18} /></div><div className="table-toolbar"><label className="toolbar-search"><Search size={15} /><input placeholder="Search users" aria-label="Search users" value={query} onChange={(event) => setQuery(event.target.value)} /></label><span className="form-hint">{data?.profiles.length ?? 0} team members</span></div>
      <div className="table-wrap"><table className="data-table users-table"><thead><tr><th>User</th><th>Role</th><th>Reports to</th><th>Status</th><th>Last used</th><th>Actions</th></tr></thead><tbody>
        {data?.profiles.filter((profile) => `${profile.fullName} ${profile.email}`.toLowerCase().includes(query.toLowerCase())).map((profile) => <tr key={profile.id}>
          <td><div className="user-identity"><span className="avatar" aria-hidden="true">{profile.fullName.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span><div><strong>{profile.fullName}</strong><span className="table-sub">{profile.email}</span></div></div></td><td>{profile.role.replace(/_/g, " ")}</td><td>{data.profiles.find((manager) => manager.id === profile.reportingTo)?.fullName || "None"}</td><td><span className={`status-pill ${profile.status === "active" ? "pill-green" : "pill-red"}`}>{profile.status}</span></td>
          <td>{formatDateTime(data.activity.find((session) => session.user_id === profile.id)?.last_seen_at) || "No recorded activity"}</td>
          <td>{data.canManage && <div className="heading-actions"><button className="button button-secondary button-small" disabled={busy} onClick={() => { clearPassword(); setDeleteTarget(null); setPasswordTarget(null); setError(""); setMessage(""); setEditing(profile.id); setForm(profile); }}>Edit</button><button disabled={busy} className="button button-secondary button-small" onClick={() => { clearPassword(); setDeleteTarget(null); setEditing(null); setError(""); setMessage(""); setPasswordTarget(profile); }}><KeyRound size={13} />Change password</button><button disabled={busy || profile.id === data.currentUserId} title={profile.id === data.currentUserId ? "You cannot delete your own account" : undefined} className="button button-danger button-small" onClick={() => { clearPassword(); setPasswordTarget(null); setEditing(null); setError(""); setMessage(""); setDeleteEmail(""); setDeleteTarget(profile); }}><Trash2 size={13} />Delete user</button></div>}</td>
        </tr>)}
      </tbody></table>{!data && !error && <p className="empty-state" role="status">Loading users...</p>}{data && !data.profiles.some((profile) => `${profile.fullName} ${profile.email}`.toLowerCase().includes(query.toLowerCase())) && <p className="empty-state">No team members match your search.</p>}</div>
    </section>
  </>;
}
