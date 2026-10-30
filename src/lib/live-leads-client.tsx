"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { apiRequest, getCachedApiRead, type StageRow } from "@/lib/crm-data";
import type { CurrentUser, Lead, Profile } from "@/lib/types";
import { FILTER_FIELDS, criterionError, defaultOperator, operatorNeedsValue, operatorsForField, type FilterField, type SavedLeadFilter } from "@/lib/lead-filters";
import type { LeadConfiguration } from "@/lib/live-leads";
import { DEFAULT_LEAD_PICKLISTS, type LeadPicklistKey } from "@/lib/lead-picklists";
import type { LeadCursor } from "@/lib/server/lead-query";

export type LiveLeadData = {
  leads: Lead[]; stages: StageRow[]; profiles: Profile[]; user: CurrentUser;
  filters: { id: string; name: string; filter_json: SavedLeadFilter; pinned_to_dashboard: boolean }[];
  columns: string[] | null;
  configuration: LeadConfiguration;
  hasMore: boolean;
  nextCursor: LeadCursor | null;
  total?: number;
};

export function useLiveLeadData<T = LiveLeadData>(path = "/api/leads") {
  const [data, setData] = useState<T | null>(() => getCachedApiRead<T>(path) ?? null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => getCachedApiRead<T>(path) === undefined);
  const [loadedPath, setLoadedPath] = useState(path);
  const requestId = useRef(0);
  const load = useCallback(async (maxAgeMs: number) => {
    const current = ++requestId.current;
    try {
      const next = await apiRequest<T>(path, { maxAgeMs });
      if (current === requestId.current) { setData(next); setLoadedPath(path); setError(""); }
    }
    catch (e) {
      if (current === requestId.current) setError(e instanceof Error ? e.message : "Could not load CRM data.");
      throw e;
    }
    finally { if (current === requestId.current) setLoading(false); }
  }, [path]);
  const reload = useCallback(() => load(0), [load]);
  useEffect(() => {
    const sequence = requestId;
    const saved = getCachedApiRead<T>(path);
    if (saved !== undefined) { setData(saved); setLoadedPath(path); }
    setLoading(saved === undefined);
    void load(30000).catch(() => {});
    return () => { sequence.current++; };
  }, [load, path]);
  return { data, error, loading: loading || loadedPath !== path, reload, setError };
}

export function useDebouncedValue<T>(value: T, delay = 250, enabled = true) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay, enabled]);
  return settled;
}

export function leadQueryPath(filter: SavedLeadFilter, options: {
  cursor?: LeadCursor | null; dashboard?: boolean; view?: string;
  owner?: string; stage?: string; sort?: string; offset?: number; count?: boolean;
} = {}, base = "/api/leads") {
  const params = new URLSearchParams();
  if (filter.criteria.length || filter.query || filter.quickView === "My Leads") params.set("filter", JSON.stringify(filter));
  if (typeof window !== "undefined") params.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (options.cursor) params.set("cursor", JSON.stringify(options.cursor));
  if (options.dashboard) params.set("dashboard", "1");
  if (options.view) params.set("view", options.view);
  if (options.owner) params.set("owner", options.owner);
  if (options.stage) params.set("stage", options.stage);
  if (options.sort && options.sort !== "newest") params.set("sort", options.sort);
  if (options.offset) params.set("offset", String(options.offset));
  if (options.count) params.set("count", "1");
  const suffix = params.toString();
  return base + (suffix ? `?${suffix}` : "");
}

export function emptyFilter(): SavedLeadFilter {
  return { id: "", name: "", criteria: [], matchMode: "all", query: "", quickView: "All accessible leads" };
}

