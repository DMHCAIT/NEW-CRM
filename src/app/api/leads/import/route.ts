import { NextResponse } from "next/server";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { dbError, enforceDuplicatePolicy, fetchLeadConfiguration, parseLead, validateCustomFields } from "@/lib/live-leads";
import { checkOrigin } from "@/lib/server/login";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.import");
    if (!user.permissions.includes("leads.create")) throw new HttpError(403, "Creating leads is not permitted.");
    const body = await readJson<{ rows?: unknown[]; duplicateOverride?: boolean }>(request);
    if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > 1000) throw new HttpError(400, "Import between 1 and 1000 rows per batch.");
    const configuration = await fetchLeadConfiguration(supabase);
    const rows = body.rows.map((value, index) => {
      try {
        const row = parseLead(value);
        validateCustomFields(row.custom_fields, configuration);
        if (row.assignee_id && row.assignee_id !== user.id && !user.permissions.includes("leads.assign")) throw new Error("Assignment permission required.");
        return { ...row, assignee_id: row.assignee_id ?? user.id, created_by: user.id, modified_by: user.id };
      } catch (error) { throw new HttpError(400, `Row ${index + 2}: ${error instanceof Error ? error.message : "Invalid lead"}`); }
    });
    await enforceDuplicatePolicy(supabase, rows, configuration, user, body.duplicateOverride === true);
    const { data, error } = await supabase.rpc("import_live_leads", { rows_json: rows });
    dbError(error);
    return NextResponse.json({ imported: data }, { status: 201 });
  } catch (error) { return jsonError(error); }
}
