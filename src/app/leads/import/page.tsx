"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, FileSpreadsheet, Trash2, UploadCloud, Users } from "lucide-react";
import { ApiError, apiRequest, formatDateTime } from "@/lib/crm-data";
import { createLeadCsvSample, MAX_LEAD_IMPORT_FILE_BYTES, MAX_LEAD_IMPORT_ROWS, parseLeadSpreadsheet } from "@/lib/live-leads-csv";
import { normalizePhone } from "@/lib/lead-phone";
import { sanitizeLeadImportCells } from "@/lib/lead-input";
import { useLiveLeadData } from "@/lib/live-leads-client";
import { downloadLeadImportPdf, type LeadImportSheet } from "@/lib/lead-import-report";

const DUPLICATE_CHECK_BATCH_SIZE = 2_000;
const IMPORT_REQUEST_BATCH_SIZE = 500;
const MAX_IMPORT_REQUEST_BATCH_SIZE = 2_000;
const DELETE_BATCH_SIZE = 500;
const MAX_DELETE_BATCH_SIZE = 2_000;

// Grow fast batches to cut round trips; shrink slow ones before they reach the database statement timeout.
function nextBatchSize(current: number, elapsedMs: number, limit: number) {
  if (elapsedMs < 2_000) return Math.min(limit, current * 2);
  if (elapsedMs > 5_000) return Math.max(1, Math.floor(current / 2));
  return current;
}

