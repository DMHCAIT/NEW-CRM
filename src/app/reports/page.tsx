"use client";

import Link from "next/link";
import { Download, Eye, Save, TableProperties, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { useReportsData } from "@/components/reports-data-provider";
import { FILTER_FIELDS, criterionError, type SavedLeadFilter } from "@/lib/lead-filters";
import { leadQueryPath, useLiveLeadData } from "@/lib/live-leads-client";
import type { LeadPage } from "@/lib/server/lead-query";
import { canDownloadReports } from "@/lib/permissions";
import { REPORT_COLUMNS, downloadReport as downloadReportCsv, type ReportColumn, type ReportMode, type SavedReport } from "@/lib/reports";
const DEFAULT_COLUMNS: ReportColumn[] = ["name", "phone", "email", "country", "course", "stage", "assignee", "followUp"];

function MatchingCount({ filter }: { filter: SavedLeadFilter }) {
  const { data, error } = useLiveLeadData<LeadPage>(leadQueryPath(filter, { count: true }, "/api/reports/results"));
  if (error) return <span role="alert">{error}</span>;
  return <span>{data?.total === undefined ? "Counting matching leads..." : `${data.total} matching leads`}</span>;
}

function ReportPreview({ filter, columns }: { filter: SavedLeadFilter; columns: typeof REPORT_COLUMNS[number][] }) {
  const { data, error } = useLiveLeadData<LeadPage>(leadQueryPath(filter, {}, "/api/reports/results"));
  return <section className="panel report-preview">
    <div className="panel-heading"><div><h2>Report preview</h2><p>Matching &quot;{filter.name}&quot; · Showing up to 10 rows</p></div></div>
    {error && <p role="alert">{error}</p>}
    {!data ? <p role="status">Loading preview...</p> : <div className="table-wrap"><table className="data-table">
      <thead><tr>{columns.map(({ key, label }) => <th key={key}>{label}</th>)}</tr></thead>
      <tbody>{data.leads.slice(0, 10).map(lead => <tr key={lead.id}>{columns.map(({ key }) => <td key={key}>{lead[key] ?? "—"}</td>)}</tr>)}
        {!data.leads.length && <tr><td colSpan={columns.length}>No leads match this saved filter.</td></tr>}
      </tbody></table></div>}
  </section>;
}

export default function ReportsPage() {
  const { user, reports, filters, saveReport, deleteReport } = useReportsData();
  const role = user.profile.role;
  const canDownload = canDownloadReports(role) && user.permissions.includes("reports.export");
  const savedFilters = filters.map((row) => ({ ...row.filter_json, id: row.id, name: row.name }));
  const [selectedFilterId, setSelectedFilterId] = useState("");
  const [reportName, setReportName] = useState("");
  const [columns, setColumns] = useState<ReportColumn[]>(DEFAULT_COLUMNS);
  const ready = true;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastSavedId, setLastSavedId] = useState("");
  const [reportModes, setReportModes] = useState<Record<string, ReportMode>>({});
  const savedReportsRef = useRef<HTMLElement>(null);
  const filter = savedFilters.find(({ id }) => id === selectedFilterId);
  const selectedColumns = REPORT_COLUMNS.filter(({ key }) => columns.includes(key));
  const filterValidation = filter?.criteria.map(criterionError).find(Boolean);

  useEffect(() => {
    if (!lastSavedId) return;
    savedReportsRef.current?.focus({ preventScroll: true });
    savedReportsRef.current?.scrollIntoView({ block: "start" });
  }, [lastSavedId]);

  async function saveReportForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    const name = reportName.trim();
    if (!ready || !filter || !name || columns.length === 0 || filterValidation) {
      setError("Choose a saved lead filter, enter a report name, and select at least one column.");
      return;
    }
    try {
      setSaving(true);
      const report: SavedReport = { id: crypto.randomUUID(), name, filter, columns: selectedColumns.map(({ key }) => key), savedAt: new Date().toISOString() };
      await saveReport(report);
      setReportName("");
      setSelectedFilterId("");
      setLastSavedId(report.id);
      setNotice(`"${name}" saved.${canDownload ? " Download it from Saved reports." : ""}`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The report could not be saved.");
    } finally { setSaving(false); }
  }

  async function downloadSavedReport(report: SavedReport) {
    setError("");
    if (!canDownloadReports(role)) {
      setError("Only Managers, Admins, and Super Admins can download reports.");
      return;
    }
    try {
      const mode = reportModes[report.id] ?? "list";
      await downloadReportCsv(report, [], mode);
      setNotice(`Downloaded "${report.name}".`);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "The report could not be downloaded.");
    }
  }

  return <>
    <div className="page-heading"><div><h1>Reports</h1><p>Build reports from your saved lead filters and choose the information to include.</p></div></div>
    {error && <div className="helper-banner report-message" role="alert">{error}</div>}
    {filterValidation && <div className="helper-banner report-message" role="alert">{filterValidation} Correct this saved filter in Leads before saving a report.</div>}
    <div className="reports-grid">
      <section className="panel report-builder">
        <div className="panel-heading"><div><h2>Build a report</h2><p>Filters come from Leads. Choose only the columns to include.</p></div><TableProperties size={17} /></div>
        <form className="report-form" onSubmit={saveReportForm}>
          <div className="form-field"><label htmlFor="report-filter">Saved lead filter</label><SearchableDropdown
            id="report-filter" ariaLabel="Saved lead filter" placeholder="Choose a saved lead filter"
            options={savedFilters.map(({ id, name }) => ({ value: id, label: name }))}
            value={selectedFilterId} onChange={(id) => { setSelectedFilterId(id); setNotice(""); }}
          /></div>
          {ready && savedFilters.length === 0 && <p className="report-empty">No saved lead filters yet. <Link href="/leads">Save a filter in Leads</Link> to build a report.</p>}
          {filter && <div className="report-filter-summary">
            <strong>{filter.name} · {!filterValidation && <MatchingCount key={filter.id} filter={filter} />}</strong>
            <span>{filter.matchMode === "all" ? "All" : "Any"} conditions match · {filter.quickView}</span>
            {filter.query && <span>Search: {filter.query}</span>}
            {filter.criteria.map((criterion) => <span key={criterion.id}>{FILTER_FIELDS.find(({ key }) => key === criterion.field)?.label} {criterion.operator.replaceAll("_", " ")} {criterion.value.replaceAll("\n", ", ")}{criterion.secondValue ? ` – ${criterion.secondValue}` : ""}</span>)}
          </div>}
          <div className="form-field"><label htmlFor="report-name">Report name</label><input id="report-name" placeholder="Enter a report name" value={reportName} onChange={(event) => setReportName(event.target.value)} required maxLength={120} /></div>
          <fieldset className="report-columns"><legend className="field-label">COLUMNS</legend><div className="column-checks">{REPORT_COLUMNS.map(({ key, label }) => <label key={key}><input type="checkbox" checked={columns.includes(key)} onChange={(event) => { setColumns((current) => event.target.checked ? [...current, key] : current.filter((column) => column !== key)); setNotice(""); }} /> {label}</label>)}</div></fieldset>
          {columns.length === 0 && <p className="report-empty">Select at least one column to save a report.</p>}
          <div className="report-actions"><button className="button button-primary" type="submit" disabled={saving || !ready || !filter || !reportName.trim() || columns.length === 0 || Boolean(filterValidation)}><Save size={14} /> {saving ? "Saving…" : "Save report"}</button></div>
        </form>
      </section>
      <section className="panel saved-reports" ref={savedReportsRef} tabIndex={-1} aria-label="Saved reports">
        <div className="panel-heading"><div><h2>Saved reports</h2><p>{canDownload ? "Download a report after saving it with a name." : "Downloads are available only to Managers, Admins, and Super Admins."}</p></div></div>
        {notice && <div className="helper-banner report-message" role="status">{notice}</div>}
        {reports.length > 0 && <div className="table-wrap"><table className="data-table saved-reports-table">
          <thead><tr><th>Report name</th><th>Saved on</th><th>Result</th><th>View</th>{canDownload && <th>Download</th>}<th>Delete</th></tr></thead>
          <tbody>{reports.map((report) => <tr className={report.id === lastSavedId ? "recently-saved" : undefined} key={report.id}>
            <td><strong>{report.name}</strong><span className="saved-report-details">{report.filter.name} · {report.columns.length} columns</span></td>
            <td>{report.savedAt ? <time dateTime={report.savedAt}>{new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(report.savedAt))}</time> : <span className="saved-report-details">Not recorded for this older report</span>}</td>
            <td><SearchableDropdown className="report-mode" ariaLabel={`Result for ${report.name}`} placeholder="Choose result" options={[{ value: "count", label: "Count" }, { value: "list", label: "Complete list" }]} value={reportModes[report.id] ?? "list"} onChange={(mode) => { if (mode === "count" || mode === "list") setReportModes((current) => ({ ...current, [report.id]: mode })); }} /></td>
            <td><Link className="button button-secondary button-small" aria-label={`View ${report.name}`} href={`/reports/${encodeURIComponent(report.id)}/${reportModes[report.id] ?? "list"}`}><Eye size={14} /> View</Link></td>
            {canDownload && <td><button className="button button-secondary button-small" onClick={() => void downloadSavedReport(report)} aria-label={`Download ${report.name}`}><Download size={14} /> Download CSV</button></td>}
            <td><button className="button button-secondary button-small" aria-label={`Delete ${report.name}`} onClick={() => { if (confirm(`Delete "${report.name}"?`)) void deleteReport(report.id).catch((e: Error) => setError(e.message)); }}><Trash2 size={14} /> Delete</button></td>
          </tr>)}</tbody>
        </table></div>}
        {ready && reports.length === 0 && <p className="report-empty saved-reports-empty">No saved reports. Save a named report to see it here.</p>}
      </section>
    </div>
    {filter && !filterValidation && selectedColumns.length > 0 && <ReportPreview key={filter.id} filter={filter} columns={selectedColumns} />}
    <div className="helper-banner report-note">Leads and saved reports are loaded from Supabase. Saved lead filters are managed in the Leads page. Report downloads are recorded in the CRM database.</div>
  </>;
}