export function LiveFilterEditor({ filter, onChange, leads, stages = [], profiles = [], picklists = DEFAULT_LEAD_PICKLISTS }: {
  filter: SavedLeadFilter; onChange: (filter: SavedLeadFilter) => void; leads: Lead[];
  stages?: StageRow[]; profiles?: Profile[];
  picklists?: LeadConfiguration["picklists"];
}) {
  const addCondition = () => onChange({ ...filter, criteria: [...filter.criteria, { id: crypto.randomUUID(), field: "stage", operator: "is", value: "" }] });
  return <section className="panel filter-panel" aria-label="Lead filters">
    <div className="panel-heading"><h2><SlidersHorizontal size={15} /> Filters</h2><button type="button" className="text-link filter-reset" onClick={() => onChange(emptyFilter())}><RotateCcw size={12} /> Reset</button></div>
    <div className="filter-content">
      <input className="filter-value-input" type="search" aria-label="Search leads" placeholder="Search leads" value={filter.query} onChange={(e) => onChange({ ...filter, query: e.target.value })} />
      <span className="filter-label">VIEWS</span>
      {["All accessible leads", "My Leads"].map((view) => <button type="button" key={view} className={`filter-option${filter.quickView === view ? " active" : ""}`} aria-pressed={filter.quickView === view} onClick={() => onChange({ ...filter, quickView: view })}>{view}</button>)}
      <div className="criteria-builder">
      <div className="criteria-heading"><span className="filter-label">CONDITIONS</span><button type="button" className="text-link" onClick={addCondition}><Plus size={12} /> Add condition</button></div>
      <div className="criteria-match" role="group" aria-label="Condition matching"><span>Match</span>{(["all", "any"] as const).map((mode) => <button type="button" key={mode} className={filter.matchMode === mode ? "selected" : ""} aria-pressed={filter.matchMode === mode} onClick={() => onChange({ ...filter, matchMode: mode })}>{mode === "all" ? "All" : "Any"}</button>)}</div>
      {filter.criteria.map((c, index) => {
      const field = FILTER_FIELDS.find((f) => f.key === c.field);
      const kind = field?.kind;
      const selectedValues = ["in", "not_in"].includes(c.operator) ? c.value.split("\n").filter(Boolean) : c.value ? [c.value] : [];
      const fieldKey = c.field;
      const picklistKey: Partial<Record<FilterField, LeadPicklistKey>> = {
        countryCode: "countryCode", country: "country", qualification: "qualification",
        category: "category", course: "course", source: "source",
      };
      const configured = fieldKey === "stage" ? stages.map(stage => stage.name)
        : fieldKey === "assignee" ? profiles.map(profile => profile.fullName)
          : picklistKey[fieldKey] ? picklists[picklistKey[fieldKey]!] : [];
      const values = fieldKey === "untouched" || configured.length ? [] : leads.map(lead => String(lead[fieldKey] ?? ""));
      const options = [...new Set([...configured, ...values, ...selectedValues].filter(Boolean))].sort().map(value => ({ value, label: value }));
      const operators = operatorsForField(c.field);
      if (!operators.some(operator => operator.value === c.operator)) operators.push({ value: c.operator, label: c.operator.replaceAll("_", " ") });
      const patch = (value: Partial<typeof c>) => onChange({ ...filter, criteria: filter.criteria.map((item) => item.id === c.id ? { ...item, ...value } : item) });
      return <div className="filter-criterion" key={c.id}>
        {index > 0 && <span className="criterion-join">{filter.matchMode === "all" ? "AND" : "OR"}</span>}
        <div className="criterion-topline"><span>Condition {index + 1}</span><button type="button" className="saved-filter-delete" aria-label="Remove condition" onClick={() => onChange({ ...filter, criteria: filter.criteria.filter((item) => item.id !== c.id) })}><X size={13} /></button></div>
        <SearchableDropdown ariaLabel="Filter field" placeholder="Choose field" value={c.field} options={FILTER_FIELDS.map(f => ({ value: f.key, label: f.label }))} onChange={value => {
          const next = FILTER_FIELDS.find(f => f.key === value);
          if (next) patch({ field: next.key, operator: defaultOperator(next.key), value: "", secondValue: "" });
        }} />
        <SearchableDropdown ariaLabel="Filter operator" placeholder="Choose operator" value={c.operator} options={operators} onChange={value => {
          const next = operators.find(operator => operator.value === value);
          if (next) patch({ operator: next.value, value: "", secondValue: "" });
        }} />
        {operatorNeedsValue(c.operator) && <>
          {kind === "choice" && ["is", "is_not", "in", "not_in"].includes(c.operator)
            ? ["in", "not_in"].includes(c.operator)
              ? <SearchableDropdown multiple ariaLabel="Filter values" placeholder="Choose values" value={selectedValues} options={options} onChange={values => patch({ value: values.join("\n") })} />
              : <SearchableDropdown ariaLabel="Filter value" placeholder="Choose a value" value={c.value} options={options} onChange={value => patch({ value })} />
            : ["in", "not_in"].includes(c.operator) ? <textarea aria-label="Filter values, one per line" placeholder="One value per line" value={c.value} onChange={event => patch({ value: event.target.value })} />
            : <input className="filter-value-input" aria-label="Filter value" placeholder={kind === "date" || kind === "boolean" ? undefined : "Enter a value"} type={["last_days", "next_days"].includes(c.operator) ? "number" : kind === "date" || kind === "boolean" ? "date" : "text"} min={["last_days", "next_days"].includes(c.operator) ? 1 : undefined} value={c.value} onChange={(e) => patch({ value: e.target.value })} />}
        </>}
        {["between", "not_between", "custom_date"].includes(c.operator) && <input className="filter-value-input" type="date" aria-label="Filter end date" value={c.secondValue ?? ""} onChange={(e) => patch({ secondValue: e.target.value })} />}
        {criterionError(c) && <p className="filter-validation" role="alert">{criterionError(c)}</p>}
      </div>;
    })}
    {!filter.criteria.length && <p className="saved-filter-empty">Add conditions to narrow your leads.</p>}
    </div>
    </div>
  </section>;
}

