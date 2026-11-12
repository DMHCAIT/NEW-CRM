import { readSheet } from "read-excel-file/browser";

export const MAX_LEAD_IMPORT_ROWS = 200_000;
export const MAX_LEAD_IMPORT_FILE_BYTES = 50_000_000;
export const IMPORT_HEADERS = ["name", "countryCode", "phone", "email", "country", "qualification", "speciality", "category", "course", "source", "stage", "assignee", "expectedClosureFee", "expectedClosureDate", "altPhone", "followUpAt", "billingAddress", "note"] as const;

type LeadCsvSampleOptions = {
  picklists?: Record<string, string[]>;
  stages?: string[];
  assignees?: string[];
  customFields?: { name: string; options?: string[] }[];
};

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function parseLeadSpreadsheet(file: Pick<File, "name" | "text" | "arrayBuffer">, customFields: string[] = []) {
  if (file.name.toLowerCase().endsWith(".csv")) return parseLeadCsv(await file.text(), customFields);
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("Choose a CSV or Excel .xlsx file.");
  const rows = await readSheet(await file.arrayBuffer(), 1);
  if (rows.length > MAX_LEAD_IMPORT_ROWS + 1) throw new Error(`Import at most ${MAX_LEAD_IMPORT_ROWS.toLocaleString()} leads at a time.`);
  return mapLeadRecords(rows, customFields);
}

export function createLeadCsvSample({ picklists = {}, stages = [], assignees = [], customFields = [] }: LeadCsvSampleOptions = {}) {
  const requiredHeaders = new Set(["name", "phone", "email"]);
  const headers = IMPORT_HEADERS.map(header => requiredHeaders.has(header) ? `${header} (required)` : header);
  const option = (field: string, index: number, fallback: string) => picklists[field]?.[index] ?? picklists[field]?.[0] ?? fallback;
  const stage = (index: number) => stages[index] ?? stages[0] ?? `Active stage ${index + 1}`;
  const assignee = (index: number) => assignees[index] ?? assignees[0] ?? "";
  const rows = [0, 1].map(index => {
    const sample = index + 1;
    const values: Record<string, string> = {
      name: `Sample Lead ${sample} - remove before import`,
      countryCode: option("countryCode", index, "India (+91)"),
      phone: `987650000${sample}`,
      email: `sample.lead${sample}@example.com`,
      country: option("country", index, "India"),
      qualification: option("qualification", index, "Graduate"),
      speciality: index === 0 ? "Cardiology" : "Neurology",
      category: option("category", index, "Certificate"),
      course: option("course", index, `Sample course ${sample}`),
      source: option("source", index, "Website"),
      stage: stage(index),
      assignee: assignee(index),
      expectedClosureFee: index === 0 ? "50000" : "75000",
      expectedClosureDate: index === 0 ? "2026-12-01" : "2026-12-15",
      altPhone: `987650001${sample}`,
      followUpAt: index === 0 ? "2026-12-02T10:00:00+05:30" : "2026-12-16T14:30:00+05:30",
      billingAddress: index === 0 ? "12 Example Road, Delhi" : "24 Sample Avenue, Mumbai",
      note: index === 0 ? "Initial enquiry from website; asked about course details." : "Follow-up requested; prefers an afternoon call.",
    };
    for (const field of customFields) {
      values[`custom:${field.name}`] = field.options?.[index] ?? field.options?.[0] ?? `Example answer ${sample}`;
    }
    return [...IMPORT_HEADERS.map(header => values[header]), ...customFields.map(field => values[`custom:${field.name}`])];
  });
  return [[...headers, ...customFields.map(field => `custom:${field.name}`)], ...rows]
    .map(row => row.map(csvCell).join(","))
    .join("\r\n") + "\r\n";
}

function mapLeadRecords(records: unknown[][], customFields: string[]): Record<string, string>[] {
  if (records.length < 2) throw new Error("CSV needs headers and at least one lead.");
  if (records.length > MAX_LEAD_IMPORT_ROWS + 1) throw new Error(`Import at most ${MAX_LEAD_IMPORT_ROWS.toLocaleString()} leads at a time.`);
  const aliases: Record<string, string> = {
    name: "name", leadname: "name", phone: "phone", mobile: "phone", countrycode: "countryCode", alternatephone: "altPhone", altphone: "altPhone",
    email: "email", country: "country", course: "course", qualification: "qualification", speciality: "speciality", specialty: "speciality", category: "category", source: "source",
    stage: "stage", assignee: "assignee", followupat: "followUpAt", nextfollowup: "followUpAt", closurefee: "closureFee",
    expectedclosurefee: "closureFee", expectedclosuredate: "expectedClosureDate", billingaddress: "billingAddress", note: "note", notes: "note",
  };
  const cellText = (value: unknown) => value === null || value === undefined ? "" : value instanceof Date ? value.toISOString() : String(value);
  const unnamedColumns = records[0].flatMap((cell, index) => cellText(cell).trim() ? [] : [index]);
  if (unnamedColumns.some(index => records.slice(1).some(row => cellText(row[index]).trim()))) {
    throw new Error("CSV contains values under an unnamed column. Add a header or remove that column.");
  }
  const normalizedRecords = unnamedColumns.length
    ? records.map(row => row.filter((_, index) => !unnamedColumns.includes(index)))
    : records;
  const headers = normalizedRecords[0].map((cell) => {
    const value = cellText(cell).trim();
    if (value.startsWith("custom:") && customFields.includes(value.slice(7))) return value;
    const key = aliases[value.toLowerCase().replace(/\s*\(required\)\s*$/, "").replace(/[\s_-]/g, "")];
    if (!key) throw new Error(`Unknown CSV column "${value}". Use the template headers.`);
    return key;
  });
  if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate headers.");
  if (!headers.includes("name") || !headers.includes("phone")) throw new Error("CSV requires name and phone columns.");
  return normalizedRecords.slice(1).map((cells, i) => {
    if (cells.length !== headers.length) throw new Error(`Row ${i + 2} has ${cells.length} values; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((key, index) => [key, cellText(cells[index]).trim()]));
  });
}

/** RFC 4180-style CSV reader; preserves quoted commas, line breaks and escaped quotes. */
export function parseLeadCsv(text: string, customFields: string[] = []): Record<string, string>[] {
  if (text.length > MAX_LEAD_IMPORT_FILE_BYTES) throw new Error("CSV must be smaller than 50 MB.");
  const records: string[][] = [];
  let record: string[] = [], field = "", quoted = false, afterQuote = false;
  const finishField = () => { record.push(field.trim()); field = ""; afterQuote = false; };
  const finishRecord = () => {
    finishField();
    if (record.some(Boolean)) {
      records.push(record);
      if (records.length > MAX_LEAD_IMPORT_ROWS + 1) throw new Error(`Import at most ${MAX_LEAD_IMPORT_ROWS.toLocaleString()} leads at a time.`);
    }
    record = [];
  };
  const input = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; afterQuote = true; }
      else field += char;
    } else if (char === "," || char === "\n" || char === "\r") {
      if (char === ",") finishField();
      else { finishRecord(); if (char === "\r" && input[i + 1] === "\n") i++; }
    } else if (char === '"' && field === "" && !afterQuote) quoted = true;
    else if (afterQuote && /\s/.test(char)) continue;
    else if (afterQuote || char === '"') throw new Error(`Malformed CSV near character ${i + 1}.`);
    else field += char;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted value.");
  finishRecord();
  return mapLeadRecords(records, customFields);
}
