"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowRightLeft, CheckCircle2, Columns3, Download, ListFilter, Plus, Save, Search, Trash2, Users, X } from "lucide-react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { StageBadge } from "@/components/lead-helpers";
import { LeadNavigationPreparation } from "@/components/lead-navigation-preparation";
import { useLeadFilterState, useLeadNavigation } from "@/components/lead-filter-state";
import { apiRequest, formatDateTime, subscribeApiWrites } from "@/lib/crm-data";
import { criterionError, criterionIsActive, type SavedLeadFilter } from "@/lib/lead-filters";
import { leadColumns, leadColumnValue, type LeadColumn } from "@/lib/reports";
import { LiveFilterEditor, downloadLiveCsv, emptyFilter, getCachedLeadListData, leadQueryPath, loadAllLeadRows, loadLeadListData, useDebouncedValue, useLiveLeadData, type LiveLeadSnapshot } from "@/lib/live-leads-client";
import type { LeadCursor, LeadPage } from "@/lib/server/lead-query";
import type { Lead } from "@/lib/types";

const columnWidths: Partial<Record<LeadColumn, number>> = {
  name: 220, phone: 180, altPhone: 180, email: 260, course: 240, stage: 190,
  createdAt: 190, modifiedAt: 190, lastVisitAt: 190, billingAddress: 240, id: 280,
};
const columnWidth = (key: LeadColumn) => columnWidths[key] ?? 170;
const serverDateTimeFormatter = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function LeadViewBar({ filter, dashboard, title, children }: {
  filter: SavedLeadFilter; dashboard: boolean; title: string; children: ReactNode;
}) {
  const { data, loading, error, reload } = useLiveLeadData<LeadPage>(leadQueryPath(filter, { dashboard, count: true }));
  useEffect(() => subscribeApiWrites(() => { void reload().catch(() => {}); }, "completed"), [reload]);
  const total = data?.total?.toLocaleString();
  return <>
    <div className="leads-view-bar"><div className="leads-current-view"><ListFilter size={16} aria-hidden="true" /><h2>{title}</h2><span className="leads-view-count" aria-label="Total matching leads" aria-busy={loading}>{total ?? (error ? "Unavailable" : "Counting...")}</span></div><div className="leads-view-actions"><span className="result-count">{total === undefined ? (error ? "Count unavailable" : "Counting matching leads...") : `${total} leads`}</span>{children}</div></div>
    {error && <p className="helper-banner" role="alert">Could not count matching leads: {error} <button className="text-link" onClick={() => void reload().catch(() => {})}>Retry count</button></p>}
  </>;
}

