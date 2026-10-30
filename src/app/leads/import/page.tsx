"use client";

import Link from "next/link";
import { useState } from "react";
import { Download, FileSpreadsheet, UploadCloud } from "lucide-react";
import { apiRequest } from "@/lib/crm-data";
import { IMPORT_HEADERS, parseLeadCsv } from "@/lib/live-leads-csv";
import { useLiveLeadData } from "@/lib/live-leads-client";

export default function LeadImportPage() {
  const { data, error, loading, reload, setError } = useLiveLeadData("/api/leads?metadata=only");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [filename, setFilename] = useState("");
  async function readFile(file?: File) {
    setRows([]); setPreview([]); setError(""); setNotice(""); setFilename(file?.name ?? "");
    if (!file || !data) return;
    try {
      if (file.size > 5_000_000) throw new Error("CSV must be smaller than 5 MB.");
      const parsed = parseLeadCsv(await file.text(), data.configuration.fields.filter((f) => f.active).map((f) => f.name));
      const mapped = parsed.map(({ stage, assignee, ...row }, index) => {
        const fail = (message: string): never => { throw new Error(`Row ${index + 2}: ${message}`); };
        if (!row.name?.trim()) fail("Name is required.");
        const normalized = (row.phone ?? "").replace(/\D/g, "");
        if (normalized.length < 7 || !/^\+?[\d\s().-]+$/.test(row.phone ?? "")) fail("A valid phone is required.");
        if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) fail("Invalid email address.");
        const stageRow = stage ? data.stages.find((s) => s.name.toLowerCase() === stage.toLowerCase()) : data.stages[0];
        if (stage && !stageRow) fail(`Unknown active stage "${stage}".`);
        const matches = assignee ? data.profiles.filter((p) => p.email.toLowerCase() === assignee.toLowerCase() || p.fullName.toLowerCase() === assignee.toLowerCase()) : [];
        if (assignee && matches.length !== 1) fail(`Assignee "${assignee}" must match one accessible active user. Prefer their email.`);
        const assigneeId = matches[0]?.id ?? data.user.id;
        if (assigneeId !== data.user.id && !data.user.permissions.includes("leads.assign")) fail("Assignment permission is required.");
        if (row.followUpAt && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(row.followUpAt) || !Number.isFinite(Date.parse(row.followUpAt)))) fail("Follow-up must be an ISO timestamp with timezone.");
        const closureFee = Number(row.closureFee || 0);
        if (!Number.isFinite(closureFee) || closureFee < 0) fail("Closure fee must be a nonnegative number.");
        const customFields = Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith("custom:")).map(([key, value]) => [key.slice(7), value]));
        const builtIn = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("custom:")));
        return { ...builtIn, customFields, source: row.source || "import", stageId: stageRow?.id ?? null, assigneeId, followUpAt: row.followUpAt || null, closureFee };
      });
      setRows(mapped); setPreview(parsed);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not read CSV."); }
  }
  function template() {
    const custom = data?.configuration.fields.filter((f) => f.active).map((f) => `custom:${f.name}`) ?? [];
    const url = URL.createObjectURL(new Blob([`${[...IMPORT_HEADERS, ...custom].map((header) => `"${header.replaceAll('"', '""')}"`).join(",")}\r\n`], { type: "text/csv" }));
    const link = document.createElement("a"); link.href = url; link.download = "lead-import-template.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importRows() {
    setBusy(true); setError("");
    try {
      let result: { imported: number };
      try { result = await apiRequest("/api/leads/import", { body: { rows } }); }
      catch (e) {
        if (!(e instanceof Error) || !e.message.startsWith("Duplicate warning:") || !confirm(`${e.message}\nImport duplicate rows?`)) throw e;
        result = await apiRequest("/api/leads/import", { body: { rows, duplicateOverride: true } });
      }
      setRows([]); setPreview([]); setNotice(`${result.imported} leads persisted in the database.`);
    } catch (e) { setError(e instanceof Error ? e.message : "Import failed."); }
    finally { setBusy(false); }
  }
  if (!data) return <section className="panel live-panel"><h1>Import leads</h1>{loading ? <p role="status">Loading import configuration…</p> : <><p role="alert">{error}</p><button className="button button-secondary" onClick={() => void reload().catch(() => {})}>Retry</button></>}</section>;
  if (!data.user.permissions.includes("leads.import") || !data.user.permissions.includes("leads.create")) return <p role="alert">You need lead import and create permissions.</p>;
  return <>
    <div className="detail-back"><Link href="/leads">Back to leads</Link></div>
    <div className="page-heading"><div><h1>Import leads</h1><p>Upload a CSV file to add leads to your admissions workspace.</p></div><button className="button button-secondary" onClick={template}><Download size={15} />Download CSV template</button></div>
    {error && <p className="helper-banner" role="alert">{error}</p>}{notice && <p className="helper-banner" role="status">{notice}</p>}
    <section className="panel import-panel"><div className="panel-heading"><div><h2>Upload CSV</h2><p>Choose a file, review the preview and import your leads.</p></div><FileSpreadsheet size={18} /></div><div className="import-body">
      <label className="import-dropzone" onDragOver={event => { if (!busy) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!busy) void readFile(event.dataTransfer.files[0]); }}>
        <input aria-label="CSV file" type="file" accept=".csv,text/csv" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} /><span className="import-upload-icon"><UploadCloud size={21} /></span><strong>{filename || "Choose a CSV file or drag it here"}</strong><span>Up to 1,000 leads · Maximum file size 5 MB</span>
      </label>
      <div className="import-selection"><span>{rows.length} validated leads ready to import</span><button className="button button-primary" disabled={busy || !rows.length} onClick={() => void importRows()}>{busy ? "Importing…" : "Import validated leads"}</button></div>
      <details className="import-instructions"><summary>CSV format and duplicate rules</summary><p>Required columns: name, phone. Optional columns: {IMPORT_HEADERS.slice(2).join(", ")}. Custom fields use custom:Field name headers from the template. Use configured stage names and assignee email addresses. Follow-up timestamps require an explicit timezone (for example, 2026-10-22T10:00:00+05:30).</p><p>Duplicate settings: {data.configuration.duplicateFields.replace("_", " or ")} · {data.configuration.creationPolicy === "warn" ? "warn and allow only administrators with confirmation" : data.configuration.creationPolicy}. Checks cover this batch and all existing leads without disclosing inaccessible records. Any validation failure rejects the entire batch. A blank assignee defaults to you. Imports use active database stages.</p></details>
    </div></section>
    {preview.length > 0 && <section className="panel"><div className="live-panel"><h2>Preview</h2><p>First 20 of {preview.length} leads. Full validation is repeated on the server before the atomic database import.</p></div><div className="table-wrap"><table className="data-table"><thead><tr>{Object.keys(preview[0]).map((key) => <th key={key}>{key}</th>)}</tr></thead><tbody>{preview.slice(0, 20).map((row, index) => <tr key={index}>{Object.keys(preview[0]).map((key) => <td key={key}>{row[key] || "—"}</td>)}</tr>)}</tbody></table></div></section>}
  </>;
}
