"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { CalendarDays, GitBranch, List, Phone, Search, UserRound, X } from "lucide-react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { initials } from "@/components/lead-helpers";
import { apiRequest } from "@/lib/crm-data";
import { emptyFilter, leadQueryPath, useDebouncedValue, useLiveLeadData, type LiveLeadData } from "@/lib/live-leads-client";
import type { LeadCursor, LeadPage } from "@/lib/server/lead-query";

export default function PipelinePage() {
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [sort, setSort] = useState("newest");
  const [draggedLead, setDraggedLead] = useState("");
  const [dropStage, setDropStage] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const search = useDebouncedValue(query);
  const filter = { ...emptyFilter(), query: search, quickView: mine ? "My Leads" : "All accessible leads" };
  const path = leadQueryPath(filter, { view: "pipeline", owner, stage: stageFilter, sort });
  const { data, error, loading, reload, setError } = useLiveLeadData<LiveLeadData & { stagePages: (LeadPage & { stage: string })[] }>(path);
  const [columnPages, setColumnPages] = useState<Record<string, { path: string; source: typeof data; index: number; cursors: (LeadCursor | null)[]; page: LeadPage }>>({});
  const currentColumn = (stage: string) => {
    const saved = columnPages[stage];
    return saved?.path === path && saved.source === data ? saved : null;
  };
  const displayed = data?.stagePages ? data.stagePages.flatMap(group => currentColumn(group.stage)?.page.leads ?? group.leads) : data?.leads ?? [];
  const movePending = useRef(false);
  async function turnColumn(stage: string, direction: -1 | 1) {
    if (movePending.current || loading || query !== search) return;
    movePending.current = true;
    setBusy(true); setError("");
    try {
      const saved = currentColumn(stage);
      const index = saved?.index ?? 0;
      const previous = saved?.cursors ?? [null];
      const nextCursor = saved?.page.nextCursor ?? data?.stagePages.find(group => group.stage === stage)?.nextCursor ?? null;
      const cursors = direction === 1 ? [...previous.slice(0, index + 1), nextCursor] : previous;
      const next = index + direction;
      const page = await apiRequest<LeadPage>(`${leadQueryPath(filter, { view: "pipeline", owner, stage, sort, cursor: cursors[next] })}&metadata=0`, { maxAgeMs: 30000 });
      setColumnPages(current => ({ ...current, [stage]: { path, source: data, index: next, cursors, page } }));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load this stage."); }
    finally { movePending.current = false; setBusy(false); }
  }
  const canEdit = data?.user.permissions.includes("leads.edit");
  async function move(id: string, stageId: string | null) {
    const lead = displayed.find((item) => item.id === id);
    if (!canEdit || loading || query !== search || movePending.current || !lead || (lead.stageId ?? null) === stageId) return;
    if (stageId && !data?.stages.some((stage) => stage.id === stageId)) {
      setError("This stage is no longer available. Reload the pipeline and try again.");
      return;
    }
    movePending.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      await apiRequest(`/api/leads/${id}`, { method: "PATCH", body: { stageId } });
      await reload();
      setNotice(`${lead.name} moved to ${data?.stages.find((stage) => stage.id === stageId)?.name ?? "No active stage"}.`);
    }
    catch (e) { setError(e instanceof Error ? e.message : "Could not change stage."); }
    finally { movePending.current = false; setBusy(false); setDraggedLead(""); setDropStage(null); }
  }
  if (!data) return <section className="panel"><h1>Pipeline</h1>{loading ? <p role="status">Loading live pipeline…</p> : <><p role="alert">{error}</p><button className="button button-secondary" onClick={() => void reload().catch(() => {})}>Retry</button></>}</section>;
  const hasStage = (stageId: string | undefined) => data.stages.some((stage) => stage.id === stageId);
  const rows = displayed;
  const columns = [...data.stages, ...(!stageFilter || stageFilter === "__none" ? [{ id: "", name: "No active stage", color: null }] : [])]
    .filter((stage) => stage.id ? !stageFilter || stageFilter === stage.id : rows.some((lead) => !hasStage(lead.stageId)) || data.stagePages?.some(group => group.stage === "__none" && group.hasMore));
  const filtersActive = Boolean(query || mine || owner || stageFilter);
  return <div className="pipeline-workspace">
    <header className="page-heading pipeline-heading"><div className="pipeline-heading-copy"><span className="pipeline-module-icon"><GitBranch size={22} aria-hidden="true" /></span><div><h1>Pipeline</h1><p>{rows.length} displayed leads · Up to 25 per stage</p></div></div><div className="heading-actions">{data.user.permissions.includes("leads.view") && <Link className="button button-secondary" href="/leads"><List size={15} aria-hidden="true" />Manage leads</Link>}</div></header>
    {error && <p className="helper-banner" role="alert">{error}</p>}
    {notice && <p className="helper-banner" role="status">{notice}</p>}
    <section className="panel pipeline-panel" aria-label="Admissions pipeline">
    <div className="pipeline-view-bar"><div><GitBranch size={16} aria-hidden="true" /><h2>Admissions pipeline</h2><span className="pipeline-record-count">{rows.length} leads</span></div><span className="pipeline-group-label">Grouped by stage</span></div>
    <div className="pipeline-controls">
      <label className="pipeline-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search pipeline" placeholder="Search pipeline" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="pipeline-filter"><SearchableDropdown ariaLabel="Filter by owner" placeholder="All owners" value={owner} onChange={setOwner} options={[{ value: "", label: "All owners" }, { value: "__unassigned", label: "Unassigned" }, ...data.profiles.map((profile) => ({ value: profile.id, label: profile.fullName }))]} /></div>
      <div className="pipeline-filter"><SearchableDropdown ariaLabel="Filter by stage" placeholder="All stages" value={stageFilter} onChange={setStageFilter} options={[{ value: "", label: "All stages" }, ...data.stages.map((stage) => ({ value: stage.id, label: stage.name })), { value: "__none", label: "No active stage" }]} /></div>
      <div className="pipeline-sort"><SearchableDropdown ariaLabel="Sort pipeline" placeholder="Sort leads" value={sort} onChange={setSort} options={[{ value: "newest", label: "Newest first" }, { value: "followUp", label: "Next follow-up" }, { value: "name", label: "Lead name" }]} /></div>
      <label className="pipeline-mine"><input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} />My leads only</label>
      {filtersActive && <button className="button button-quiet button-small" onClick={() => { setQuery(""); setMine(false); setOwner(""); setStageFilter(""); }}><X size={13} aria-hidden="true" />Clear filters</button>}
    </div>
    <details className="pipeline-guide"><summary>Admissions journey</summary><p>{canEdit ? "Drag a card to a stage or use its stage menu. Changes are saved immediately." : "Follow each lead through your configured stages."}</p><div className="pipeline-journey-scroll"><ol className="pipeline-journey-steps">{data.stages.map((stage, index) => <li className="pipeline-journey-step" key={stage.id}><span className="pipeline-journey-node">{index + 1}</span>{stage.name}</li>)}</ol></div></details>
    {!rows.length && filtersActive && <p className="pipeline-filter-empty" role="status">No leads match your filters. Clear filters to see all accessible leads.</p>}
    <div className="board pipeline-board" role="region" aria-label="Pipeline stage board" tabIndex={0} aria-busy={busy || loading}>{columns.map((stage) => {
      const leads = rows.filter((lead) => stage.id ? lead.stageId === stage.id : !data.stages.some((s) => s.id === lead.stageId));
      const key = stage.id || "__none";
      const saved = currentColumn(key);
      const pageIndex = saved?.index ?? 0;
      const hasMore = saved?.page.hasMore ?? data.stagePages?.find(group => group.stage === key)?.hasMore ?? false;
      return <section className={`board-column${dropStage === stage.id ? " pipeline-drop-target" : ""}`} aria-label={`${stage.name}: ${leads.length} leads`} key={stage.id} onDragOver={(event) => {
        if (canEdit && !busy && draggedLead) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropStage(stage.id); }
      }} onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropStage(null); }} onDrop={(event) => {
        event.preventDefault();
        const id = event.dataTransfer.getData("text/plain");
        if (draggedLead === id && rows.some((lead) => lead.id === id)) void move(id, stage.id || null);
        setDraggedLead(""); setDropStage(null);
      }}><div className="board-title" style={{ borderTopColor: stage.color || "#9aaac0" }}><h3>{stage.name}</h3><span>{leads.length}{hasMore ? "+" : ""}</span></div>
        <div className="pipeline-column-cards">{leads.map((lead) => <article className={`board-card${draggedLead === lead.id ? " pipeline-card-dragging" : ""}`} aria-label={lead.name} draggable={Boolean(canEdit && !busy)} onDragStart={(event) => { event.dataTransfer.setData("text/plain", lead.id); event.dataTransfer.effectAllowed = "move"; setDraggedLead(lead.id); }} onDragEnd={() => { setDraggedLead(""); setDropStage(null); }} key={lead.id}><Link className="lead-cell" href={`/leads/${lead.id}`}><span className="avatar">{initials(lead.name)}</span><strong>{lead.name}</strong></Link><p className="pipeline-card-course">{lead.course || "No course"} · {lead.country || "No country"}</p><p className="pipeline-card-phone"><Phone size={12} aria-hidden="true" />{lead.phone}</p>
          <div className="board-card-progress" aria-label={`Current stage: ${stage.name}`}>{data.stages.map((step, index) => <span key={step.id} className={`board-card-progress-step${step.id === lead.stageId ? " current" : index < data.stages.findIndex(s => s.id === lead.stageId) ? " complete" : ""}`} />)}</div>
          <div className="board-card-foot"><span><CalendarDays size={13} aria-hidden="true" />Follow-up: {lead.followUp || "Not scheduled"}</span><span><UserRound size={13} aria-hidden="true" />{lead.assignee || "Unassigned"}</span></div>
          {canEdit && <div className="pipeline-stage-control"><SearchableDropdown ariaLabel={`Stage for ${lead.name}`} placeholder="Move to stage" disabled={busy} value={hasStage(lead.stageId) ? lead.stageId ?? "" : ""} onChange={value => void move(lead.id, value || null)} options={data.stages.map(s => ({ value: s.id, label: s.name }))} /></div>}
        </article>)}
        {!leads.length && <div className="pipeline-stage-empty"><span>{leads.length}</span><p>No leads in this stage</p>{canEdit && <small>Drag a lead here to move it</small>}</div>}</div>
        {(pageIndex > 0 || hasMore) && <div className="heading-actions"><button className="button button-secondary button-small" disabled={!pageIndex || busy || loading} onClick={() => void turnColumn(key, -1)}>Previous</button><button className="button button-secondary button-small" disabled={!hasMore || busy || loading} onClick={() => void turnColumn(key, 1)}>Next 25</button></div>}
      </section>;
    })}</div>
    {!columns.length && <p className="pipeline-filter-empty">No stages available. Configure admissions stages in CRM settings or clear the stage filter.</p>}
    <footer className="pipeline-footer"><span>{rows.length} displayed leads · Page each stage to see more</span><span>{busy ? "Updating pipeline..." : canEdit ? "Stage changes save automatically" : "Read-only pipeline"}</span></footer>
    </section>
  </div>;
}
