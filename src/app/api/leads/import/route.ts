import { NextResponse } from "next/server";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { dbError, fetchLeadConfiguration, parseLead, uuid, validateCustomFields } from "@/lib/live-leads";
import { countryCodeMatchesOptions } from "@/lib/lead-phone";
import { checkOrigin } from "@/lib/server/login";

const MAX_IMPORT_BATCH_ROWS = 5_000;
const MAX_IMPORT_REQUEST_BYTES = 50_000_000;

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.import");
    if (!user.permissions.includes("leads.import")) throw new HttpError(403, "Lead import permission is required.");
    if (!user.permissions.includes("leads.create")) throw new HttpError(403, "Creating leads is not permitted.");
    const requestBytes = Number(request.headers.get("content-length") ?? 0);
    if (requestBytes > MAX_IMPORT_REQUEST_BYTES) throw new HttpError(413, "Import request must be smaller than 50 MB.");
    const body = await readJson<{ rows?: unknown[]; checkOnly?: boolean; duplicateOverride?: boolean; importId?: unknown; batchIndex?: unknown }>(request);
    if (body.importId !== undefined && typeof body.importId !== "string") throw new HttpError(400, "Invalid import sheet ID.");
    const importId = typeof body.importId === "string" ? uuid(body.importId) : undefined;
    if (importId && (typeof body.batchIndex !== "number" || !Number.isSafeInteger(body.batchIndex) || body.batchIndex < 0)) throw new HttpError(400, "A valid import batch index is required.");
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_IMPORT_BATCH_ROWS) throw new HttpError(400, `Import between 1 and ${MAX_IMPORT_BATCH_ROWS.toLocaleString()} rows per request.`);
    const configuration = await fetchLeadConfiguration(supabase);
    const rows = body.rows.map((value, index) => {
      try {
        const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
        const { note, ...leadValue } = source;
        if (note !== undefined && (typeof note !== "string" || note.length > 10000)) throw new Error("Note must be text with at most 10,000 characters.");
        const row = parseLead(leadValue);
        if (!row.email) throw new Error("Email is required.");
        if (row.country_code && configuration.picklists.countryCode.length && !configuration.picklists.countryCode.includes(row.country_code) && !countryCodeMatchesOptions(row.country_code, configuration.picklists.countryCode)) throw new Error("Choose a valid country code.");
        validateCustomFields(row.custom_fields, configuration);
        if (!body.checkOnly && row.assignee_id && row.assignee_id !== user.id && !user.permissions.includes("leads.assign")) throw new Error("Assignment permission required.");
        if (!body.checkOnly && !row.assignee_id) throw new Error("Choose an assignee for every imported lead.");
        return { ...row, note: typeof note === "string" ? note.trim() : "", created_by: user.id, modified_by: user.id };
      } catch (error) { throw new HttpError(400, `Row ${index + 2}: ${error instanceof Error ? error.message : "Invalid lead"}`); }
    });
    if (body.checkOnly) {
      const { data, error } = await supabase.rpc("find_live_lead_import_duplicates", { rows_json: rows });
      dbError(error);
      if (!Array.isArray(data) || data.some(index => !Number.isInteger(index) || index < 0 || index >= rows.length)) throw new HttpError(500, "Duplicate check returned an invalid result.");
      return NextResponse.json({ duplicates: data });
    }
    const { data, error } = importId
      ? await supabase.rpc("import_live_lead_sheet_batch", { sheet_id: importId, batch_index: body.batchIndex, rows_json: rows })
      : await supabase.rpc("import_live_leads", { rows_json: rows });
    dbError(error);
    if (!data || typeof data !== "object" || !("imported" in data) || !("skipped" in data)
      || !Number.isInteger(data.imported) || !Number.isInteger(data.skipped)
      || data.imported < 0 || data.skipped < 0 || data.imported + data.skipped !== rows.length) throw new HttpError(500, "Import completed with an invalid result.");
    return NextResponse.json(data, { status: 201 });
  } catch (error) { return jsonError(error); }
}
