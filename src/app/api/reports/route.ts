import { NextResponse } from "next/server";
import { HttpError, jsonError, readJson, requireString, requireUser } from "@/lib/server/auth";
import { dbError, uuid } from "@/lib/live-leads";
import { criterionError, isSavedLeadFilter, renameLegacyUntouchedOperators } from "@/lib/lead-filters";
import { REPORT_COLUMNS } from "@/lib/reports";
import { checkOrigin } from "@/lib/server/login";

export async function GET() {
  try {
    const { supabase, user } = await requireUser("reports.view");
    const [reports, filters] = await Promise.all([
      supabase.from("saved_reports").select("id,name,filter_json,columns_json,created_at").eq("user_id", user.id).order("created_at", { ascending: false }),
      supabase.from("saved_filters").select("id,name,filter_json").eq("owner_id", user.id).order("created_at"),
    ]);
    dbError(reports.error); dbError(filters.error);
    const savedFilters = filters.data?.map((row) => {
      const filter = renameLegacyUntouchedOperators(row.filter_json);
      if (!isSavedLeadFilter(filter)) throw new HttpError(400, `Saved filter "${row.name}" has invalid configuration.`);
      return { ...row, filter_json: filter };
    });
    const savedReports = reports.data?.map((r) => {
      const filter = renameLegacyUntouchedOperators(r.filter_json);
      if (!isSavedLeadFilter(filter) || !Array.isArray(r.columns_json) || !r.columns_json.length || !r.columns_json.every((key: unknown) => REPORT_COLUMNS.some((c) => c.key === key))) throw new HttpError(400, `Saved report "${r.name}" has invalid configuration.`);
      return { id: r.id, name: r.name, filter, columns: r.columns_json, savedAt: r.created_at };
    });
    return NextResponse.json({ user, filters: savedFilters, reports: savedReports });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("reports.view");
    const body = await readJson<Record<string, unknown>>(request);
    if (!isSavedLeadFilter(body.filter) || body.filter.criteria.some(criterionError)) throw new HttpError(400, "Invalid report filter.");
    if (!Array.isArray(body.columns) || !body.columns.length || !body.columns.every((key) => REPORT_COLUMNS.some((c) => c.key === key))) throw new HttpError(400, "Invalid report columns.");
    const { data, error } = await supabase.from("saved_reports").insert({
      id: typeof body.id === "string" ? uuid(body.id) : undefined, user_id: user.id,
      name: requireString(body.name, "Report name", 120), filter_json: body.filter, columns_json: body.columns,
    }).select("id").single();
    dbError(error);
    return NextResponse.json(data, { status: 201 });
  } catch (error) { return jsonError(error); }
}

export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("reports.view");
    const body = await readJson<{ id: string }>(request);
    dbError((await supabase.from("saved_reports").delete().eq("id", uuid(body.id)).eq("user_id", user.id)).error);
    return NextResponse.json({ ok: true });
  } catch (error) { return jsonError(error); }
}
