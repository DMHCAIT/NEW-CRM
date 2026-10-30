"use client";

import { useState } from "react";
import { Play, Workflow } from "lucide-react";
import { LeadOption, LeadSelect, OperationFeedback, formValues, useOperationalData } from "../integrations/operational-ui";

type Rule = { id: string; name: string; trigger_config: { type: string }; actions_json: { type: string; days: number }[]; is_active: boolean };
type Log = { id: string; automation_id: string; lead_id: string; result: string; created_at: string; details: { action?: string } };
type Data = { automations: Rule[]; logs: Log[]; leads: LeadOption[]; canManage: boolean; canEditLeads: boolean };

export default function AutomationsPage() {
  const state = useOperationalData<Data>("/api/automations");
  const [showForm, setShowForm] = useState(false);
  const [runRule, setRunRule] = useState<Rule | null>(null);
  const data = state.data;
  return <>
    <div className="page-heading"><div><h1>Automations</h1><p>Organize follow-up rules and review their execution history.</p></div><div className="heading-actions"><button className="button button-secondary" onClick={() => void state.refresh()}>Refresh</button>{data?.canManage && <button className="button button-primary" onClick={() => setShowForm(!showForm)}>Create rule</button>}</div></div>
    <OperationFeedback {...state} />
    <div className="helper-banner">Supported execution: operator-triggered rules for one selected lead, or an overdue-follow-up batch of up to 100 accessible leads. Actions: notify the operator in-app, or set a follow-up date (requires lead edit permission). No scheduler, background stage triggers, round-robin assignment or provider simulation. Each rule/lead/operator executes at most once per database day; actions and logs commit together.</div>
    {showForm && data?.canManage && <section className="panel"><div className="panel-heading"><div><h2>Create automation rule</h2><p>Configure a supported trigger and action.</p></div><button type="button" className="button button-secondary button-small" onClick={() => setShowForm(false)}>Cancel</button></div><form className="operational-form" onSubmit={async (event) => {
      event.preventDefault();
      const input = formValues(event.currentTarget);
      if (await state.mutate("/api/automations", "POST", { ...input, days: Number(input.days), is_active: input.is_active === "on" })) setShowForm(false);
    }}>
      <label>Name<input className="form-input" name="name" maxLength={200} required /></label>
      <label>Trigger<select className="form-input" name="trigger"><option value="manual">Manual — selected lead</option><option value="followup_overdue">Overdue follow-ups — run batch manually</option></select></label>
      <label>Action<select className="form-input" name="action"><option value="notify_me">Create in-app notification for me</option><option value="set_followup" disabled={!data.canEditLeads}>Set follow-up in N days</option></select></label>
      <label>Days from execution<input className="form-input" type="number" name="days" min={1} max={365} defaultValue={1} required /></label>
      <label><input type="checkbox" name="is_active" /> Enable rule</label>
      <button className="button button-primary" disabled={state.busy}>Save rule</button>
    </form></section>}
    {runRule && data && <section className="panel"><form className="operational-form" onSubmit={async (event) => {
      event.preventDefault();
      const input = formValues(event.currentTarget);
      if (await state.mutate(`/api/automations/${runRule.id}`, "POST", { lead_id: input.lead_id || null })) setRunRule(null);
    }}><h2>Run {runRule.name}</h2>{runRule.trigger_config.type === "manual" ? <LeadSelect leads={data.leads} required /> : <p>Processes overdue accessible leads only, up to 100 per batch. Already processed leads are skipped.</p>}<button className="button button-primary" disabled={state.busy}>Execute now</button><button type="button" className="button button-secondary" onClick={() => setRunRule(null)}>Dismiss</button></form></section>}
    <section className="panel"><div className="panel-heading"><h2>Rules</h2><p>{data?.automations.filter((rule) => rule.is_active).length ?? 0} enabled</p></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Rule</th><th>Trigger</th><th>Action</th><th>Status</th><th>Actions</th></tr></thead><tbody>{data?.automations.map((rule) => <tr key={rule.id}><td><span className="lead-cell"><span className="report-icon"><Workflow size={15} /></span>{rule.name}</span></td><td>{rule.trigger_config.type === "manual" ? "Selected lead" : rule.trigger_config.type === "followup_overdue" ? "Overdue batch (manual)" : "Unsupported legacy trigger"}</td><td>{rule.actions_json[0]?.type === "notify_me" ? "Notify operator" : rule.actions_json[0]?.type === "set_followup" ? `Follow-up in ${rule.actions_json[0].days} days` : "Unsupported legacy action"}</td><td><span className={`status-pill ${rule.is_active ? "pill-green" : "pill-amber"}`}>{rule.is_active ? "Enabled" : "Paused"}</span></td><td>{data.canManage && <div className="heading-actions"><button className="button button-secondary button-small" disabled={state.busy} onClick={() => void state.mutate(`/api/automations/${rule.id}`, "PATCH", { is_active: !rule.is_active })}>{rule.is_active ? "Pause" : "Enable"}</button><button className="button button-primary button-small" disabled={state.busy || !rule.is_active} onClick={() => setRunRule(rule)}><Play size={12} />Run</button></div>}</td></tr>)}</tbody></table></div>{!state.loading && !data?.automations.length && <p className="empty-state">No automation rules. Create one to begin.</p>}</section>
    <section className="panel"><div className="panel-heading"><h2>Latest 100 visible execution records</h2></div><div className="table-wrap"><table className="data-table"><thead><tr><th>When</th><th>Rule</th><th>Lead</th><th>Action</th><th>Result</th></tr></thead><tbody>{data?.logs.map((log) => <tr key={log.id}><td>{new Date(log.created_at).toLocaleString()}</td><td>{data.automations.find((rule) => rule.id === log.automation_id)?.name ?? log.automation_id}</td><td>{data.leads.find((lead) => lead.id === log.lead_id)?.name ?? "Linked lead"}</td><td>{log.details.action ?? "—"}</td><td>{log.result}</td></tr>)}</tbody></table></div>{!state.loading && !data?.logs.length && <p style={{ padding: 20 }}>No executions recorded. Failed transactions do not create success records; errors are shown above.</p>}</section>
  </>;
}