export default function LeadImportPage() {
  const { data, error, loading, reload, setError } = useLiveLeadData("/api/leads?metadata=only");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [previewCount, setPreviewCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [filename, setFilename] = useState("");
  const [skippedRows, setSkippedRows] = useState(0);
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
  const [deleteProgress, setDeleteProgress] = useState("");
  const importSession = useRef<{ sheet: LeadImportSheet; offset: number; batchIndex: number; batchSize: number; batchLimit: number } | null>(null);
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
    setHistoryAction(sheet.id); setHistoryError(""); setDeleteProgress("");
    try {
      if (importSession.current?.sheet.id === sheet.id) await readFile();
      let batchSize = DELETE_BATCH_SIZE;
      let batchLimit = MAX_DELETE_BATCH_SIZE;
      let result: { deleted: number; done: boolean };
      for (;;) {
        let retries = 0;
        const started = Date.now();
        try {
          for (;;) {
            try {
              result = await apiRequest<{ deleted: number; done: boolean }>(`/api/leads/imports/${sheet.id}?batchSize=${batchSize}`, { method: "DELETE" });
              break;
            } catch (error) {
              const transient = error instanceof TypeError || (error instanceof ApiError && [429, 502, 503, 504, 520].includes(error.status));
              if (!transient || retries >= 3) throw error;
              retries++;
              setDeleteProgress(`Connection interrupted. Retrying deletion (attempt ${retries} of 3)...`);
              await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (retries - 1)));
            }
          }
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "canceling statement due to statement timeout" || batchSize === 1) throw error;
          batchSize = Math.max(1, Math.floor(batchSize / 2));
          batchLimit = batchSize;
          setDeleteProgress(`Database timed out. Retrying with batches of ${batchSize.toLocaleString()} leads.`);
          continue;
        }
        setDeleteProgress(`Removing leads: ${result.deleted.toLocaleString()} archived.`);
        if (result.done) break;
        batchSize = nextBatchSize(batchSize, Date.now() - started, batchLimit);
      }
      setDeleteSheet(null);
      setNotice(`Deleted "${sheet.filename}" and removed ${result.deleted.toLocaleString()} imported leads from the CRM.`);
      await loadHistory(sheets.length === 1 ? Math.max(0, historyOffset - 20) : historyOffset);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not delete the import sheet.";
      try { await loadHistory(historyOffset); setHistoryError(message); }
      catch (error) { setHistoryError(`${message} History refresh failed: ${error instanceof Error ? error.message : "Please refresh."}`); }
    } finally { setHistoryAction(""); setDeleteProgress(""); }
  }
  async function readFile(file?: File) {
    setRows([]); setPreview([]); setPreviewCount(0); setTotalRows(0); setError(""); setNotice(""); setFilename(file?.name ?? ""); setSkippedRows(0); setAssignmentChoice(""); setAssignAll(false); setProgress("");
    importSession.current = null;
    if (!file || !data) return;
    setBusy(true);
    try {
      if (file.size > MAX_LEAD_IMPORT_FILE_BYTES) throw new Error("Choose a file smaller than 50 MB.");
      if (!/\.(csv|xlsx)$/i.test(file.name)) throw new Error("Choose a CSV or Excel .xlsx file.");
      const parsed = await parseLeadSpreadsheet(file, data.configuration.fields.filter((f) => f.active).map((f) => f.name));
      const isComplete = (row: Record<string, string>) => {
        const name = row.name?.trim() ?? "";
        const phone = row.phone ?? "";
        const email = row.email?.trim() ?? "";
        return name.length > 0 && name.length <= 200 && phone.length <= 30
          && phone.replace(/\D/g, "").length >= 7 && /^\+?[\d\s().-]+$/.test(phone)
          && email.length <= 254 && email.includes("@");
      };
      const incompleteRows: number[] = [];
      const mapped: { lead: Record<string, unknown>; clearedCells: number; sourceIndex: number }[] = parsed.flatMap((originalRow, sourceIndex) => {
        if (!isComplete(originalRow)) { incompleteRows.push(sourceIndex); return []; }
        const { stage, assignee, ...row } = originalRow;
        const customFields = Object.fromEntries(Object.entries(row).filter(([key]) => key.startsWith("custom:")).map(([key, value]) => [key.slice(7), value]));
        const builtIn = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith("custom:")));
        const sanitized = sanitizeLeadImportCells({
          ...builtIn, customFields, closureFee: Number(row.closureFee || 0), source: row.source || "import",
          followUpAt: row.followUpAt || "", expectedClosureDate: row.expectedClosureDate || "",
        }, data.configuration);
        const normalizedPhone = normalizePhone(row.phone, String(sanitized.values.countryCode ?? ""));
        if (normalizedPhone.length < 7 || normalizedPhone.length > 15) { incompleteRows.push(sourceIndex); return []; }
        const stageName = stage?.trim() ?? "";
        const stageRow = stageName
          ? data.stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase()) ?? data.stages[0]
          : data.stages.find((s) => s.name.trim().toLowerCase() === "fresh");
        if (!stageName && !stageRow) throw new Error('An active "Fresh" stage is required for leads with an empty stage. Enable it in CRM settings and reload.');
        const matches = assignee ? data.profiles.filter((p) => p.status === "active" && (p.email.toLowerCase() === assignee.toLowerCase() || p.fullName.toLowerCase() === assignee.toLowerCase())) : [];
        const assigneeId = matches.length === 1 && (matches[0].id === data.user.id || data.user.permissions.includes("leads.assign")) ? matches[0].id : null;
        return [{
          lead: {
            ...sanitized.values,
            phone: `+${normalizedPhone}`,
            stageId: stageRow?.id ?? null,
            assigneeId,
          },
          clearedCells: sanitized.clearedCells,
          sourceIndex,
        }];
      });
      if (parsed.length > MAX_LEAD_IMPORT_ROWS) throw new Error(`Import at most ${MAX_LEAD_IMPORT_ROWS.toLocaleString()} leads at a time.`);
      const duplicateIndexes = new Set<number>();
      const seenEmails = new Set<string>();
      const seenPhones = new Set<string>();
      const candidates: { row: Record<string, unknown>; index: number }[] = [];
      mapped.forEach(({ lead: row }, index) => {
        const email = String(row.email ?? "").trim().toLowerCase();
        const phone = normalizePhone(String(row.phone ?? ""), String(row.countryCode ?? ""));
        if (seenEmails.has(email) || seenPhones.has(phone)) duplicateIndexes.add(index);
        else candidates.push({ row, index });
        seenEmails.add(email);
        seenPhones.add(phone);
      });
      let checkBatchSize = DUPLICATE_CHECK_BATCH_SIZE;
      for (let offset = 0; offset < candidates.length;) {
        const batch = candidates.slice(offset, offset + checkBatchSize);
        try {
          let retries = 0;
          let duplicates: number[];
          for (;;) {
            try {
              ({ duplicates } = await apiRequest<{ duplicates: number[] }>("/api/leads/import", { body: { rows: batch.map(candidate => candidate.row), checkOnly: true } }));
              break;
            } catch (error) {
              const transient = error instanceof TypeError || (error instanceof ApiError && [429, 502, 503, 504, 520].includes(error.status));
              if (!transient || retries >= 3) throw error;
              retries++;
              setProgress(`Connection interrupted. Retrying duplicate check (attempt ${retries} of 3)...`);
              await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (retries - 1)));
            }
          }
          if (!Array.isArray(duplicates) || duplicates.some(index => !Number.isInteger(index) || index < 0 || index >= batch.length)) throw new Error("Duplicate check returned an invalid result.");
          for (const index of duplicates) duplicateIndexes.add(batch[index].index);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "canceling statement due to statement timeout" || batch.length === 1) throw error;
          checkBatchSize = Math.floor(batch.length / 2);
          setProgress(`Database timed out. Retrying duplicate checks with batches of ${checkBatchSize.toLocaleString()} leads.`);
          continue;
        }
        offset += batch.length;
        setProgress(`Checking duplicates: ${offset.toLocaleString()} of ${candidates.length.toLocaleString()} leads`);
      }
      const remaining = mapped.filter((_, index) => !duplicateIndexes.has(index));
      const remainingRows = remaining.map(({ lead }) => lead);
      setRows(remainingRows);
      const sampleRows: Record<string, string>[] = [];
      for (let index = 0; index < mapped.length && sampleRows.length < 20; index++) {
        if (!duplicateIndexes.has(index)) {
          const cleanedCells = Object.fromEntries(Object.entries(mapped[index].lead).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
          sampleRows.push({ ...parsed[mapped[index].sourceIndex], ...cleanedCells });
        }
      }
      setPreviewCount(remainingRows.length);
      setPreview(sampleRows);
      const skippedCount = incompleteRows.length + duplicateIndexes.size;
      setSkippedRows(skippedCount);
      setTotalRows(parsed.length);
      setProgress("");
      const messages: string[] = [];
      if (skippedCount) {
        const reasons = [
          incompleteRows.length ? `${incompleteRows.length.toLocaleString()} with missing or invalid required lead fields` : "",
          duplicateIndexes.size ? `${duplicateIndexes.size.toLocaleString()} duplicates` : "",
        ].filter(Boolean).join(" and ");
        messages.push(`${skippedCount.toLocaleString()} row${skippedCount === 1 ? "" : "s"} skipped (${reasons}).`);
      }
      const clearedCells = remaining.reduce((count, row) => count + row.clearedCells, 0);
      if (clearedCells) messages.push(`${clearedCells.toLocaleString()} invalid optional cell${clearedCells === 1 ? "" : "s"} cleared. Valid values in the same columns are preserved.`);
      setNotice(messages.join(" "));
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
        const { sheet } = await apiRequest<{ sheet: LeadImportSheet }>("/api/leads/imports", { body: { filename, totalRows, duplicates: skippedRows } });
        importSession.current = { sheet, offset: 0, batchIndex: 0, batchSize: IMPORT_REQUEST_BATCH_SIZE, batchLimit: MAX_IMPORT_REQUEST_BATCH_SIZE };
      }
      const session = importSession.current;
      while (session.offset < rows.length) {
        const batch = rows.slice(session.offset, session.offset + session.batchSize);
        let result: { imported: number; skipped: number };
        let retries = 0;
        const started = Date.now();
        try {
          for (;;) {
            try {
              result = await apiRequest<{ imported: number; skipped: number }>("/api/leads/import", { body: { rows: batch, importId: session.sheet.id, batchIndex: session.batchIndex } });
              break;
            } catch (error) {
              const transient = error instanceof TypeError || (error instanceof ApiError && [429, 502, 503, 504, 520].includes(error.status));
              if (!transient || retries >= 3) throw error;
              retries++;
              setProgress(`Connection interrupted. Retrying batch ${session.batchIndex + 1} (attempt ${retries} of 3)...`);
              await new Promise(resolve => setTimeout(resolve, 500 * 2 ** (retries - 1)));
            }
          }
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "canceling statement due to statement timeout" || batch.length === 1) throw error;
          session.batchSize = Math.floor(batch.length / 2);
          session.batchLimit = session.batchSize;
          setProgress(`Database timed out. Retrying with batches of ${session.batchSize.toLocaleString()} leads.`);
          continue;
        }
        session.sheet = { ...session.sheet, imported_rows: session.sheet.imported_rows + result.imported, duplicate_rows: session.sheet.duplicate_rows + result.skipped };
        session.offset += batch.length;
        session.batchIndex++;
        session.batchSize = nextBatchSize(batch.length, Date.now() - started, session.batchLimit);
        setProgress(`Importing: ${session.offset.toLocaleString()} of ${rows.length.toLocaleString()} leads`);
      }
      const sheet = { ...session.sheet, status: "completed" as const };
      importSession.current = null;
      setRows([]); setPreview([]); setPreviewCount(0); setTotalRows(0); setSkippedRows(0); setProgress("");
      const summary = `"${sheet.filename}": ${sheet.imported_rows.toLocaleString()} leads imported; ${sheet.duplicate_rows.toLocaleString()} rows skipped.`;
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
      <div className="import-selection"><div className="import-counts"><span><strong>{totalRows.toLocaleString()}</strong> total rows</span><span><strong>{rows.length.toLocaleString()}</strong> ready to review</span><span><strong>{skippedRows.toLocaleString()}</strong> skipped</span><span><strong>{assignedCount.toLocaleString()}</strong> assigned</span></div><button className="button button-primary" disabled={busy || !totalRows || firstUnassignedIndex >= 0 || Boolean(historyAction)} onClick={() => importRows()}>{busy ? "Processing…" : importSession.current ? "Retry import" : rows.length ? "Import validated leads" : "Save skipped-row report"}</button></div>
      {progress && <p className="import-progress" role="status">{progress}</p>}
      <details className="import-instructions"><summary>Import format and duplicate rules</summary><p>Upload up to 200,000 leads per file (maximum 50 MB). Required columns: name, phone and email. Rows with missing or invalid required lead fields are skipped. Unknown columns and invalid optional field values are ignored. Any non-empty email containing @ is accepted. Duplicate email addresses and equivalent phone numbers are skipped automatically, including duplicates within this file. Deleted leads can be re-imported unless their sheet deletion is still in progress. Re-importing creates new leads and retains the deleted leads&apos; history. Blank optional fields in other columns are accepted. countryCode is optional; when provided, choose a configured country code. Phone numbers may include the code with or without a + sign, or be a local number paired with countryCode. The combined phone number must have 7 to 15 digits. If assignee is blank, choose an owner for that lead before importing. Assignee accepts an active user&apos;s email or full name. Notes are added to each lead&apos;s Notes timeline (up to 10,000 characters). The sample includes two example rows with a value or format for every column; delete both sample rows before importing your own leads. Custom fields use custom:Field name headers from the template. Follow-up timestamps require an explicit timezone (for example, 2026-12-02T10:00:00+05:30). Excel uploads read the first worksheet from an .xlsx workbook.</p><p>Imports are saved in batches. Temporary connection errors are retried automatically, and database statement timeouts are retried with smaller batches. If retries fail, use Retry import without leaving this page. Rows with an inaccessible assignee are skipped without rejecting other valid rows. Imports use active database stages.</p></details>
    </div></section>
    {preview.length > 0 && <div className={`import-review${firstUnassignedIndex >= 0 ? " has-assignment" : ""}`}>
      {firstUnassignedIndex >= 0 && <section className="panel import-assignment" aria-label="Assign lead owners"><div className="import-section-heading"><Users size={17} /><h2>Assign lead owner</h2><span className="import-pending-count">{unassignedCount.toLocaleString()} pending</span></div><div className="import-assignment-body"><div className="import-lead-identity"><strong>{String(rows[firstUnassignedIndex].name ?? `Row ${firstUnassignedIndex + 2}`)}</strong><span>{String(rows[firstUnassignedIndex].email ?? "")}</span><span>{String(rows[firstUnassignedIndex].phone ?? "")}</span></div><label className="form-field"><span>Assign to</span><select aria-label={`Assign ${String(rows[firstUnassignedIndex].name ?? `row ${firstUnassignedIndex + 2}`)}`} value={assignmentChoice} disabled={busy} onChange={event => setAssignmentChoice(event.target.value)}><option value="">Choose an active lead owner</option>{availableAssignees.map(profile => <option key={profile.id} value={profile.id}>{profile.fullName} · {profile.email}</option>)}</select></label>{unassignedCount > 1 && <label className="import-assign-all"><input type="checkbox" checked={assignAll} disabled={busy} onChange={event => setAssignAll(event.target.checked)} />Apply to all {unassignedCount.toLocaleString()} unassigned leads</label>}<button className="button button-primary" disabled={busy || !assignmentChoice} onClick={() => { setRows(current => current.map((row, index) => index === firstUnassignedIndex || (assignAll && !row.assigneeId) ? { ...row, assigneeId: assignmentChoice } : row)); setAssignmentChoice(""); }}>Assign and continue</button></div></section>}
      <section className="panel import-preview"><div className="import-section-heading"><FileSpreadsheet size={17} /><h2>Preview</h2><span>{Math.min(20, previewCount)} of {previewCount.toLocaleString()} leads</span>{firstUnassignedIndex < 0 && <span className="import-ready"><CheckCircle2 size={14} />Owners assigned</span>}</div><div className="table-wrap import-preview-scroll"><table className="data-table"><thead><tr>{previewColumns.map(key => <th key={key}>{key}</th>)}<th>Assigned owner</th></tr></thead><tbody>{preview.map((row, index) => <tr key={index}>{previewColumns.map(key => <td key={key}>{row[key] || "—"}</td>)}<td>{data.profiles.find(profile => profile.id === rows[index]?.assigneeId)?.fullName ?? (row.assignee || "Needs assignment")}</td></tr>)}</tbody></table></div></section>
    </div>}
    <section className="panel imported-files-panel"><div className="import-section-heading"><FileSpreadsheet size={17} /><h2>Import history</h2><span>{historyTotal.toLocaleString()} sheets</span><button className="button button-secondary" disabled={historyLoading || busy || Boolean(historyAction)} onClick={() => void loadHistory(historyOffset).catch(e => setHistoryError(e instanceof Error ? e.message : "Could not load import history."))}>Refresh</button></div>
      {historyError && <p className="helper-banner" role="alert">{historyError}</p>}
      {deleteSheet && <div className="import-delete-confirm" role="alertdialog" aria-modal="false" aria-labelledby="delete-import-title" aria-describedby="delete-import-description"><strong id="delete-import-title">Delete {deleteSheet.filename}?</strong><p id="delete-import-description">This removes the sheet and all {deleteSheet.imported_rows.toLocaleString()} leads it created from the CRM, including reassigned leads. Existing duplicate leads are not affected. Audit history is retained. Deletion is saved in batches and can be resumed if interrupted.</p>{deleteProgress && <p role="status">{deleteProgress}</p>}<div><button className="button button-secondary" disabled={Boolean(historyAction)} onClick={() => setDeleteSheet(null)}>Cancel</button><button className="button button-danger" disabled={busy || Boolean(historyAction)} onClick={() => void removeSheet(deleteSheet)}>Delete sheet and leads</button></div></div>}
      {historyLoading ? <p className="import-empty" role="status">Loading import history…</p> : sheets.length ? <div className="imported-file-list">{sheets.map(sheet => <div className="imported-file-row" key={sheet.id}><span className="imported-file-icon"><FileSpreadsheet size={18} /></span><div className="imported-file-details"><strong title={sheet.filename}>{sheet.filename}</strong><span>{formatDateTime(sheet.created_at)} · {sheet.status === "completed" ? "Completed" : sheet.status === "deleting" ? "Deletion incomplete" : "Incomplete"}</span><div className="import-counts"><span>{sheet.total_rows.toLocaleString()} total</span><span className="import-ready">{sheet.imported_rows.toLocaleString()} imported</span><span>{sheet.duplicate_rows.toLocaleString()} skipped</span>{sheet.total_rows > sheet.imported_rows + sheet.duplicate_rows && <span>{(sheet.total_rows - sheet.imported_rows - sheet.duplicate_rows).toLocaleString()} not processed</span>}</div></div><button className="button button-secondary" aria-label={`Download PDF for ${sheet.filename}`} disabled={busy || Boolean(historyAction)} onClick={() => void report(sheet)}><Download size={14} />PDF</button>{canDelete && <button className="button button-secondary" aria-label={`Delete ${sheet.filename} and its imported leads`} disabled={busy || Boolean(historyAction)} onClick={() => setDeleteSheet(sheet)}><Trash2 size={14} />{sheet.status === "deleting" ? "Resume deletion" : "Delete"}</button>}</div>)}</div> : <p className="import-empty">No saved imports yet. New imports appear here with their sheet name and counts.</p>}
      {historyTotal > 20 && <div className="import-history-pagination"><button className="button button-secondary" disabled={historyOffset === 0 || historyLoading || busy || Boolean(historyAction)} onClick={() => void loadHistory(Math.max(0, historyOffset - 20)).catch(e => setHistoryError(e instanceof Error ? e.message : "Could not load import history."))}>Previous</button><span>{historyOffset + 1}–{Math.min(historyOffset + 20, historyTotal)} of {historyTotal}</span><button className="button button-secondary" disabled={historyOffset + 20 >= historyTotal || historyLoading || busy || Boolean(historyAction)} onClick={() => void loadHistory(historyOffset + 20).catch(e => setHistoryError(e instanceof Error ? e.message : "Could not load import history."))}>Next</button></div>}
      <p className="import-storage-note">History tracks new imports only. Sheet names and counts are saved, not the original files. PDF counts include duplicate and incomplete-contact rows skipped during preview and import.</p>
    </section>
  </div>;
}
