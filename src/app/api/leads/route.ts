import { NextResponse } from "next/server";
import { fetchProfiles, fetchStages } from "@/lib/crm-data";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { dbError, enforceDuplicatePolicy, fetchLeadConfiguration, parseLead, validateCustomFields, validateNewLeadFields } from "@/lib/live-leads";
import { checkOrigin } from "@/lib/server/login";
import { isSavedLeadFilter, renameLegacyUntouchedOperators } from "@/lib/lead-filters";
import { fetchLeadPage, fetchLeadPages, queryParameters } from "@/lib/server/lead-query";

export async function GET(request: Request) {
  const started = Date.now();
  try {
    const params = new URL(request.url).searchParams;
    const view = params.get("view");
    const { supabase, user } = await requireUser(view === "pipeline" ? "pipeline.view" : "leads.view");
    const authenticated = Date.now();
    const respond = (data: unknown) => NextResponse.json(data, { headers: {
      "Cache-Control": "private, no-store",
      "Server-Timing": `auth;dur=${authenticated - started}, data;dur=${Date.now() - authenticated}`,
    } });
    const query = queryParameters(params);
    const requestedPageSize = params.has("pageSize") ? Number(params.get("pageSize")) : 50;
    if (![10, 20, 50, 100].includes(requestedPageSize)) throw new HttpError(400, "Choose a page size of 10, 20, 50 or 100.");
    if (params.get("metadata") === "0" || query.countOnly) return respond(await fetchLeadPage(supabase, query, view === "pipeline" ? 25 : requestedPageSize));
    if (view === "pipeline") {
      const stagesRequest = fetchStages(supabase);
      const [stages, profiles, stagePages] = await Promise.all([
        stagesRequest, fetchProfiles(supabase),
        stagesRequest.then(async stages => {
          const groups = [...stages.map(stage => stage.id), "__none"].filter(stage => !query.stage || stage === query.stage);
          const pages = await fetchLeadPages(supabase, groups.map(stage => ({ ...query, stage })), 25);
          return pages.map((page, index) => ({ stage: groups[index], ...page }));
        }),
      ]);
      return respond({ leads: stagePages.flatMap(group => group.leads), hasMore: false, nextCursor: null, stagePages, stages, profiles, user });
    }
    const [page, stages, profiles, filters, columns, configuration] = await Promise.all([
      params.get("metadata") === "only" ? Promise.resolve({ leads: [], hasMore: false, nextCursor: null }) : fetchLeadPage(supabase, query, requestedPageSize),
      fetchStages(supabase), fetchProfiles(supabase),
      supabase.from("saved_filters").select("id,name,filter_json,pinned_to_dashboard").eq("owner_id", user.id).order("created_at"),
      supabase.from("user_columns").select("columns_json").eq("user_id", user.id).eq("view_name", "leads").maybeSingle(),
      fetchLeadConfiguration(supabase),
    ]);
    dbError(filters.error); dbError(columns.error);
    const savedFilters = filters.data?.map((row) => {
      const filter = renameLegacyUntouchedOperators(row.filter_json);
      if (!isSavedLeadFilter(filter)) throw new HttpError(400, `Saved filter "${row.name}" has invalid configuration.`);
      return { ...row, filter_json: filter };
    });
    return respond({ ...page, stages, profiles, filters: savedFilters, columns: columns.data?.columns_json ?? null, configuration, user });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.create");
    const { duplicateOverride, ...body } = await readJson<Record<string, unknown>>(request);
    const input = parseLead(body);
    const configuration = await fetchLeadConfiguration(supabase);
    validateNewLeadFields(input, configuration);
    const activeStages = await fetchStages(supabase);
    if (!activeStages.some((stage) => stage.id === input.stage_id)) throw new HttpError(400, "Choose an active stage.");
    validateCustomFields(input.custom_fields, configuration);
    if (input.assignee_id && input.assignee_id !== user.id && !user.permissions.includes("leads.assign")) throw new HttpError(403, "Assignment permission is required.");
    await enforceDuplicatePolicy(supabase, [input], configuration, user, duplicateOverride === true);
    const { data, error } = await supabase.from("leads").insert({ ...input, assignee_id: input.assignee_id ?? user.id, created_by: user.id, modified_by: user.id }).select("id").single();
    dbError(error);
    return NextResponse.json(data, { status: 201 });
  } catch (error) { return jsonError(error); }
}
