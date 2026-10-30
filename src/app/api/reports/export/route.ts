import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { dbError, uuid } from "@/lib/live-leads";
import { criterionError, isSavedLeadFilter, renameLegacyUntouchedOperators } from "@/lib/lead-filters";
import { REPORT_COLUMNS, type SavedReport } from "@/lib/reports";
import { checkOrigin } from "@/lib/server/login";
import { fetchLeadPage, queryParameters } from "@/lib/server/lead-query";
import { leadCsvResponse } from "@/lib/server/lead-export";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("reports.export");
    if (!user.permissions.includes("reports.view") || !["manager", "admin", "super_admin"].includes(user.profile.role)) throw new HttpError(403, "Report exports require a Manager, Admin, or Super Admin with report permissions.");
    const body = await readJson<{ id: string; mode: string; timezone?: string }>(request);
    if (!["count", "list"].includes(body.mode)) throw new HttpError(400, "Invalid export mode.");
    const { data, error } = await supabase.from("saved_reports").select("id,name,filter_json,columns_json").eq("id", uuid(body.id)).eq("user_id", user.id).maybeSingle();
    dbError(error);
    if (!data) throw new HttpError(404, "Saved report not found.");
    data.filter_json = renameLegacyUntouchedOperators(data.filter_json);
    if (!isSavedLeadFilter(data.filter_json) || data.filter_json.criteria.some(criterionError) || !Array.isArray(data.columns_json) || !data.columns_json.length || !data.columns_json.every((key: unknown) => REPORT_COLUMNS.some((c) => c.key === key))) throw new HttpError(400, "Saved report has invalid configuration.");
    const report: SavedReport = { id: data.id, name: data.name, filter: data.filter_json, columns: data.columns_json };
    const query = { ...queryParameters(new URLSearchParams({ timezone: body.timezone ?? "UTC" })), filter: report.filter };
    const count = await fetchLeadPage(supabase, { ...query, countOnly: true });
    dbError((await supabase.from("report_downloads").insert({ user_id: user.id, filter_json: { report_id: report.id, filter: report.filter, mode: body.mode, count: count.total }, format: "csv" })).error);
    if (body.mode === "list") return await leadCsvResponse(supabase, query, report, "report.csv", request.signal);
    return new Response(`\uFEFF"Count"\r\n"${count.total}"`, { headers: { "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": 'attachment; filename="report-count.csv"', "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
