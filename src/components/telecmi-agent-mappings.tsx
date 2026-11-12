"use client";

import { useState } from "react";
import { Phone, RefreshCw } from "lucide-react";
import { OperationFeedback, operationRequest, useOperationalData } from "@/app/integrations/operational-ui";
import { TELECMI_CALL_MESSAGE } from "@/lib/telecmi";

type Mapping = { user_id: string; agent_id: string; revision: string; updated_at: string };
type TelecmiData = {
  canManage: boolean;
  users: { id: string; full_name: string; email: string | null; status: string }[];
  mappings: Mapping[];
};

export function TelecmiAgentMappings() {
  const state = useOperationalData<TelecmiData>("/api/integrations/telecmi");
  const [userId, setUserId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [revision, setRevision] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function chooseUser(id: string) {
    const mapping = state.data?.mappings.find(item => item.user_id === id);
    setUserId(id); setAgentId(mapping?.agent_id ?? ""); setRevision(mapping?.revision ?? null);
    setError(""); setMessage("");
  }
  async function save(input: { action: "save"; userId: string; agentId: string; revision: string | null } | { action: "remove"; userId: string; revision: string }) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await operationRequest<{ message: string }>("/api/integrations/telecmi", "POST", input);
      setMessage(result.message); setUserId(""); setAgentId(""); setRevision(null);
      await state.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "TeleCMI agent mapping could not be saved.");
      await state.refresh();
    } finally { setBusy(false); }
  }
  return <section className="panel integration-workspace" id="integration-telecmi" aria-label="TeleCMI agent mapping">
    <div className="panel-heading"><div><span className="integration-category">TELECMI / CLICK TO CALL</span><h2><Phone size={18} />TeleCMI agent mapping</h2><p>Connect each CRM user to their own TeleCMI agent identity. Installing an app does not create this mapping.</p></div><button type="button" className="button button-secondary" disabled={busy || state.refreshing} onClick={() => void state.refresh()}><RefreshCw size={14} />Refresh mappings</button></div>
    <div className="telecmi-setup-body">
      <p className="integration-network-note" role="status">{TELECMI_CALL_MESSAGE}</p>
      <p>TeleCMI controls whether its Windows/desktop app, mobile app or configured phone rings. Use the same mapped agent account and configure device routing and availability with TeleCMI. CRM does not require or detect a specific installed app.</p>
      <p>Map every counsellor to their own TeleCMI agent ID. Calls use the signed-in counsellor&apos;s mapping, never the administrator&apos;s identity or the lead owner&apos;s mapping. TeleCMI call history attributes the call to that agent; set the agent&apos;s name and email in TeleCMI. CRM names and emails alone cannot replace a TeleCMI agent ID.</p>
      <OperationFeedback {...state} error={error || state.error} message={message} />
      {state.data && !state.data.canManage && <p className="integration-readonly">Ask an Admin or Super Admin with integration management access to configure your TeleCMI agent mapping.</p>}
      {state.data?.canManage && <>
        <form className="operational-form" aria-label="Save TeleCMI agent mapping" onSubmit={event => { event.preventDefault(); void save({ action: "save", userId, agentId, revision }); }}>
          <label>CRM user<select className="form-input" required value={userId} disabled={busy} onChange={event => chooseUser(event.target.value)}><option value="">Select an active CRM user</option>{state.data.users.filter(user => user.status === "active").map(user => <option value={user.id} key={user.id}>{user.full_name}{user.email ? ` (${user.email})` : ""}{state.data?.mappings.some(mapping => mapping.user_id === user.id) ? " (mapped)" : ""}</option>)}</select></label>
          <label>TeleCMI agent ID<input className="form-input" required value={agentId} disabled={busy} onChange={event => setAgentId(event.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9_.@\-]{0,99}" maxLength={100} autoComplete="off" placeholder="Agent ID from your TeleCMI account" /><span className="integration-field-help">Not a phone number, password or CRM user ID. One TeleCMI agent per CRM user.</span></label>
          <div className="integration-config-actions"><button type="submit" className="button button-primary" disabled={busy || state.refreshing || Boolean(state.error)}>{busy ? "Saving..." : "Save agent mapping"}</button>{userId && <button type="button" className="button button-secondary" disabled={busy} onClick={() => chooseUser("")}>Cancel</button>}</div>
        </form>
        {!state.data.mappings.length && <p className="integration-empty">No TeleCMI agents mapped yet. Add your active counsellors above.</p>}
        {!!state.data.mappings.length && <div className="table-wrap"><table className="data-table"><thead><tr><th>CRM user</th><th>TeleCMI agent ID</th><th>Calling</th><th>Actions</th></tr></thead><tbody>{state.data.mappings.map(mapping => {
          const user = state.data?.users.find(item => item.id === mapping.user_id);
          return <tr key={mapping.user_id}><td>{user?.full_name ?? "Unavailable CRM user"}{user?.email && <span className="table-sub">{user.email}</span>}{user?.status !== "active" && <span className="table-sub">Inactive or removed user</span>}</td><td><code>{mapping.agent_id}</code></td><td>{user?.status === "active" ? "Mapped - requires account credentials" : "Inactive"}</td><td><div className="heading-actions"><button type="button" className="button button-secondary" disabled={busy || state.refreshing || user?.status !== "active"} onClick={() => chooseUser(mapping.user_id)}>Edit mapping</button><button type="button" className="button button-quiet" disabled={busy || state.refreshing} onClick={() => { if (confirm("Remove this CRM user's TeleCMI agent mapping?")) void save({ action: "remove", userId: mapping.user_id, revision: mapping.revision }); }}>Remove</button></div></td></tr>;
        })}</tbody></table></div>}
      </>}
    </div>
  </section>;
}
