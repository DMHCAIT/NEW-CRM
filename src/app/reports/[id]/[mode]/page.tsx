"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Download } from "lucide-react";
import { useState } from "react";
import { useReportsData } from "@/components/reports-data-provider";
import { canDownloadReports } from "@/lib/permissions";
import { REPORT_COLUMNS, downloadReport as downloadReportCsv, type SavedReport } from "@/lib/reports";
import { leadQueryPath, useLiveLeadData } from "@/lib/live-leads-client";
import type { LeadCursor, LeadPage } from "@/lib/server/lead-query";

function ReportResults({ report, mode }: { report: SavedReport; mode: string }) {
  const [cursors, setCursors] = useState<(LeadCursor | null)[]>([null]);
  const [page, setPage] = useState(0);
  const { data, loading, error, reload } = useLiveLeadData<LeadPage>(leadQueryPath(report.filter, { count: mode === "count", cursor: cursors[page] }, "/api/reports/results"));
  const columns = report.columns.map(key => REPORT_COLUMNS.find(column => column.key === key)!);
  return <section className="panel report-preview" aria-busy={loading}>
    {error && <p role="alert">{error}<button className="button button-secondary" onClick={() => void reload().catch(() => {})}>Retry</button></p>}
    {!data ? <p role="status">Loading report results...</p> : mode === "count"
      ? <div className="report-count"><h2>Total matching leads</h2><strong>{data.total}</strong></div>
      : <>
        <div className="panel-heading"><h2>Complete list</h2><p>{data.leads.length} leads on page {page + 1}</p></div>
        <div className="table-wrap"><table className="data-table"><thead><tr>{columns.map(({ key, label }) => <th key={key}>{label}</th>)}</tr></thead>
          <tbody>{data.leads.map(lead => <tr key={lead.id}>{columns.map(({ key }) => <td key={key}>{lead[key] ?? "—"}</td>)}</tr>)}
            {!data.leads.length && <tr><td colSpan={columns.length}>No leads match this saved report.</td></tr>}
          </tbody></table></div>
        <div className="table-footer"><button className="button button-secondary" disabled={!page || loading} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page + 1} · Up to 50 leads</span>
          <button className="button button-secondary" disabled={!data.hasMore || loading} onClick={() => { setCursors([...cursors.slice(0, page + 1), data.nextCursor]); setPage(page + 1); }}>Next</button></div>
      </>}
  </section>;
}

export default function ReportViewPage() {
  const { id, mode } = useParams<{ id: string; mode: string }>();
  const { user, reports } = useReportsData();
  const role = user.profile.role;
  const report = reports.find((savedReport) => savedReport.id === id) ?? null;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function download() {
    try {
      if (mode !== "count" && mode !== "list") throw new Error("Invalid report result type.");
      if (!report) throw new Error("This saved report no longer exists.");
      await downloadReportCsv(report, [], mode);
      setError("");
      setNotice("Report downloaded.");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "The report could not be downloaded.");
    }
  }

  const validMode = mode === "count" || mode === "list";
  return <>
    <div className="detail-back"><Link href="/reports">Back to reports</Link></div>
    <div className="page-heading"><div><h1>{report?.name ?? "Report"}</h1><p>{mode === "count" ? "Count" : "Complete list"}</p></div>
      {report && validMode && canDownloadReports(role) && user.permissions.includes("reports.export") && <button className="button button-primary" onClick={() => void download()}><Download size={14} /> Download CSV</button>}
    </div>
    {!validMode && <div className="helper-banner report-message" role="alert">Choose Count or Complete list from Saved reports.</div>}
    {error && <div className="helper-banner report-message" role="alert">{error}</div>}
    {notice && <div className="helper-banner report-message" role="status">{notice}</div>}
    {!report && validMode && <div className="helper-banner report-message" role="alert">This saved report was not found. Return to Reports and select a saved report.</div>}
    {report && validMode && <ReportResults key={`${report.id}-${mode}`} report={report} mode={mode} />}
  </>;
}