export type LeadDraft = {
  name: string; phone: string; countryCode: string; altPhone: string; email: string; country: string; course: string; qualification: string; category: string;
  source: string; stageId: string | null; assigneeId: string | null; followUpAt: string | null; closureFee: number;
  customFields: Record<string, string>;
};
export function leadDraft(lead?: Lead & { customFields?: Record<string, string> }): LeadDraft {
  return {
    name: lead?.name ?? "", phone: lead?.phone ?? "", countryCode: lead?.countryCode ?? "", altPhone: lead?.altPhone ?? "", email: lead?.email ?? "",
    country: lead?.country ?? "", course: lead?.course ?? "", qualification: lead?.qualification ?? "", category: lead?.category ?? "",
    source: lead?.source ?? "", stageId: lead?.stageId ?? null, assigneeId: lead?.assigneeId ?? null,
    followUpAt: lead?.followUpAt ?? null, closureFee: lead?.closureFee ?? 0,
    customFields: lead?.customFields ?? {},
  };
}

type DuplicateMatch = { match_field: "phone" | "email"; lead_id: string | null; lead_name: string | null; assignee: string; in_bucket: boolean };

export function LeadForm({ initial, stages, profiles, canAssign, onSave, busy, submitLabel = "Save lead", fields = [], picklists = DEFAULT_LEAD_PICKLISTS, newLead = false }: {
  initial: LeadDraft; stages: StageRow[]; profiles: Profile[]; canAssign: boolean;
  onSave: (draft: LeadDraft) => Promise<void>; busy: boolean; submitLabel?: string;
  fields?: LeadConfiguration["fields"];
  picklists?: LeadConfiguration["picklists"];
  newLead?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial); }, [initial]);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const duplicateLookup = useDebouncedValue(JSON.stringify([draft.phone, draft.countryCode, draft.email]), 400, newLead);
  useEffect(() => {
    if (!newLead) return;
    const [phone, countryCode, email] = JSON.parse(duplicateLookup) as string[];
    if (phone.replace(/\D/g, "").length < 7 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setDuplicates([]); return; }
    let cancelled = false;
    apiRequest<{ matches: DuplicateMatch[] }>(`/api/leads/duplicates?${new URLSearchParams({ phone, countryCode, email })}`)
      .then((result) => { if (!cancelled) setDuplicates(result.matches); })
      .catch(() => { if (!cancelled) setDuplicates([]); });
    return () => { cancelled = true; };
  }, [duplicateLookup, newLead]);
  const renderDuplicates = (field: "phone" | "email") => {
    const matches = duplicates.filter((match) => match.match_field === field);
    if (!matches.length) return null;
    return <div className="helper-banner lead-duplicate-hint" role="alert">{matches.map((match, index) => match.in_bucket && match.lead_id
      ? <p key={index}>Duplicate: this {field} already exists in your bucket{match.lead_name ? ` (${match.lead_name})` : ""}. <Link href={`/leads/${match.lead_id}`} className="text-link">View lead</Link></p>
      : <p key={index}>Duplicate: this {field} already exists and is assigned to <strong>{match.assignee}</strong>.</p>)}</div>;
  };
  const createRequired = ["name", "email", "countryCode", "phone", "country", "qualification", "category", "course", "source", "stage"] as const;
  const labels: Record<string, string> = {
    name: "Name", email: "Email", countryCode: "Country code", phone: "Phone", country: "Country",
    qualification: "Qualification", category: "Category", course: "Course", source: "Source", stage: "Stage",
    assignee: "Assignee", closureFee: "Closure Fee", altPhone: "Alternate phone", followUpAt: "Next follow-up",
  };
  const legacyChoice = (key: LeadPicklistKey, current: string) => {
    const values = picklists[key];
    return current && !values.includes(current) ? [...values, current] : values;
  };
  const renderTextField = (field: "name" | "email" | "phone" | "altPhone") => {
    const required = newLead && createRequired.includes(field as typeof createRequired[number]);
    return <label className="form-field" key={field}><span>{labels[field]}{required && <span className="live-lead-required" aria-hidden="true"> *</span>}</span>
      <input required={required || field === "name" || field === "phone"} type={field === "email" ? "email" : field.toLowerCase().includes("phone") ? "tel" : "text"} value={draft[field]} maxLength={field === "email" ? 254 : field.toLowerCase().includes("phone") ? 30 : 200} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })} />
            {(field === "phone" || field === "email") && renderDuplicates(field)}
          </label>;
  };
  const renderPicklist = (field: "countryCode" | "country" | "qualification" | "category" | "course" | "source", required = false) => {
    const options = legacyChoice(field, draft[field]).map((value) => ({ value, label: value }));
    return <div className="form-field" key={field}><label htmlFor={`lead-${field}`}>{labels[field]}{required && <span className="live-lead-required" aria-hidden="true"> *</span>}</label>
      <SearchableDropdown id={`lead-${field}`} ariaLabel={labels[field]} placeholder={`Choose ${labels[field].toLocaleLowerCase()}`} value={draft[field]} options={options} required={required} openDirection="down" optionsMaxHeight={136} onChange={(value) => setDraft({ ...draft, [field]: value })} />
    </div>;
  };
  const stageOptions = stages.map((stage) => ({ value: stage.id, label: stage.name }));
  if (draft.stageId && !stages.some((stage) => stage.id === draft.stageId)) {
    stageOptions.push({ value: draft.stageId, label: "Inactive stage (unchanged)" });
  }
  const renderStageField = () => <div className="form-field" key="stage"><label htmlFor="lead-stage">Stage</label>
    <SearchableDropdown id="lead-stage" ariaLabel="Stage" placeholder="Choose a stage" value={draft.stageId ?? ""} options={stageOptions} required={newLead} openDirection="down" optionsMaxHeight={136} onChange={(value) => setDraft({ ...draft, stageId: value || null })} />
  </div>;
  const renderAssigneeField = () => <div className="form-field" key="assignee"><label htmlFor="lead-assignee">Assignee</label>
    <SearchableDropdown id="lead-assignee" ariaLabel="Assignee" placeholder="Unassigned" value={draft.assigneeId ?? ""} options={[{ value: "", label: "Unassigned" }, ...profiles.map((profile) => ({ value: profile.id, label: profile.fullName }))]} disabled={!canAssign} openDirection="down" optionsMaxHeight={136} onChange={(value) => setDraft({ ...draft, assigneeId: value || null })} />
  </div>;
  const renderFollowUpField = () => <label className="form-field" key="follow-up"><span>{labels.followUpAt}</span><input type="datetime-local" value={draft.followUpAt ? localInputDate(draft.followUpAt) : ""} onChange={(e) => setDraft({ ...draft, followUpAt: e.target.value ? new Date(e.target.value).toISOString() : null })} /></label>;
  const renderClosureFeeField = () => <label className="form-field" key="closure-fee"><span>{labels.closureFee}</span><input type="number" min="0" step="0.01" value={draft.closureFee} onChange={(e) => setDraft({ ...draft, closureFee: Number(e.target.value) })} /></label>;
  const activeFields = fields.filter((field) => field.active);
  return <form className={`live-lead-form${newLead ? " live-lead-form-new" : ""}`} onSubmit={(e) => { e.preventDefault(); void onSave(draft); }}>
    {renderTextField("name")}
    {renderTextField("email")}
    {renderPicklist("countryCode", newLead)}
    {renderTextField("phone")}
    {renderPicklist("country", newLead)}
    {renderPicklist("qualification", newLead)}
    {renderPicklist("category", newLead)}
    {renderPicklist("course", newLead)}
    {renderPicklist("source", newLead)}
    {renderStageField()}
    {renderAssigneeField()}
    {renderClosureFeeField()}
    {!newLead && <>{renderTextField("altPhone")}{renderFollowUpField()}</>}
    {activeFields.map((field, index) => <div className="form-field" key={field.name}>
      <label htmlFor={`lead-custom-${index}`}>{field.name}</label>
      {field.type === "dropdown"
        ? <SearchableDropdown id={`lead-custom-${index}`} ariaLabel={field.name} placeholder={`Choose ${field.name.toLocaleLowerCase()}`} value={draft.customFields[field.name] ?? ""} options={[...new Set([...field.options, draft.customFields[field.name] ?? ""].filter(Boolean))].map((value) => ({ value, label: value }))} openDirection="down" optionsMaxHeight={136} onChange={(value) => setDraft({ ...draft, customFields: { ...draft.customFields, [field.name]: value } })} />
        : <input id={`lead-custom-${index}`} maxLength={2000} value={draft.customFields[field.name] ?? ""} onChange={(e) => setDraft({ ...draft, customFields: { ...draft.customFields, [field.name]: e.target.value } })} />}
    </div>)}
    <div className="live-lead-form-actions"><button className="button button-primary" type="submit" disabled={busy}>{busy ? "Saving…" : submitLabel}</button></div>
  </form>;
}
function localInputDate(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export async function downloadLiveCsv(path: string, body: unknown, filename: string) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) { const payload = await response.json().catch(() => ({})); throw new Error(payload.error ?? "Export failed."); }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
