"use client";

import { useEffect, useState } from "react";
import { apiRequest, errorMessage } from "@/lib/crm-data";
import { Check, LoaderCircle, RotateCw, Save } from "lucide-react";

type RuleKey = "facebook" | "website" | "junk" | "not_interested" | "closed_won";
type Strategy = "single" | "round_robin";
type AssignmentRule = { rule_key: RuleKey; enabled: boolean; strategy: Strategy; owner_ids: string[]; next_owner_index: number };
type AssignmentUser = { id: string; full_name: string; active: boolean };
type AssignmentData = { canManage: boolean; users: AssignmentUser[]; rules: AssignmentRule[] };

const definitions: { key: RuleKey; title: string; description: string; rotating: boolean }[] = [
  { key: "facebook", title: "Facebook leads", description: "Assign leads received through Facebook integration sources.", rotating: true },
  { key: "website", title: "Website leads", description: "Assign website and chatbot leads, then notify the assigned user in CRM notifications.", rotating: true },
  { key: "junk", title: "Junk stage", description: "Reassign a lead whenever it enters the Junk stage.", rotating: false },
  { key: "not_interested", title: "Not Interested stage", description: "Reassign a lead whenever it enters the Not Interested stage.", rotating: false },
  { key: "closed_won", title: "Closed Won stage", description: "Reassign a lead whenever it enters the Closed Won stage.", rotating: false },
];

export function LeadAssignmentAutomations() {
  const [data, setData] = useState<AssignmentData | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<RuleKey | null>(null);

  async function load() {
    setError("");
    try { setData(await apiRequest<AssignmentData>("/api/automations/assignments", { forceFresh: true })); }
    catch (failure) { setError(errorMessage(failure, "Could not load assignment automations.")); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  function update(ruleKey: RuleKey, change: Partial<AssignmentRule>) {
    setMessage("");
    setData(current => current ? {
      ...current,
      rules: current.rules.map(rule => rule.rule_key === ruleKey ? { ...rule, ...change } : rule),
    } : current);
  }

  async function save(rule: AssignmentRule) {
    setSaving(rule.rule_key);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest<{ rule: AssignmentRule }>("/api/automations/assignments", {
        method: "PATCH",
        body: { rule_key: rule.rule_key, enabled: rule.enabled, strategy: rule.strategy, owner_ids: rule.owner_ids },
      });
      setData(current => current ? {
        ...current,
        rules: current.rules.map(item => item.rule_key === rule.rule_key ? result.rule : item),
      } : current);
      setMessage(`${definitions.find(item => item.key === rule.rule_key)?.title} automation saved.`);
    } catch (failure) { setError(errorMessage(failure, "Could not save this assignment automation.")); }
    finally { setSaving(null); }
  }

  if (loading) return <section className="panel" aria-label="Assignment automations"><p role="status"><LoaderCircle size={16} /> Loading assignment automations…</p></section>;
  return <section className="panel assignment-automations" aria-labelledby="assignment-automations-title">
    <div className="panel-heading">
      <div><h2 id="assignment-automations-title">Automatic lead assignment</h2><p>Choose who receives integration and stage-based leads. Changes apply to new leads and future stage changes.</p></div>
      <button className="button button-secondary" type="button" disabled={saving !== null} onClick={() => { setLoading(true); void load(); }}><RotateCw size={14} />Refresh</button>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {message && <p className="form-success" role="status"><Check size={15} />{message}</p>}
    {!data?.canManage && <p>You can view automation rules, but need automation management permission to edit assignments.</p>}
    {data?.canManage && !data.users.some(user => user.active) && <p className="form-error" role="alert">No active users are available to assign. Activate at least one CRM user first.</p>}
    <div className="assignment-automation-list">
      {definitions.map(definition => {
        const rule = data?.rules.find(item => item.rule_key === definition.key)
          ?? { rule_key: definition.key, enabled: false, strategy: "single" as const, owner_ids: [], next_owner_index: 0 };
        const isSaving = saving === rule.rule_key;
        const rotating = definition.rotating;
        const setOwners = (userId: string, checked: boolean) => {
          const owner_ids = rotating && rule.strategy === "round_robin"
            ? checked ? [...rule.owner_ids, userId] : rule.owner_ids.filter(id => id !== userId)
            : checked ? [userId] : [];
          update(rule.rule_key, { owner_ids });
        };
        return <article className="assignment-automation-card" key={definition.key}>
          <div className="assignment-automation-heading">
            <div><h3>{definition.title}</h3><p>{definition.description}</p></div>
            <span className={`assignment-automation-status${rule.enabled ? " is-enabled" : ""}`}>{rule.enabled ? "Enabled" : "Paused"}</span>
          </div>
          <label className="checkbox-field"><input type="checkbox" checked={rule.enabled} disabled={!data?.canManage || isSaving || !data.users.some(user => user.active)} onChange={event => update(rule.rule_key, { enabled: event.target.checked })} /> Enable this automation</label>
          {rotating && <label className="form-field assignment-automation-strategy">Assignment method
            <select className="form-input" value={rule.strategy} disabled={!data?.canManage || isSaving} onChange={event => {
              const strategy = event.target.value as Strategy;
              update(rule.rule_key, { strategy, owner_ids: strategy === "single" ? rule.owner_ids.slice(0, 1) : rule.owner_ids });
            }}>
              <option value="single">Always assign to one selected user</option>
              <option value="round_robin">Round robin across selected users</option>
            </select>
          </label>}
          <fieldset className="assignment-automation-users" disabled={!data?.canManage || isSaving}>
            <legend>{rule.strategy === "round_robin" ? "Select the rotation pool" : "Select an assignee"}</legend>
            {data?.users.map(user => <label className="checkbox-field" key={user.id}>
              <input
                type={rule.strategy === "round_robin" ? "checkbox" : "radio"}
                name={`assignment-${rule.rule_key}`}
                checked={rule.owner_ids.includes(user.id)}
                disabled={!user.active && !rule.owner_ids.includes(user.id)}
                onChange={event => setOwners(user.id, event.target.checked)}
              />
              {user.full_name}{!user.active && " (inactive)"}
            </label>)}
          </fieldset>
          {rule.strategy === "round_robin" && <small>Each new lead goes to the next active user in this list.</small>}
          {rule.enabled && rule.owner_ids.some(id => !data?.users.some(user => user.id === id && user.active)) && <small className="form-error">Remove inactive users before enabling this rule.</small>}
          {data?.canManage && <div className="assignment-automation-actions"><button className="button button-primary" type="button" disabled={isSaving || (rule.enabled && (rule.owner_ids.length === 0 || rule.owner_ids.some(id => !data.users.some(user => user.id === id && user.active))))} onClick={() => void save(rule)}>{isSaving ? <><LoaderCircle size={14} />Saving…</> : <><Save size={14} />Save rule</>}</button></div>}
        </article>;
      })}
    </div>
  </section>;
}
