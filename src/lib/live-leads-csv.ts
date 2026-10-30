export const IMPORT_HEADERS = ["name", "countryCode", "phone", "email", "country", "qualification", "category", "course", "source", "stage", "assignee", "closureFee", "altPhone", "followUpAt"] as const;

/** RFC 4180-style CSV reader; preserves quoted commas, line breaks and escaped quotes. */
export function parseLeadCsv(text: string, customFields: string[] = []): Record<string, string>[] {
  if (text.length > 5_000_000) throw new Error("CSV must be smaller than 5 MB.");
  const records: string[][] = [];
  let record: string[] = [], field = "", quoted = false, afterQuote = false;
  const finishField = () => { record.push(field.trim()); field = ""; afterQuote = false; };
  const finishRecord = () => { finishField(); if (record.some(Boolean)) records.push(record); record = []; };
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
  if (records.length < 2) throw new Error("CSV needs headers and at least one lead.");
  if (records.length > 1001) throw new Error("Import at most 1000 leads at a time.");
  const aliases: Record<string, string> = {
    name: "name", leadname: "name", phone: "phone", mobile: "phone", countrycode: "countryCode", alternatephone: "altPhone", altphone: "altPhone",
    email: "email", country: "country", course: "course", qualification: "qualification", category: "category", source: "source",
    stage: "stage", assignee: "assignee", followupat: "followUpAt", nextfollowup: "followUpAt", closurefee: "closureFee",
  };
  const headers = records[0].map((value) => {
    if (value.startsWith("custom:") && customFields.includes(value.slice(7))) return value;
    const key = aliases[value.toLowerCase().replace(/[\s_-]/g, "")];
    if (!key) throw new Error(`Unknown CSV column "${value}". Use the template headers.`);
    return key;
  });
  if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate headers.");
  if (!headers.includes("name") || !headers.includes("phone")) throw new Error("CSV requires name and phone columns.");
  return records.slice(1).map((values, i) => {
    if (values.length !== headers.length) throw new Error(`Row ${i + 2} has ${values.length} values; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((key, index) => [key, values[index]]));
  });
}
