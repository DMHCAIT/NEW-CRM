import { filterLeads, type SavedLeadFilter } from "@/lib/lead-filters";
import type { Lead } from "@/lib/types";

export const REPORT_COLUMNS = [
  { key: "name", label: "Lead name" }, { key: "phone", label: "Phone" },
  { key: "email", label: "Email" }, { key: "country", label: "Country" },
  { key: "qualification", label: "Qualification" }, { key: "category", label: "Category" }, { key: "course", label: "Course" },
  { key: "stage", label: "Stage" }, { key: "assignee", label: "Assignee" },
  { key: "followUp", label: "Next follow-up" }, { key: "source", label: "Source" },
  { key: "createdAt", label: "Created date" }, { key: "modifiedAt", label: "Modified date" },
  { key: "modifiedBy", label: "Modified by" }, { key: "lastVisitAt", label: "Most recent visit" },
] as const satisfies readonly { key: keyof Lead; label: string }[];
export type ReportColumn = (typeof REPORT_COLUMNS)[number]["key"];
export type ReportMode = "count" | "list";
export type SavedReport = { id: string; name: string; filter: SavedLeadFilter; columns: ReportColumn[]; savedAt?: string };

export function reportLeads(report: SavedReport, leads: Lead[], currentUserId?: string) {
  return filterLeads(leads, report.filter, new Date(), { currentUserId });
}

function csvValue(value: string | number | undefined) {
  const text = String(value ?? "");
  // Prevent spreadsheet formulas from executing when exported lead data is opened.
  const safe = /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function reportCsv(report: SavedReport, rows: Lead[], mode: ReportMode) {
  if (mode === "count") return `"Count"\r\n${csvValue(rows.length)}`;
  const columns = report.columns.map((key) => REPORT_COLUMNS.find((column) => column.key === key)!);
  return [
    columns.map(({ label }) => csvValue(label)).join(","),
    ...rows.map((lead) => columns.map(({ key }) => csvValue(lead[key])).join(",")),
  ].join("\r\n");
}

export async function downloadReport(report: SavedReport, _rows: Lead[], mode: ReportMode) {
  const response = await fetch("/api/reports/export", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: report.id, mode, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error ?? "Report download failed.");
  }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  const name = report.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "") || "report";
  anchor.download = `${name}${mode === "count" ? "-count" : ""}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
