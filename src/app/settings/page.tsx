"use client";

import { useEffect, useState } from "react";
import { apiRequest, errorMessage } from "@/lib/crm-data";
import { SettingsNav } from "@/components/settings-nav";
import { LEAD_PICKLIST_KEYS, type LeadPicklistKey } from "@/lib/lead-picklists";
import { STANDARD_LEAD_FIELDS } from "@/lib/lead-fields";

type Configuration = {
  stages: { id?: string; name: string; is_terminal: boolean }[];
  settings: {
    duplicateFields: string;
    creationPolicy: string;
    fields: { name: string; active: boolean; type: "text" | "dropdown"; options: string[] }[];
    picklists: Record<LeadPicklistKey, string[]>;
  };
  canManagePicklists: boolean;
};
const PICKLIST_LABELS: Record<LeadPicklistKey, string> = {
  countryCode: "Country codes",
  country: "Countries",
  qualification: "Qualifications",
  category: "Categories",
  course: "Courses",
  source: "Lead sources",
};

export default function SettingsPage() {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [field, setField] = useState("");
  const [fieldType, setFieldType] = useState<"text" | "dropdown">("text");
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const [picklistDrafts, setPicklistDrafts] = useState<Record<LeadPicklistKey, string>>({
    countryCode: "", country: "", qualification: "", category: "", course: "", source: "",
  });
  useEffect(() => { apiRequest<Configuration>("/api/settings").then(setConfig).catch((error) => setError(errorMessage(error, "Could not load settings."))); }, []);
  async function save() {
    setBusy(true); setError(""); setMessage("");
    try { await apiRequest("/api/settings", { method: "PUT", body: config }); setMessage("Settings saved."); setConfig(await apiRequest<Configuration>("/api/settings")); }
    catch (error) { setError(errorMessage(error, "Could not save settings.")); }
    finally { setBusy(false); }
  }
  return <>
    <div className="page-heading"><div><h1>CRM settings</h1><p>Customize lead stages, fields and duplicate handling for your team.</p></div><button disabled={!config || busy} className="button button-primary" onClick={save}>Save changes</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}{message && <p className="form-success" role="status">{message}</p>}
    <div className="settings-layout"><SettingsNav current="configuration" />
    {!config ? <section className="panel settings-content"><p role="status">{error ? "Configuration could not be loaded." : "Loading configuration..."}</p></section> : <section className="panel settings-content">
      <h2>Lead stages</h2><p>Removing a stage deactivates it without deleting historical leads. Terminal stages are excluded from follow-ups due.</p>
      <div className="settings-stages">{config.stages.map((stage, index) => <div className="stage-editor-row" key={stage.id ?? index}>
        <span className="stage-order">{index + 1}</span>
        <input aria-label={`Stage ${index + 1}`} disabled={!config.canManagePicklists || stage.name.toLocaleLowerCase() === "fresh"} value={stage.name} onChange={(event) => setConfig({ ...config, stages: config.stages.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} />
        <label className="checkbox-field"><input type="checkbox" disabled={!config.canManagePicklists || stage.name.toLocaleLowerCase() === "fresh"} checked={stage.is_terminal} onChange={(event) => setConfig({ ...config, stages: config.stages.map((item, i) => i === index ? { ...item, is_terminal: event.target.checked } : item) })} /> Terminal</label>
        {config.canManagePicklists && stage.name.toLocaleLowerCase() !== "fresh" && <button className="button button-secondary" onClick={() => setConfig({ ...config, stages: config.stages.filter((_, i) => i !== index) })}>Remove</button>}
      </div>)}</div>
      {config.canManagePicklists && <button className="button button-secondary" onClick={() => setConfig({ ...config, stages: [...config.stages, { name: "", is_terminal: false }] })}>Add stage</button>}
      <div className="settings-divider" /><h2>Lead fields</h2>
      <p className="form-hint">Standard fields are always available. Add custom text or dropdown fields; dropdown values are managed here.</p>
      <div className="custom-fields-list">
        {STANDARD_LEAD_FIELDS.map((item) => <div className="custom-field-row" key={`standard-${item.name}`}>
          <span>{item.name}</span><span className="field-type">{item.type === "dropdown" ? "Dropdown" : "Text"}{item.required ? " · Required" : ""}</span><span className="field-type">Standard</span>
        </div>)}
        {config.settings.fields.map((item, index) => <div className="custom-field-row custom-field-row-configurable" key={item.name}>
          <span>{item.name}</span>
          <select aria-label={`${item.name} field type`} disabled={!config.canManagePicklists} value={item.type} onChange={(event) => setConfig({ ...config, settings: { ...config.settings, fields: config.settings.fields.map((row, i) => i === index ? { ...row, type: event.target.value as "text" | "dropdown", options: event.target.value === "dropdown" ? row.options : [] } : row) } })}>
            <option value="text">Text</option><option value="dropdown">Dropdown</option>
          </select>
          <label className="checkbox-field"><input type="checkbox" disabled={!config.canManagePicklists} checked={item.active} onChange={(event) => setConfig({ ...config, settings: { ...config.settings, fields: config.settings.fields.map((row, i) => i === index ? { ...row, active: event.target.checked } : row) } })} /> Active</label>
          {config.canManagePicklists && <button type="button" className="button button-quiet button-small" onClick={() => setConfig({ ...config, settings: { ...config.settings, fields: config.settings.fields.filter((_, i) => i !== index) } })}>Remove</button>}
          {item.type === "dropdown" && <div className="custom-field-options">
            <div className="lead-picklist-values">{[...item.options].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((value) => <div className="lead-picklist-value" key={value}>
              <span>{value}</span>{config.canManagePicklists && <button type="button" className="button button-quiet button-small" aria-label={`Remove ${value} from ${item.name}`} disabled={item.options.length <= 1} onClick={() => setConfig({ ...config, settings: { ...config.settings, fields: config.settings.fields.map((row, i) => i === index ? { ...row, options: row.options.filter((option) => option !== value) } : row) } })}>Remove</button>}
            </div>)}</div>
            {config.canManagePicklists && <div className="add-custom-field">
              <input aria-label={`New ${item.name} dropdown value`} value={optionDrafts[item.name] ?? ""} onChange={(event) => setOptionDrafts({ ...optionDrafts, [item.name]: event.target.value })} />
              <button type="button" className="button button-secondary" onClick={() => {
                const value = (optionDrafts[item.name] ?? "").trim();
                if (!value || item.options.some((option) => option.toLocaleLowerCase() === value.toLocaleLowerCase())) { setError(`Enter a unique dropdown value for ${item.name}.`); return; }
                setConfig({ ...config, settings: { ...config.settings, fields: config.settings.fields.map((row, i) => i === index ? { ...row, options: [...row.options, value].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })) } : row) } });
                setOptionDrafts({ ...optionDrafts, [item.name]: "" }); setError("");
              }}>Add value</button>
            </div>}
          </div>}
        </div>)}
      </div>
      {config.canManagePicklists && <div className="add-custom-field lead-field-add">
        <input aria-label="Field name" placeholder="New field name" value={field} onChange={(event) => setField(event.target.value)} />
        <select aria-label="New field type" value={fieldType} onChange={(event) => setFieldType(event.target.value as "text" | "dropdown")}><option value="text">Text</option><option value="dropdown">Dropdown</option></select>
        <button type="button" className="button button-secondary" onClick={() => {
        const name = field.trim();
        if (!name || STANDARD_LEAD_FIELDS.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase()) || config.settings.fields.some((item) => item.name.toLowerCase() === name.toLowerCase())) { setError("Enter a unique field name."); return; }
        setConfig({ ...config, settings: { ...config.settings, fields: [...config.settings.fields, { name, active: true, type: fieldType, options: [] }] } }); setField(""); setError("");
      }}>Add field</button></div>}
      <div className="settings-divider" /><h2>Dropdown values</h2>
      <p className="form-hint">These alphabetically sorted options are shared across lead forms and filters. Removing an option does not change existing leads.</p>
      <div className="lead-picklist-settings">
        {LEAD_PICKLIST_KEYS.map((key) => <section className="lead-picklist-editor" key={key} aria-labelledby={`picklist-${key}`}>
          <h3 id={`picklist-${key}`}>{PICKLIST_LABELS[key]}</h3>
          <div className="lead-picklist-values">{[...config.settings.picklists[key]].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((value) => <div className="lead-picklist-value" key={value}>
            <span>{value}</span>
            {config.canManagePicklists && <button type="button" className="button button-quiet button-small" aria-label={`Remove ${value} from ${PICKLIST_LABELS[key]}`} disabled={config.settings.picklists[key].length <= 1} onClick={() => setConfig({ ...config, settings: { ...config.settings, picklists: { ...config.settings.picklists, [key]: config.settings.picklists[key].filter((item) => item !== value) } } })}>Remove</button>}
          </div>)}</div>
          {config.canManagePicklists && <div className="add-custom-field"><input aria-label={`New ${PICKLIST_LABELS[key]} value`} value={picklistDrafts[key]} onChange={(event) => setPicklistDrafts({ ...picklistDrafts, [key]: event.target.value })} /><button type="button" className="button button-secondary" onClick={() => {
            const value = picklistDrafts[key].trim();
            if (!value || config.settings.picklists[key].some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) { setError(`Enter a new unique value for ${PICKLIST_LABELS[key].toLocaleLowerCase()}.`); return; }
            setConfig({ ...config, settings: { ...config.settings, picklists: { ...config.settings.picklists, [key]: [...config.settings.picklists[key], value].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })) } } });
            setPicklistDrafts({ ...picklistDrafts, [key]: "" }); setError("");
          }}>Add value</button></div>}
        </section>)}
      </div>
      <div className="settings-divider" /><h2>Duplicate handling</h2>
      <div className="form-grid settings-form-grid"><label className="form-field">Match fields<select value={config.settings.duplicateFields} onChange={(event) => setConfig({ ...config, settings: { ...config.settings, duplicateFields: event.target.value } })}><option value="phone_email">Phone or email</option><option value="phone">Phone only</option><option value="email">Email only</option></select></label>
      <label className="form-field">Creation policy<select value={config.settings.creationPolicy} onChange={(event) => setConfig({ ...config, settings: { ...config.settings, creationPolicy: event.target.value } })}><option value="block">Block exact duplicates</option><option value="warn">Warn and allow admins</option><option value="allow">Allow with audit log</option></select></label>
      </div><div className="form-actions"><button disabled={busy} className="button button-primary" onClick={save}>{busy ? "Saving..." : "Save changes"}</button><span className="form-hint">Changes apply across your live CRM.</span></div>
    </section>}</div>
  </>;
}
