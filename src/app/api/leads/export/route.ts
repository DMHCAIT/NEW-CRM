import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { leadColumns, REPORT_COLUMNS } from "@/lib/reports";
import { fetchLeadConfiguration } from "@/lib/live-leads";
import { checkOrigin } from "@/lib/server/login";
import { parseQueryFilter, queryParameters } from "@/lib/server/lead-query";
import { leadCsvResponse } from "@/lib/server/lead-export";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.view");
    if (!["admin", "super_admin"].includes(user.profile.role)) throw new HttpError(403, "Lead exports are restricted to Admins and Super Admins.");
    const body = await readJson<{ filter: unknown; timezone?: string; dashboard?: boolean }>(request);
    const filter = parseQueryFilter(body.filter);
    const params = new URLSearchParams({ timezone: body.timezone ?? "UTC", dashboard: body.dashboard ? "1" : "0" });
    const configuration = await fetchLeadConfiguration(supabase);
    const customColumns = leadColumns(configuration.fields).filter(column => column.key.startsWith("custom:"));
    return await leadCsvResponse(supabase, { ...queryParameters(params), filter }, { id: "", name: "leads", filter, columns: REPORT_COLUMNS.map(c => c.key) }, "leads.csv", request.signal, customColumns);
  } catch (error) { return jsonError(error); }
}
