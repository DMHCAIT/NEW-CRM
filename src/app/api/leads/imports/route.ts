import { NextResponse } from "next/server";
import { HttpError, jsonError, readJson, requireString, requireUser } from "@/lib/server/auth";
import { dbError } from "@/lib/live-leads";
import { checkOrigin } from "@/lib/server/login";

export async function GET(request: Request) {
  try {
    const { supabase } = await requireUser("leads.import");
    const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, "Invalid import history offset.");
    const { data, error, count } = await supabase.from("lead_import_sheets")
      .select("id,filename,total_rows,imported_rows,duplicate_rows,status,created_at", { count: "exact" })
      .neq("status", "deleted").order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 19);
    dbError(error);
    return NextResponse.json({ sheets: data, total: count }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.import");
    if (!user.permissions.includes("leads.create")) throw new HttpError(403, "Creating leads is not permitted.");
    const body = await readJson<{ filename?: unknown; totalRows?: unknown; duplicates?: unknown }>(request);
    const filename = requireString(body.filename, "Sheet name", 255);
    if (typeof body.totalRows !== "number" || !Number.isInteger(body.totalRows) || body.totalRows < 1 || body.totalRows > 200000
      || typeof body.duplicates !== "number" || !Number.isInteger(body.duplicates) || body.duplicates < 0 || body.duplicates > body.totalRows) {
      throw new HttpError(400, "Invalid sheet row counts.");
    }
    const { data, error } = await supabase.rpc("start_live_lead_import", {
      sheet_filename: filename, row_count: body.totalRows, duplicates: body.duplicates,
    });
    dbError(error);
    return NextResponse.json({ sheet: data }, { status: 201 });
  } catch (error) { return jsonError(error); }
}