export default function LeadsWorkspace({ initialFilter, dashboard = false, initialData }: {
  initialFilter?: SavedLeadFilter; dashboard?: boolean; initialData?: LiveLeadSnapshot;
} = {}) {
  const retainedFilters = useLeadFilterState();
  const navigation = useLeadNavigation();
  const filterScope = JSON.stringify([dashboard, initialFilter ?? emptyFilter()]);
  const [filter, setFilter] = useState<SavedLeadFilter>(() => retainedFilters?.get(filterScope) ?? initialFilter ?? emptyFilter());
  const [filterName, setFilterName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [stageId, setStageId] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number | "all">(50);
  const [allRows, setAllRows] = useState<Lead[]>([]);
  const [allRowsKey, setAllRowsKey] = useState("");
  const [allRowsLoading, setAllRowsLoading] = useState(false);
  const [savedColumns, setSavedColumns] = useState<LeadColumn[] | null>(null);
  const [showColumns, setShowColumns] = useState(false);
  const [columnSearch, setColumnSearch] = useState("");
  const [columnPosition, setColumnPosition] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [columnSaving, setColumnSaving] = useState(false);
  const [columnError, setColumnError] = useState("");
  const dashboardView = dashboard;
  const [cursors, setCursors] = useState<(LeadCursor | null)[]>([null]);
  const activeCriteria = filter.criteria.filter(criterionIsActive);
  const validation = activeCriteria.map(criterionError).find(Boolean);
  const delayedFilterKey = JSON.stringify({ ...filter, criteria: activeCriteria, quickView: undefined });
  const settledFilterKey = useDebouncedValue(delayedFilterKey, 120, !validation);
  const queryUpdating = settledFilterKey !== delayedFilterKey;
  const queryFilter = useMemo(() => ({
    ...JSON.parse(settledFilterKey) as SavedLeadFilter, quickView: filter.quickView,
  }), [settledFilterKey, filter.quickView]);
  const settledQueryFilterKey = JSON.stringify(queryFilter);
  const path = leadQueryPath(queryFilter, { cursor: cursors[page], dashboard, pageSize: 100 });
  const initialPath = leadQueryPath(initialFilter ?? emptyFilter(), { dashboard, pageSize: 100 });
  const { data, loading, error, reload, setError } = useLiveLeadData(
    path, loadLeadListData, getCachedLeadListData, path === initialPath ? initialData : undefined,
  );
  const pageRows = pageSize === "all" ? data?.leads ?? [] : data?.leads.slice(0, pageSize) ?? [];
  const hasExtraRows = pageSize !== "all" && (data?.leads.length ?? 0) > pageSize;
  const lastPageRow = pageRows[pageRows.length - 1];
  const nextCursor: LeadCursor | null = hasExtraRows
    ? lastPageRow?.createdAt ? { id: lastPageRow.id, createdAt: lastPageRow.createdAt } : null
    : data?.nextCursor ?? null;
  const hasMore = hasExtraRows || Boolean(data?.hasMore);
  useEffect(() => {
    if (hasExtraRows && !lastPageRow?.createdAt) setError("Cannot continue: the last lead has no creation date.");
  }, [hasExtraRows, lastPageRow?.createdAt, setError]);
  useEffect(() => {
    if (pageSize !== "all" || validation || queryUpdating || loading || !data) {
      setAllRowsLoading(false);
      return;
    }
    let active = true;
    setAllRowsLoading(true);
    void loadAllLeadRows(queryFilter, dashboard, {
      initialPage: data,
      shouldContinue: () => active,
    })
      .then(rows => { if (active) { setAllRows([...rows]); setAllRowsKey(settledQueryFilterKey); } })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Could not load all matching leads."); })
      .finally(() => { if (active) setAllRowsLoading(false); });
    return () => { active = false; };
  }, [pageSize, settledQueryFilterKey, dashboard, validation, queryUpdating, queryFilter, setError, loading, data]);
  useEffect(() => {
    if (pageSize === "all" || !nextCursor || !hasMore || loading || queryUpdating || validation) return;
    const nextPath = leadQueryPath(queryFilter, { cursor: nextCursor, dashboard, pageSize: 100 });
    void loadLeadListData(nextPath, { maxAgeMs: 30000 }).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not prefetch the next page."));
  }, [nextCursor?.id, nextCursor?.createdAt, hasMore, loading, queryFilter, queryUpdating, dashboard, pageSize, validation, setError]);
  const [bulkAction, setBulkAction] = useState<"transfer" | "stage" | "delete" | null>(null);
  const bulkDialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = bulkDialogRef.current;
    if (!dialog) return;
    if (bulkAction && !dialog.open) dialog.showModal();
    if (!bulkAction && dialog.open) dialog.close();
  }, [bulkAction]);
  const columnTriggerRef = useRef<HTMLButtonElement>(null);
  const columnPanelRef = useRef<HTMLElement>(null);
  const columnSaveRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { setHydrated(true); }, []);
  const availableColumns = leadColumns(data?.configuration.fields);
  const matchingColumns = availableColumns.filter((column) => column.label.toLocaleLowerCase().includes(columnSearch.trim().toLocaleLowerCase()));
  const staleResults = Boolean(validation || queryUpdating || loading);
  const displayedFilter = useRef(queryFilter);
  if (!staleResults && data) displayedFilter.current = queryFilter;
  const rows = data
    ? pageSize === "all" && !staleResults && allRowsKey === settledQueryFilterKey ? allRows : pageRows
    : [];
  const resultsLoading = loading || queryUpdating || (pageSize === "all" && allRowsLoading);
  function rememberNavigation() {
    if (navigation) navigation.current = { filter: displayedFilter.current, dashboard };
  }
  function changeFilter(next: SavedLeadFilter) {
    retainedFilters?.set(filterScope, next);
    setFilter(next);
    setPage(0);
    setCursors([null]);
    setSelected([]);
    setAllRowsKey("");
  }
  function changePageSize(value: string) {
    setPageSize(value === "all" ? "all" : Number(value));
    setPage(0);
    setCursors([null]);
    setSelected([]);
    setAllRowsKey("");
  }
  const selectedColumns = savedColumns ?? data?.columns;
  const validColumns = selectedColumns?.filter((key): key is LeadColumn => availableColumns.some(column => column.key === key));
  const columns: LeadColumn[] = validColumns?.length ? validColumns : ["name", "phone", "country", "course", "stage", "assignee", "followUp"];
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
  async function saveColumns(key: LeadColumn, checked: boolean) {
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
    if (staleResults) { setError("Wait for the current results before changing leads."); return; }
    const ids = selected.filter((id) => rows.some((r) => r.id === id));
    if (!ids.length) { setError("Select at least one lead."); return; }
    if (action === "transfer" && !assigneeId) { setError("Choose an assignee."); return; }
    if (action === "stage" && !stageId) { setError("Choose a stage."); return; }
    await act(async () => {
      const completed: string[] = [];
      try {
        if (action === "transfer" || action === "stage") {
          for (let offset = 0; offset < ids.length; offset += 100) {
            const batch = ids.slice(offset, offset + 100);
            const result = await apiRequest<{ updatedIds: string[] }>("/api/leads/bulk", {
              method: "POST",
              body: action === "transfer"
                ? { ids: batch, assigneeId, ...(stageId ? { stageId } : {}) }
                : { action: "stage", ids: batch, stageId },
            });
            completed.push(...result.updatedIds);
            if (result.updatedIds.length !== batch.length) {
              throw new Error("Some selected leads were unavailable or could not be updated.");
            }
          }
        } else {
          const remaining = [...ids];
          let failure: Error | undefined;
          async function worker() {
            while (remaining.length && !failure) {
              const id = remaining.shift()!;
              try {
                await apiRequest(`/api/leads/${id}`, { method: "DELETE" });
                completed.push(id);
              } catch (error) {
                failure ??= error instanceof Error ? error : new Error("Update failed.");
              }
            }
          }
          await Promise.all(Array.from({ length: Math.min(3, ids.length) }, () => worker()));
          if (failure) throw failure;
        }
        setBulkAction(null);
        setNotice(`${completed.length} leads ${action === "delete" ? "deleted from active views" : action === "transfer" ? "transferred" : "updated"}.`);
      } catch (e) { throw new Error(`${completed.length} of ${ids.length} leads updated. ${e instanceof Error ? e.message : "Update failed."}`); }
      finally {
        setSelected(current => current.filter(id => !completed.includes(id)));
        await reload();
      }
    });
  }
  function openBulk(action: "transfer" | "stage" | "delete") {
    setAssigneeId(""); setStageId(""); setError(""); setBulkAction(action);
  }
  if (!data) return <section className="panel"><h1>Leads</h1>{loading ? <p role="status">Loading leads…</p> : <><p role="alert">{error}</p><button className="button button-secondary" onClick={() => void reload().catch(() => {})}>Retry</button></>}</section>;
  return <div className="leads-workspace">
    <header className="page-heading leads-heading"><div className="leads-heading-copy"><span className="leads-module-icon"><Users size={21} aria-hidden="true" /></span><div><h1>Leads</h1></div></div><div className="leads-heading-actions">
      {["admin", "super_admin"].includes(data.user.profile.role) && <button className="button button-secondary" disabled={busy || Boolean(validation)} onClick={() => void act(() => downloadLiveCsv("/api/leads/export", { filter, dashboard: dashboardView, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, "leads.csv"))}><Download size={15} aria-hidden="true" />Export CSV</button>}
      {can("leads.create") && <Link className="button button-primary" href="/leads/new"><Plus size={16} aria-hidden="true" />New lead</Link>}
    </div></header>
    {error && <p className="helper-banner" role="alert">{error} <button className="text-link" onClick={() => void reload().catch(() => {})}>Retry</button></p>}{notice && <p className="helper-banner" role="status">{notice}</p>}
    <LeadNavigationPreparation leads={rows} enabled={!staleResults} />
    {resultsLoading && <span className="visually-hidden" role="status">{pageSize === "all" ? "Loading all matching leads..." : "Updating lead results..."}</span>}
    {dashboardView && <p className="helper-banner"><Link href="/">Dashboard</Link><span> / {filter.name || "Dashboard leads"} · Role-scoped results</span></p>}
    <div className="leads-layout">
    <aside className="lead-filter-sidebar" aria-label="Lead search and preferences">
    <LiveFilterEditor filter={filter} leads={data.leads} stages={data.stages} profiles={data.profiles} picklists={data.configuration.picklists} onChange={changeFilter} />
    <section className="panel saved-filter-panel" aria-label="Saved filters">
      <div className="panel-heading"><h2>Saved filters</h2><Save size={14} /></div>
      <div className="saved-filter-controls">
      <SearchableDropdown ariaLabel="Saved filters" placeholder="Choose saved filter" value={data.filters.some((f) => f.id === filter.id) ? filter.id : ""} options={[{ value: "", label: "Choose saved filter" }, ...data.filters.map(f => ({ value: f.id, label: f.name }))]} onChange={value => { const saved = data.filters.find((f) => f.id === value); changeFilter(saved ? { ...saved.filter_json, id: saved.id, name: saved.name } : emptyFilter()); }} />
      <input aria-label="Filter name" placeholder="Name this filter" maxLength={120} value={filterName} onChange={(e) => setFilterName(e.target.value)} />
      <button className="button button-secondary button-small" disabled={busy || !filterName.trim() || Boolean(validation)} onClick={() => void act(async () => { await apiRequest("/api/leads/preferences", { body: { action: "save", filter: { ...filter, criteria: activeCriteria, name: filterName.trim() } } }); setFilterName(""); await reload(); setNotice("Filter saved to your account."); })}><Save size={13} />Save filter</button>
      {data.filters.some((f) => f.id === filter.id) && <button className="button button-quiet button-small" disabled={busy} onClick={() => void act(async () => { await apiRequest("/api/leads/preferences", { body: { action: "delete", id: filter.id } }); changeFilter(emptyFilter()); await reload(); })}><Trash2 size={13} />Delete filter</button>}
      </div>
    </section>
    </aside>
    <div className="lead-results">
    <section className="panel leads-panel" aria-label="Lead results" aria-busy={resultsLoading}>
    <LeadViewBar key={leadQueryPath(queryFilter, { dashboard, count: true })} filter={queryFilter} dashboard={dashboard} title={dashboardView ? filter.name || filter.quickView : filter.quickView}><button ref={columnTriggerRef} className="button button-secondary button-small" aria-expanded={showColumns} aria-controls={showColumns ? "lead-column-options" : undefined} onClick={() => { setColumnSearch(""); setShowColumns(!showColumns); }}><Columns3 size={14} />Columns</button></LeadViewBar>
    {pageSize === "all" && allRowsLoading && <p className="helper-banner" role="status">Loading all matching leads. The full list will appear when loading finishes.</p>}
    {staleResults && <p className="helper-banner" role="status">Previous results shown. {validation ? "Correct the filter to see matching leads." : error ? "Results could not be updated." : "Results will update when ready."}</p>}
    {selected.length > 0 && <section className="lead-bulk-actions"><strong><CheckCircle2 size={16} aria-hidden="true" />{selected.length} selected</strong>
      <div className="lead-bulk-buttons">
        {can("leads.edit") && <button className="button lead-bulk-status" aria-label="Update status" disabled={busy || staleResults} onClick={() => openBulk("stage")}><CheckCircle2 size={15} aria-hidden="true" />Update status</button>}
        {canTransfer && <button className="button lead-bulk-transfer" aria-label="Transfer" disabled={busy || staleResults} onClick={() => openBulk("transfer")}><ArrowRightLeft size={15} aria-hidden="true" />Transfer</button>}
        {canDelete && <button className="button lead-bulk-delete" aria-label="Delete" disabled={busy || staleResults} onClick={() => openBulk("delete")}><Trash2 size={15} aria-hidden="true" />Delete</button>}
      </div>
    </section>}
    {showColumns && typeof document !== "undefined" && createPortal(<section ref={columnPanelRef} id="lead-column-options" className="lead-column-options" aria-label="Visible columns" style={{ ...columnPosition, visibility: columnPosition ? "visible" : "hidden" }}>
      <label className="lead-column-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="Search columns" placeholder="Search columns..." value={columnSearch} onChange={(event) => setColumnSearch(event.target.value)} /></label>
      <div className="lead-column-list" role="group" aria-label="Choose visible columns" aria-busy={columnSaving}>
        {matchingColumns.map((c) => <label className="lead-column-option" key={c.key}><input type="checkbox" checked={columns.includes(c.key)} disabled={columnSaving || (columns.length === 1 && columns.includes(c.key))} onChange={(event) => void saveColumns(c.key, event.target.checked)} /><span>{c.label}</span></label>)}
        {!matchingColumns.length && <p className="lead-column-empty" role="status">No columns match your search.</p>}
      </div>
      {columnSaving && <span className="visually-hidden" role="status">Saving columns...</span>}
      {columnError && <p className="lead-column-error" role="alert">{columnError}</p>}
    </section>, document.body)}
    <div className="table-wrap"><table className="data-table leads-table" aria-label="Leads" style={{ width: 42 + columns.reduce((width, key) => width + columnWidth(key), 0) }}><colgroup><col style={{ width: 42 }} />{columns.map(key => <col key={key} style={{ width: columnWidth(key) }} />)}</colgroup><thead><tr><th className="lead-selection-cell"><input type="checkbox" aria-label="Select page" disabled={staleResults} checked={visible.length > 0 && visible.every((lead) => selected.includes(lead.id))} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...visible.map((r) => r.id)])] : selected.filter((id) => !visible.some((r) => r.id === id)))} /></th>{columns.map((key) => <th key={key} title={availableColumns.find((c) => c.key === key)?.label}>{availableColumns.find((c) => c.key === key)?.label}</th>)}</tr></thead><tbody>
      {visible.map((lead) => <tr key={lead.id}><td className="lead-selection-cell"><input type="checkbox" aria-label={`Select ${lead.name}`} disabled={staleResults} checked={selected.includes(lead.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, lead.id] : selected.filter((id) => id !== lead.id))} /></td>{columns.map((key, index) => {
        const raw = leadColumnValue(lead, key);
        const value = ["createdAt", "modifiedAt", "lastVisitAt"].includes(key) ? formatDateTime(String(raw ?? ""), hydrated ? undefined : serverDateTimeFormatter) || "—" : raw === "" || raw === undefined ? "—" : raw;
        return <td key={key} title={String(value)}>{key === "name" ? <Link className="lead-cell" href={`/leads/${lead.id}`} prefetch={false} onClick={rememberNavigation}>{lead.name}</Link> : key === "stage" ? <StageBadge stage={lead.stage || "No stage"} /> : index === 0 ? <Link href={`/leads/${lead.id}`} prefetch={false} onClick={rememberNavigation}>{value}</Link> : value}</td>;
      })}</tr>)}
      {!rows.length && <tr><td className="leads-empty-cell" colSpan={columns.length + 1}><div className="leads-empty-state"><span className="leads-empty-icon"><Users size={26} aria-hidden="true" /></span><strong>{staleResults ? "No previous results." : "No leads match."}</strong>{!staleResults && <p>Create a lead or change filters.</p>}</div></td></tr>}
    </tbody></table></div><div className="table-footer"><span>{staleResults ? `${rows.length} previous leads` : <>{rows.length ? (pageSize === "all" ? 1 : page * pageSize + 1) : 0}–{pageSize === "all" ? rows.length : page * pageSize + rows.length} leads{pageSize !== "all" && hasMore ? " · More available" : ""}</>}</span><label className="lead-page-size">Rows per page<select aria-label="Leads per page" value={pageSize} onChange={event => changePageSize(event.target.value)}><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option><option value={100}>100</option><option value="all">All matching</option></select></label><div className="heading-actions"><button className="button button-secondary button-small" disabled={page === 0 || resultsLoading || pageSize === "all" || Boolean(validation)} onClick={() => { setPage(page - 1); setSelected([]); }}>Previous</button><span>Page {page + 1}</span><button className="button button-secondary button-small" disabled={!hasMore || !nextCursor || resultsLoading || pageSize === "all" || Boolean(validation)} onClick={() => { setCursors([...cursors.slice(0, page + 1), nextCursor]); setPage(page + 1); setSelected([]); }}>Next</button></div></div></section>
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
