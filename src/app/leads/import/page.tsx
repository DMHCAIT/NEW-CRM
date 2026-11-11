"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, FileSpreadsheet, Trash2, UploadCloud, Users } from "lucide-react";
import { apiRequest, formatDateTime } from "@/lib/crm-data";
import { createLeadCsvSample, MAX_LEAD_IMPORT_FILE_BYTES, MAX_LEAD_IMPORT_ROWS, parseLeadSpreadsheet } from "@/lib/live-leads-csv";
import { isDateKey } from "@/lib/lead-filters";
import { countryCodeMatchesOptions, normalizePhone } from "@/lib/lead-phone";
import { useLiveLeadData } from "@/lib/live-leads-client";
import { downloadLeadImportPdf, type LeadImportSheet } from "@/lib/lead-import-report";

const IMPORT_REQUEST_BATCH_SIZE = 5_000;

export default function LeadImportPage() {
  const { data, error, loading, reload, setError } = useLiveLeadData("/api/leads?metadata=only");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [previewCount, setPreviewCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [filename, setFilename] = useState("");
  const [skippedDuplicates, setSkippedDuplicates] = useState(0);
  const [assignmentChoice, setAssignmentChoice] = useState("");
  const [progress, setProgress] = useState("");
  const [totalRows, setTotalRows] = useState(0);
  const [assignAll, setAssignAll] = useState(false);
  const [sheets, setSheets] = useState<LeadImportSheet[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [historyAction, setHistoryAction] = useState("");
  const [deleteSheet, setDeleteSheet] = useState<LeadImportSheet | null>(null);
  const importSession = useRef<{ sheet: LeadImportSheet; offset: number } | null>(null);
  const canImport = Boolean(data?.user.permissions.includes("leads.import") && data.user.permissions.includes("leads.create"));
  const loadHistory = useCallback(async (offset: number) => {
    setHistoryLoading(true); setHistoryError("");
    try {
      const result = await apiRequest<{ sheets: LeadImportSheet[]; total: number }>(`/api/leads/imports?offset=${offset}`, { forceFresh: true });
      setSheets(result.sheets); setHistoryTotal(result.total); setHistoryOffset(offset);
    } finally { setHistoryLoading(false); }
  }, []);
  useEffect(() => {
    if (canImport) void loadHistory(0).catch(e => setHistoryError(e instanceof Error ? e.message : "Could not load import history."));
  }, [canImport, loadHistory]);
  async function report(sheet: LeadImportSheet) {
    setHistoryAction(sheet.id); setHistoryError("");
    try { await downloadLeadImportPdf(sheet); }
    catch (e) { setHistoryError(e instanceof Error ? e.message : "Could not download the PDF summary."); }
    finally { setHistoryAction(""); }
  }
  async function removeSheet(sheet: LeadImportSheet) {
    setHistoryAction(sheet.id); setHistoryError("");
    try {
      const result = await apiRequest<{ deleted: number }>(`/api/leads/imports/${sheet.id}`, { method: "DELETE" });
      setDeleteSheet(null);
      if (importSession.current?.sheet.id === sheet.id) await readFile();
      setNotice(`Deleted "${sheet.filename}" and removed ${result.deleted.toLocaleString()} imported leads from the CRM.`);
      await loadHistory(sheets.length === 1 ? Math.max(0, historyOffset - 20) : historyOffset);
    } catch (e) { setHistoryError(e instanceof Error ? e.message : "Could not delete the import sheet."); }
    finally { setHistoryAction(""); }
  }
  async function readFile(file?: File) {
    setRows([]); setPreview([]); setPreviewCount(0); setTotalRows(0); setError(""); setNotice(""); setFilename(file?.name ?? ""); setSkippedDuplicates(0); setAssignmentChoice(""); setAssignAll(false); setProgress("");
    importSession.current = null;
    if (!file || !data) return;
    setBusy(true);
    try {
      if (file.size > MAX_LEAD_IMPORT_FILE_BYTES) throw new Error("Choose a file smaller than 50 MB.");
      if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error("Choose a CSV or Excel .xlsx file.");
      const parsed = await parseLeadSpreadsheet(file, data.configuration.fields.filter((f) => f.active).map((f) => f.name));
      const mapped: Record<string, unknown>[] = parsed.map(({ stage, assignee, note, ...row }, index) => {
        const fail = (message: string): never => { throw new Error(`Row ${index + 2}: ${message}`); };
        if (!row.name?.trim()) fail("Name is required.");
        if (!row.email?.trim()) fail("Email is required.");
        if (row.countryCode?.trim() && data.configuration.picklists.countryCode.length && !data.configuration.picklists.countryCode.includes(row.countryCode) && !countryCodeMatchesOptions(row.countryCode, data.configuration.picklists.countryCode)) fail(`Choose a valid country code "${row.countryCode}".`);
        if (note && note.length > 10000) fail("Note cannot exceed 10,000 characters.");
        const normalized = (row.phone ?? "").replace(/\D/g, "");
        if (normalized.length < 7 || !/^\+?[\d\s().-]+$/.test(row.phone ?? "")) fail("A valid phone is required.");
        if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) fail("Invalid email address.");
        const stageRow = stage ? data.stages.find((s) => s.name.toLowerCase() === stage.toLowerCase()) : data.stages[0];
        if (stage && !stageRow) fail(`Unknown active stage "${stage}".`);
        const matches = assignee ? data.profiles.filter((p) => p.status === "active" && (p.email.toLowerCase() === assignee.toLowerCase() || p.fullName.toLowerCase() === assignee.toLowerCase())) : [];
        if (assignee && matches.length !== 1) fail(`Assignee "${assignee}" must match one accessible active user. Prefer their email.`);
        const assigneeId = matches[0]?.id ?? null;
        if (assigneeId && assigneeId !== data.user.id && !data.user.permissions.includes("leads.assign")) fail("Assignment permission is required.");
        if (row.followUpAt && (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(row.followUpAt) || !Number.isFinite(Date.parse(row.followUpAt)))) fail("Follow-up must be an ISO timestamp with timezone.");
        if (row.expectedClosureDate && !isDateKey(row.expectedClosureDate)) fail("Expected closure date must be a valid YYYY-MM-DD date.");
        const closureFee = Number(row.closureFee || 0);
        if (!Number.isFinite(closureFee) || closureFee < 0) fail("Expected closure fee must be a nonnegative number.");
        const customFields = Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith("custom:")).map(([key, value]) => [key.slice(7), value]));
        const builtIn = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("custom:")));
        return { ...builtIn, phone: `+${normalizePhone(row.phone, row.countryCode)}`, customFields, note, source: row.source || "import", stageId: stageRow?.id ?? null, assigneeId, followUpAt: row.followUpAt || null, closureFee };
      });
      if (mapped.length > MAX_LEAD_IMPORT_ROWS) throw new Error(`Import at most ${MAX_LEAD_IMPORT_ROWS.toLocaleString()} leads at a time.`);
      const duplicateIndexes = new Set<number>();
      const seenEmails = new Set<string>();
      const seenPhones = new Set<string>();
      for (let offset = 0; offset < mapped.length; offset += IMPORT_REQUEST_BATCH_SIZE) {
        const batch = mapped.slice(offset, offset + IMPORT_REQUEST_BATCH_SIZE);
        const candidates: { row: Record<string, unknown>; index: number }[] = [];
        const localDuplicates: number[] = [];
        batch.forEach((row, index) => {
          const email = String(row.email ?? "").trim().toLowerCase();
          const phone = normalizePhone(String(row.phone ?? ""), String(row.countryCode ?? ""));
          if (seenEmails.has(email) || seenPhones.has(phone)) localDuplicates.push(index);
          else candidates.push({ row, index });
          seenEmails.add(email);
          seenPhones.add(phone);
        });
        for (const index of localDuplicates) duplicateIndexes.add(offset + index);
        if (candidates.length) {
          const { duplicates } = await apiRequest<{ duplicates: number[] }>("/api/leads/import", { body: { rows: candidates.map(candidate => candidate.row), checkOnly: true } });
          if (!Array.isArray(duplicates) || duplicates.some(index => !Number.isInteger(index) || index < 0 || index >= candidates.length)) throw new Error("Duplicate check returned an invalid result.");
          for (const index of duplicates) duplicateIndexes.add(offset + candidates[index].index);
        }
        setProgress(`Checking duplicates: ${Math.min(offset + batch.length, mapped.length).toLocaleString()} of ${mapped.length.toLocaleString()} leads`);
      }
      const remainingRows = mapped.filter((_, index) => !duplicateIndexes.has(index));
      setRows(remainingRows);
      const sampleRows: Record<string, string>[] = [];
      for (let index = 0; index < parsed.length && sampleRows.length < 20; index++) {
        if (!duplicateIndexes.has(index)) sampleRows.push({ ...parsed[index], phone: String(mapped[index].phone) });
      }
      setPreviewCount(remainingRows.length);
      setPreview(sampleRows);
      setSkippedDuplicates(duplicateIndexes.size);
      setTotalRows(parsed.length);
      setProgress("");
      if (duplicateIndexes.size) setNotice(remainingRows.length
        ? `${duplicateIndexes.size.toLocaleString()} duplicate row${duplicateIndexes.size === 1 ? "" : "s"} removed from the import preview.`
        : `All ${duplicateIndexes.size.toLocaleString()} rows matched existing or repeated leads and were removed. Nothing to import.`);
    } catch (e) { setProgress(""); setError(e instanceof Error ? e.message : "Could not read the spreadsheet."); }
    finally { setBusy(false); }
  }
  function template() {
    if (!data) return;
    const customFields = data.configuration.fields.filter((field) => field.active);
    const csv = createLeadCsvSample({
      picklists: data.configuration.picklists,
      stages: data.stages.map(stage => stage.name),
      assignees: [data.user.email],
      customFields,
    });
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "lead-import-sample.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importRows() {
    setBusy(true); setError(""); setProgress("");
    try {
      if (!importSession.current) {
        const { sheet } = await apiRequest<{ sheet: LeadImportSheet }>("/api/leads/imports", { body: { filename, totalRows, duplicates: skippedDuplicates } });
        importSession.current = { sheet, offset: 0 };
      }
      const session = importSession.current;
      for (let offset = session.offset; offset < rows.length; offset += IMPORT_REQUEST_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + IMPORT_REQUEST_BATCH_SIZE);
        const result = await apiRequest<{ imported: number; skipped: number }>("/api/leads/import", { body: { rows: batch, importId: session.sheet.id, batchIndex: offset / IMPORT_REQUEST_BATCH_SIZE } });
        session.sheet = { ...session.sheet, imported_rows: session.sheet.imported_rows + result.imported, duplicate_rows: session.sheet.duplicate_rows + result.skipped };
        session.offset = offset + batch.length;
        setProgress(`Importing: ${Math.min(offset + batch.length, rows.length).toLocaleString()} of ${rows.length.toLocaleString()} leads`);
      }
      const sheet = { ...session.sheet, status: "completed" as const };
      importSession.current = null;
      setRows([]); setPreview([]); setPreviewCount(0); setTotalRows(0); setSkippedDuplicates(0); setProgress("");
      const summary = `"${sheet.filename}": ${sheet.imported_rows.toLocaleString()} leads imported; ${sheet.duplicate_rows.toLocaleString()} duplicates skipped.`;
      setNotice(summary);
      try { await downloadLeadImportPdf(sheet); setNotice(`${summary} PDF summary downloaded.`); }
      catch (e) { setError(`Import completed, but the PDF could not be downloaded: ${e instanceof Error ? e.message : "Please retry from import history."}`); }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
      if (importSession.current) setNotice(`${importSession.current.sheet.imported_rows.toLocaleString()} leads confirmed imported. Retry to continue this sheet safely. Its saved counts are available in import history.`);
    } finally {
      setProgress("");
      await loadHistory(0).catch(e => setHistoryError(e instanceof Error ? e.message : "Could not refresh import history."));
      setBusy(false);
    }
  }
  let firstUnassignedIndex = -1;
  let unassignedCount = 0;
  for (let index = 0; index < rows.length; index++) {
    if (!rows[index].assigneeId) {
      unassignedCount++;
      if (firstUnassignedIndex < 0) firstUnassignedIndex = index;
    }
  }
  const assignedCount = rows.length - unassignedCount;
  const availableAssignees = data?.profiles.filter(profile => profile.status === "active" && (profile.id === data.user.id || data.user.permissions.includes("leads.assign"))) ?? [];
  const previewColumns = ["name", "phone", "email", "course"].filter(key => preview.some(row => row[key]));
  const canDelete = Boolean(data?.user.permissions.includes("leads.delete") && ["admin", "super_admin"].includes(data.user.profile.role));
  if (!data) return <section className="panel live-panel"><h1>Import leads</h1>{loading ? <p role="status">Loading import configuration…</p> : <><p role="alert">{error}</p><button className="button button-secondary" onClick={() => void reload().catch(() => {})}>Retry</button></>}</section>;
  if (!data.user.permissions.includes("leads.import") || !data.user.permissions.includes("leads.create")) return <p role="alert">You need lead import and create permissions.</p>;
  return <div className="lead-import-workspace">
    <div className="detail-back"><Link href="/leads">Back to leads</Link></div>
    <div className="page-heading"><div><h1>Import leads</h1><p>Upload, assign and review your CSV or Excel leads.</p></div><button className="button button-secondary" onClick={template}><Download size={15} />Download sample CSV</button></div>
    {error && <p className="helper-banner" role="alert">{error}</p>}{notice && <p className="helper-banner" role="status">{notice}</p>}
    <section className="panel import-panel"><div className="panel-heading"><div><h2>Upload spreadsheet</h2><p>A PDF summary downloads automatically after import.</p></div><FileSpreadsheet size={18} /></div><div className="import-body">
      <label className="import-dropzone" onDragOver={event => { if (!busy && !historyAction) event.preventDefault(); }} onDrop={event => { event.preventDefault(); if (!busy && !historyAction) void readFile(event.dataTransfer.files[0]); }}>
        <input aria-label="CSV or Excel file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy || Boolean(historyAction)} onChange={event => readFile(event.target.files?.[0])} /><span className="import-upload-icon"><UploadCloud size={21} /></span><strong>{filename || "Choose a CSV or Excel .xlsx file or drag it here"}</strong><span>Up to {MAX_LEAD_IMPORT_ROWS.toLocaleString()} leads · Maximum file size 50 MB</span>
      </label>
      <div className="import-selection"><div className="import-counts"><span><strong>{totalRows.toLocaleString()}</strong> total rows</span><span><strong>{rows.length.toLocaleString()}</strong> ready to review</span><span><strong>{skippedDuplicates.toLocaleString()}</strong> duplicates</span><span><strong>{assignedCount.toLocaleString()}</strong> assigned</span></div><button className="button button-primary" disabled={busy || !totalRows || firstUnassignedIndex >= 0 || Boolean(historyAction)} onClick={() => importRows()}>{busy ? "Processing…" : importSession.current ? "Retry import" : rows.length ? "Import validated leads" : "Save duplicate report"}</button></div>
      {progress && <p className="import-progress" role="status">{progress}</p>}
      <details className="import-instructions"><summary>Import format and duplicate rules</summary><p>Upload up to 200,000 leads per file (maximum 50 MB). Required columns: name, phone and email. countryCode is optional; when provided, choose a configured country code. Phone numbers may include the code with or without a + sign, or be a local number paired with countryCode. Duplicate email addresses and equivalent phone numbers are skipped automatically, including duplicates within this file. If assignee is blank, choose an owner for that lead before importing. Assignee accepts an active user&apos;s email or full name. Notes are added to each lead&apos;s Notes timeline. The sample includes two example rows with a value or format for every column; delete both sample rows before importing your own leads. Custom fields use custom:Field name headers from the template. Follow-up timestamps require an explicit timezone (for example, 2026-12-02T10:00:00+05:30). Excel uploads read the first worksheet from an .xlsx workbook.</p><p>Any validation failure rejects the entire batch. Imports use active database stages.</p></details>
    </div></section>
    {preview.length > 0 && <div className={`import-review${firstUnassignedIndex >= 0 ? " has-assignment" : ""}`}>
      {firstUnassignedIndex >= 0 && <section className="panel import-assignment" aria-label="Assign lead owners"><div className="import-section-heading"><Users size={17} /><h2>Assign lead owner</h2><span className="import-pending-count">{unassignedCount.toLocaleString()} pending</span></div><div className="import-assignment-body"><div className="import-lead-identity"><strong>{String(rows[firstUnassignedIndex].name ?? `Row ${firstUnassignedIndex + 2}`)}</strong><span>{String(rows[firstUnassignedIndex].email ?? "")}</span><span>{String(rows[firstUnassignedIndex].phone ?? "")}</span></div><label className="form-field"><span>Assign to</span><select aria-label={`Assign ${String(rows[firstUnassignedIndex].name ?? `row ${firstUnassignedIndex + 2}`)}`} value={assignmentChoice} disabled={busy} onChange={event => setAssignmentChoice(event.target.value)}><option value="">Choose an active lead owner</option>{availableAssignees.map(profile => <option key={profile.id} value={profile.id}>{profile.fullName} · {profile.email}</option>)}</select></label>{unassignedCount > 1 && <label className="import-assign-all"><input type="checkbox" checked={assignAll} disabled={busy} onChange={event => setAssignAll(event.target.checked)} />Apply to all {unassignedCount.toLocaleString()} unassigned leads</label>}<button className="button button-primary" disabled={busy || !assignmentChoice} onClick={() => { setRows(current => current.map((row, index) => index === firstUnassignedIndex || (assignAll && !row.assigneeId) ? { ...row, assigneeId: assignmentChoice } : row)); setAssignmentChoice(""); }}>Assign and continue</button></div></section>}
      <section className="panel import-preview"><div className="import-section-heading"><FileSpreadsheet size={17} /><h2>Preview</h2><span>{Math.min(20, previewCount)} of {previewCount.toLocaleString()} leads</span>{firstUnassignedIndex < 0 && <span className="import-ready"><CheckCircle2 size={14} />Owners assigned</span>}</div><div className="table-wrap import-preview-scroll"><table className="data-table"><thead><tr>{previewColumns.map(key => <th key={key}>{key}</th>)}<th>Assigned owner</th></tr></thead><tbody>{preview.map((row, index) => <tr key={index}>{previewColumns.map(key => <td key={key}>{row[key] || "—"}</td>)}<td>{data.profiles.find(profile => profile.id === rows[index]?.assigneeId)?.fullName ?? (row.assignee || "Needs assignment")}</td></tr>)}</tbody></table></div></section>
    </div>}
    <section className="panel imported-files-panel"><div className="import-section-heading"><FileSpreadsheet size={17} /><h2>Import history</h2><span>{historyTotal.toLocaleString()} sheets</span><button className="button button-secondary" disabled={historyLoading || busy || Boolean(historyAction)} onClick={() => void loadHistory(historyOffset).catch(e => setHistoryError(e instanceof Error ? e.message : "Could not load import history."))}>Refresh</button></div>
      {historyError && <p className="helper-banner" role="alert">{historyError}</p>}
      {deleteSheet && <div className="import-delete-confirm" role="alertdialog" aria-modal="false" aria-labelledby="delete-import-title" aria-describedby="delete-import-description"><strong id="delete-import-title">Delete {deleteSheet.filename}?</strong><p id="delete-import-description">This removes the sheet and all {deleteSheet.imported_rows.toLocaleString()} leads it created from the CRM, including reassigned leads. Existing duplicate leads are not affected. Audit history is retained.</p><div><button className="button button-secondary" disabled={Boolean(historyAction)} onClick={() => setDeleteSheet(null)}>Cancel</button><button className="button button-danger" disabled={busy || Boolean(historyAction)} onClick={() => void removeSheet(deleteSheet)}>Delete sheet and leads</button></div></div>}
      {historyLoading ? <p className="import-empty" role="status">Loading import history…</p> : sheets.length ? <div className="imported-file-list">{sheets.map(sheet => <div className="imported-file-row" key={sheet.id}><span className="imported-file-icon"><FileSpreadsheet size={18} /></span><div className="imported-file-details"><strong title={sheet.filename}>{sheet.filename}</strong><span>{formatDateTime(sheet.created_at)} · {sheet.status === "completed" ? "Completed" : "Incomplete"}</span><div className="import-counts"><span>{sheet.total_rows.toLocaleString()} total</span><span className="import-ready">{sheet.imported_rows.toLocaleString()} imported</span><span>{sheet.duplicate_rows.toLocaleString()} duplicates</span>{sheet.total_rows > sheet.imported_rows + sheet.duplicate_rows && <span>{(sheet.total_rows - sheet.imported_rows - sheet.duplicate_rows).toLocaleString()} not processed</span>}</div></div><button className="button button-secondary" aria-label={`Download PDF for ${sheet.filename}`} disabled={busy || Boolean(historyAction)} onClick={() => void report(sheet)}><Download size={14} />PDF</button>{canDelete && <button className="button button-secondary" aria-label={`Delete ${sheet.filename} and its imported leads`} disabled={busy || Boolean(historyAction)} onClick={() => setDeleteSheet(sheet)}><Trash2 size={14} />Delete</button>}</div>)}</div> : <p className="import-empty">No saved imports yet. New imports appear here with their sheet name and counts.</p>}
      {historyTotal > 20 && <div className="import-history-pagination"><button className="button button-secondary" disabled={historyOffset === 0 || historyLoading || busy || Boolean(historyAction)} onClick={() => void loadHistory(Math.max(0, historyOffset - 20)).catch(e => setHistoryError(e instanceof Error ? e.message : "Could not load import history."))}>Previous</button><span>{historyOffset + 1}–{Math.min(historyOffset + 20, historyTotal)} of {historyTotal}</span><button className="button button-secondary" disabled={historyOffset + 20 >= historyTotal || historyLoading || busy || Boolean(historyAction)} onClick={() => void loadHistory(historyOffset + 20).catch(e => setHistoryError(e instanceof Error ? e.message : "Could not load import history."))}>Next</button></div>}
      <p className="import-storage-note">History tracks new imports only. Sheet names and counts are saved, not the original files. PDF counts include duplicates skipped during preview and import.</p>
    </section>
  </div>;
}
