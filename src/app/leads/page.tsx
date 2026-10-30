"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, CheckCircle2, Columns3, Download, ListFilter, Plus, Save, Search, Trash2, Users, X } from "lucide-react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { StageBadge } from "@/components/lead-helpers";
import { apiRequest, formatDateTime } from "@/lib/crm-data";
import { criterionError, type SavedLeadFilter } from "@/lib/lead-filters";
import { REPORT_COLUMNS, type ReportColumn } from "@/lib/reports";
import { readDashboardFilter } from "@/lib/dashboard";
import { LiveFilterEditor, downloadLiveCsv, emptyFilter, leadQueryPath, useDebouncedValue, useLiveLeadData } from "@/lib/live-leads-client";
import type { LeadCursor } from "@/lib/server/lead-query";

export default function LeadsPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<SavedLeadFilter>(emptyFilter);
  const [filterName, setFilterName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [stageId, setStageId] = useState("");
  const [page, setPage] = useState(0);
  const [savedColumns, setSavedColumns] = useState<ReportColumn[] | null>(null);
  const [showColumns, setShowColumns] = useState(false);
  const [columnSearch, setColumnSearch] = useState("");
  const [columnPosition, setColumnPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [columnSaving, setColumnSaving] = useState(false);
  const [columnError, setColumnError] = useState("");
  const [dashboardView, setDashboardView] = useState(false);
  const [cursors, setCursors] = useState<(LeadCursor | null)[]>([null]);
  const validation = filter.criteria.map(criterionError).find(Boolean);
  const queryFilter = useDebouncedValue(filter, 250, !validation);
  const path = leadQueryPath(queryFilter, { cursor: cursors[page], dashboard: dashboardView });
  const { data, loading, error, reload, setError } = useLiveLeadData(path);
  useEffect(() => {
    if (!data?.nextCursor || !data.hasMore || loading) return;
    const nextPath = leadQueryPath(queryFilter, { cursor: data.nextCursor, dashboard: dashboardView });
    void apiRequest(nextPath, { maxAgeMs: 30000 }).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not prefetch the next page."));
  }, [data, loading, queryFilter, dashboardView, setError]);
  const [bulkAction, setBulkAction] = useState<"transfer" | "stage" | "delete" | null>(null);
  const bulkDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    function loadDashboardFilter() {
      if (new URLSearchParams(window.location.search).get("create") === "1") {
        router.replace("/leads/new");
        return;
      }
      const value = new URLSearchParams(window.location.search).get("dashboard");
      setDashboardView(value !== null);
      if (value === null) return;
      try { setFilter(readDashboardFilter(value)); setPage(0); setSelected([]); }
      catch (error) { setError(error instanceof Error ? error.message : "Could not load the dashboard filter."); }
    }
    loadDashboardFilter();
    window.addEventListener("popstate", loadDashboardFilter);
    return () => window.removeEventListener("popstate", loadDashboardFilter);
  }, [setError, router]);
  useEffect(() => {
    const dialog = bulkDialogRef.current;
    if (!dialog) return;
    if (bulkAction && !dialog.open) dialog.showModal();
    if (!bulkAction && dialog.open) dialog.close();
  }, [bulkAction]);
  const columnTriggerRef = useRef<HTMLButtonElement>(null);
  const columnPanelRef = useRef<HTMLElement>(null);
  const columnSaveRef = useRef(false);
  const matchingColumns = REPORT_COLUMNS.filter((column) => column.label.toLocaleLowerCase().includes(columnSearch.trim().toLocaleLowerCase()));
  const rows = data && !validation ? data.leads : [];
  const columns = savedColumns ?? (data?.columns?.filter((key): key is ReportColumn => REPORT_COLUMNS.some((c) => c.key === key)) ?? ["name", "phone", "country", "course", "stage", "assignee", "followUp"]) as ReportColumn[];
  const can = (permission: string) => data?.user.permissions.some((p) => p === permission) ?? false;
  const canDelete = can("leads.delete") && ["admin", "super_admin"].includes(data?.user.profile.role ?? "");
  const canTransfer = can("leads.edit") && can("leads.assign") && ["team_lead", "manager", "admin", "super_admin"].includes(data?.user.profile.role ?? "");
  const visible = rows;
  useLayoutEffect(() => {
    if (!showColumns) return;
    function positionPanel() {
      const trigger = columnTriggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(180, window.innerWidth - 16);
      const height = Math.min(190, window.innerHeight - 16);
      const top = Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - height - 8));
      setColumnPosition({ top, left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)), width, maxHeight: window.innerHeight - top - 8 });
    }
    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [showColumns]);
  useEffect(() => {
    if (!showColumns) return;
    columnPanelRef.current?.querySelector("input")?.focus();
    function closeOutside(event: MouseEvent) {
      if (event.target instanceof Node && !columnPanelRef.current?.contains(event.target) && !columnTriggerRef.current?.contains(event.target)) setShowColumns(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setShowColumns(false);
        columnTriggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showColumns]);
  async function saveColumns(key: ReportColumn, checked: boolean) {
    if (columnSaveRef.current) return;
    const next = checked ? [...columns, key] : columns.filter((column) => column !== key);
    if (!next.length) {
      setColumnError("Keep at least one column visible.");
      return;
    }
    columnSaveRef.current = true;
    setColumnSaving(true);
    setColumnError("");
    try {
      await apiRequest("/api/leads/preferences", { body: { action: "columns", columns: next } });
      setSavedColumns(next);
    } catch (error) {
      setColumnError(error instanceof Error ? error.message : "Could not save columns. Please try again.");
    } finally {
      columnSaveRef.current = false;
      setColumnSaving(false);
    }
  }
  async function act(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "Action failed."); } finally { setBusy(false); }
  }
  async function bulk(action: "transfer" | "stage" | "delete") {
    if (loading || queryFilter !== filter) { setError("Wait for the current results before changing leads."); return; }
    const ids = selected.filter((id) => rows.some((r) => r.id === id));
    if (!ids.length) { setError("Select at least one lead."); return; }
    if (action === "transfer" && !assigneeId) { setError("Choose an assignee."); return; }
    if (action === "stage" && !stageId) { setError("Choose a stage."); return; }
    await act(async () => {
      const completed: string[] = [];
      try {
        for (const id of ids) {
          await apiRequest(`/api/leads/${id}`, action === "delete" ? { method: "DELETE" } : { method: "PATCH", body: action === "transfer" ? { assigneeId, ...(stageId ? { stageId } : {}) } : { stageId } });
          completed.push(id);
        }
        setBulkAction(null);
        setNotice(`${completed.length} leads ${action === "delete" ? "deleted from active views" : action === "transfer" ? "transferred" : "updated"}.`);
      } catch (e) { throw new Error(`${completed.length} of ${ids.length} leads updated. ${e instanceof Error ? e.message : "Update failed."}`); }
      finally { setSelected(current => current.filter(id => !completed.includes(id))); await reload(); }
    });
  }
  function openBulk(action: "transfer" | "stage" | "delete") {
    setAssigneeId(""); setStageId(""); setError(""); setBulkAction(action);
  }
  if (!data) return <section className="panel"><h1>Leads</h1>{loading ? <p role="status">Loading leads…</p> : <><p role="alert">{error}</p><button className="button button-secondary" onClick={() => void reload().catch(() => {})}>Retry</button></>}</section>;
  return <div className="leads-workspace">
    <header className="page-heading leads-heading"><div className="leads-heading-copy"><span className="leads-module-icon"><Users size={21} aria-hidden="true" /></span><div><h1>Leads</h1><p>{rows.length} leads on this page{data.hasMore ? " · More results available" : ""}</p></div></div><div className="leads-heading-actions">
      {["admin", "super_admin"].includes(data.user.profile.role) && <button className="button button-secondary" disabled={busy || Boolean(validation)} onClick={() => void act(() => downloadLiveCsv("/api/leads/export", { filter, dashboard: dashboardView, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, "leads.csv"))}><Download size={15} aria-hidden="true" />Export CSV</button>}
      {can("leads.create") && <Link className="button button-primary" href="/leads/new"><Plus size={16} aria-hidden="true" />New lead</Link>}
    </div></header>
    {error && <p className="helper-banner" role="alert">{error} <button className="text-link" onClick={() => void reload().catch(() => {})}>Retry</button></p>}{notice && <p className="helper-banner" role="status">{notice}</p>}
    {validation && <p className="helper-banner" role="alert">{validation}</p>}
    {(loading || queryFilter !== filter) && <span role="status">Updating lead results...</span>}
    {dashboardView && <p className="helper-banner"><Link href="/">Dashboard</Link><span> / {filter.name || "Dashboard leads"} · Role-scoped results</span></p>}
    <div className="leads-layout">
    <aside className="lead-filter-sidebar" aria-label="Lead search and preferences">
    <LiveFilterEditor filter={filter} leads={data.leads} stages={data.stages} profiles={data.profiles} picklists={data.configuration.picklists} onChange={(f) => { setFilter(f); setPage(0); setSelected([]); }} />
    <section className="panel saved-filter-panel" aria-label="Saved filters">
      <div className="panel-heading"><h2>Saved filters</h2><Save size={14} /></div>
      <div className="saved-filter-controls">
      <SearchableDropdown ariaLabel="Saved filters" placeholder="Choose saved filter" value={data.filters.some((f) => f.id === filter.id) ? filter.id : ""} options={[{ value: "", label: "Choose saved filter" }, ...data.filters.map(f => ({ value: f.id, label: f.name }))]} onChange={value => { const saved = data.filters.find((f) => f.id === value); setFilter(saved ? { ...saved.filter_json, id: saved.id, name: saved.name } : emptyFilter()); setPage(0); setSelected([]); }} />
      <input aria-label="Filter name" placeholder="Name this filter" maxLength={120} value={filterName} onChange={(e) => setFilterName(e.target.value)} />
      <button className="button button-secondary button-small" disabled={busy || !filterName.trim() || Boolean(validation)} onClick={() => void act(async () => { await apiRequest("/api/leads/preferences", { body: { action: "save", filter: { ...filter, name: filterName.trim() } } }); setFilterName(""); await reload(); setNotice("Filter saved to your account."); })}><Save size={13} />Save filter</button>
      {data.filters.some((f) => f.id === filter.id) && <button className="button button-quiet button-small" disabled={busy} onClick={() => void act(async () => { await apiRequest("/api/leads/preferences", { body: { action: "delete", id: filter.id } }); setFilter(emptyFilter()); await reload(); })}><Trash2 size={13} />Delete filter</button>}
      </div>
    </section>
    </aside>
    <div className="lead-results">
    <section className="panel leads-panel" aria-label="Lead results" aria-busy={loading || queryFilter !== filter}>
    <div className="leads-view-bar"><div className="leads-current-view"><ListFilter size={16} aria-hidden="true" /><h2>{dashboardView ? filter.name || filter.quickView : filter.quickView}</h2><span className="leads-view-count">{rows.length}</span></div><span className="result-count">{rows.length} leads</span></div>
    {selected.length > 0 && <section className="lead-bulk-actions"><strong><CheckCircle2 size={16} aria-hidden="true" />{selected.length} selected</strong>
      <div className="lead-bulk-buttons">
        {can("leads.edit") && <button className="button lead-bulk-status" aria-label="Update status" disabled={busy} onClick={() => openBulk("stage")}><CheckCircle2 size={15} aria-hidden="true" />Update status</button>}
        {canTransfer && <button className="button lead-bulk-transfer" aria-label="Transfer" disabled={busy} onClick={() => openBulk("transfer")}><ArrowRightLeft size={15} aria-hidden="true" />Transfer</button>}
        {canDelete && <button className="button lead-bulk-delete" aria-label="Delete" disabled={busy} onClick={() => openBulk("delete")}><Trash2 size={15} aria-hidden="true" />Delete</button>}
      </div>
    </section>}
    <div className="table-toolbar"><label className="toolbar-search"><Search size={15} /><input aria-label="Search results" placeholder="Search leads" value={filter.query} onChange={event => { setFilter({ ...filter, query: event.target.value }); setPage(0); setSelected([]); }} /></label>
      <div className="toolbar-actions"><button ref={columnTriggerRef} className="button button-secondary button-small" aria-expanded={showColumns} aria-controls={showColumns ? "lead-column-options" : undefined} onClick={() => { setColumnSearch(""); setShowColumns(!showColumns); }}><Columns3 size={14} />Columns</button></div>
    </div>
    {showColumns && typeof document !== "undefined" && createPortal(<section ref={columnPanelRef} id="lead-column-options" className="lead-column-options" aria-label="Visible columns" style={{ ...columnPosition, visibility: columnPosition ? "visible" : "hidden" }}>
      <label className="lead-column-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search columns" placeholder="Search columns..." value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} /></label>
      <div className="lead-column-list" role="group" aria-label="Choose visible columns" aria-busy={columnSaving}>
        {matchingColumns.map((c) => <label className="lead-column-option" key={c.key}><input type="checkbox" checked={columns.includes(c.key)} disabled={columnSaving || (columns.length === 1 && columns.includes(c.key))} onChange={(event) => void saveColumns(c.key, event.target.checked)} /><span>{c.label}</span></label>)}
        {!matchingColumns.length && <p className="lead-column-empty" role="status">No columns match your search.</p>}
      </div>
      {columnSaving && <span className="visually-hidden" role="status">Saving columns...</span>}
      {columnError && <p className="lead-column-error" role="alert">{columnError}</p>}
    </section>, document.body)}
    {filter.criteria.length > 0 && <div className="active-filters"><button className="filter-chip active-filter-clear" aria-label="Clear filter conditions" onClick={() => { setFilter({ ...filter, criteria: [] }); setPage(0); setSelected([]); }}>{filter.criteria.length} conditions <X size={12} /></button></div>}
    <div className="table-wrap"><table className="data-table leads-table" aria-label="Leads"><thead><tr><th><input type="checkbox" aria-label="Select page" checked={visible.length > 0 && visible.every((lead) => selected.includes(lead.id))} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...visible.map((r) => r.id)])] : selected.filter((id) => !visible.some((r) => r.id === id)))} /></th>{columns.map((key) => <th key={key}>{REPORT_COLUMNS.find((c) => c.key === key)?.label}</th>)}</tr></thead><tbody>
      {visible.map((lead) => <tr key={lead.id}><td><input type="checkbox" aria-label={`Select ${lead.name}`} checked={selected.includes(lead.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, lead.id] : selected.filter((id) => id !== lead.id))} /></td>{columns.map((key, index) => {
        const value = ["createdAt", "modifiedAt", "lastVisitAt"].includes(key) ? formatDateTime(String(lead[key] ?? "")) || "—" : lead[key] || "—";
        return <td key={key}>{key === "name" ? <Link className="lead-cell" href={`/leads/${lead.id}`}>{lead.name}</Link> : key === "stage" ? <StageBadge stage={lead.stage || "No stage"} /> : index === 0 ? <Link href={`/leads/${lead.id}`}>{value}</Link> : value}</td>;
      })}</tr>)}
      {!rows.length && <tr><td className="leads-empty-cell" colSpan={columns.length + 1}><div className="leads-empty-state"><span className="leads-empty-icon"><Users size={26} aria-hidden="true" /></span><strong>No leads match.</strong><p>Create a lead or change filters.</p></div></td></tr>}
    </tbody></table></div><div className="table-footer"><span>{rows.length ? page * 50 + 1 : 0}–{page * 50 + rows.length} leads{data.hasMore ? " · More available" : ""}</span><div className="heading-actions"><button className="button button-secondary button-small" disabled={page === 0 || loading || queryFilter !== filter} onClick={() => { setPage(page - 1); setSelected([]); }}>Previous</button><span>Page {page + 1}</span><button className="button button-secondary button-small" disabled={!data.hasMore || loading || queryFilter !== filter || Boolean(validation)} onClick={() => { setCursors([...cursors.slice(0, page + 1), data.nextCursor]); setPage(page + 1); setSelected([]); }}>Next</button></div></div></section>
    </div>
    </div>
    <dialog ref={bulkDialogRef} className="panel modal bulk-action-modal lead-bulk-dialog" aria-labelledby="lead-bulk-title" onCancel={event => { if (busy) event.preventDefault(); else setBulkAction(null); }}>
      {bulkAction && <form onSubmit={event => { event.preventDefault(); void bulk(bulkAction); }}>
        <div className="panel-heading"><div className="lead-bulk-dialog-heading"><span className={`lead-bulk-dialog-icon${bulkAction === "delete" ? " is-danger" : ""}`}>{bulkAction === "transfer" ? <ArrowRightLeft size={21} /> : bulkAction === "stage" ? <CheckCircle2 size={21} /> : <Trash2 size={21} />}</span><div><h2 id="lead-bulk-title">{bulkAction === "transfer" ? "Transfer leads" : bulkAction === "stage" ? "Update status" : "Delete leads"}</h2><p>{selected.length} lead{selected.length === 1 ? "" : "s"} selected for this action</p></div></div><button type="button" className="button button-quiet" aria-label="Close action" disabled={busy} onClick={() => setBulkAction(null)}><X size={18} /></button></div>
        <div className="modal-body">
          {error && <p role="alert" className="lead-column-error">{error}</p>}
          {bulkAction === "delete" ? <p>Delete these leads from active views? They will be archived, not permanently erased. Their history will be retained.</p> : <>
            {bulkAction === "transfer" && <div className="form-field"><label htmlFor="bulk-assignee">Assign to <span className="lead-bulk-required">*</span></label><SearchableDropdown id="bulk-assignee" ariaLabel="Transfer assignee" placeholder="Search and choose an assignee" required disabled={busy} value={assigneeId} onChange={setAssigneeId} options={data.profiles.filter(profile => profile.status === "active").map(profile => ({ value: profile.id, label: profile.fullName }))} openDirection="auto" optionsMaxHeight={176} /></div>}
            <div className="form-field"><label htmlFor="bulk-stage">{bulkAction === "transfer" ? "Updated stage" : "Stage"}{bulkAction === "stage" && <span className="lead-bulk-required"> *</span>}</label><SearchableDropdown id="bulk-stage" ariaLabel="Bulk stage" placeholder={bulkAction === "transfer" ? "Keep current stage" : "Search and choose a stage"} required={bulkAction === "stage"} disabled={busy} value={stageId} onChange={setStageId} options={[...(bulkAction === "transfer" ? [{ value: "", label: "Keep current stage" }] : []), ...data.stages.map(stage => ({ value: stage.id, label: stage.name }))]} openDirection="auto" optionsMaxHeight={176} /></div>
            {bulkAction === "transfer" && <p className="lead-bulk-help">Keep current stage preserves each lead&apos;s existing stage. Transferring may remove these leads from your reporting scope.</p>}
          </>}
        </div>
        <div className="modal-footer"><button type="button" className="button button-secondary" disabled={busy} onClick={() => setBulkAction(null)}>Cancel</button><button className={`button button-primary${bulkAction === "delete" ? " lead-bulk-confirm-delete" : ""}`} disabled={busy || !selected.length || (bulkAction === "transfer" && !assigneeId) || (bulkAction === "stage" && !stageId)}>{busy ? "Updating..." : bulkAction === "transfer" ? "Confirm transfer" : bulkAction === "stage" ? "Update status" : "Confirm delete"}</button></div>
      </form>}
    </dialog>
  </div>;
}
