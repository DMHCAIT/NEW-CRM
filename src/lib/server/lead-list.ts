import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchProfiles, fetchStages } from "@/lib/crm-data";
import { isSavedLeadFilter, renameLegacyUntouchedOperators } from "@/lib/lead-filters";
import { dbError, fetchLeadConfiguration } from "@/lib/live-leads";
import type { LiveLeadData } from "@/lib/live-leads-client";
import { HttpError } from "@/lib/server/auth";
import { fetchLeadPage, type LeadQuery } from "@/lib/server/lead-query";
import type { CurrentUser } from "@/lib/types";

export async function fetchLeadListData(
  supabase: SupabaseClient, user: CurrentUser, query: LeadQuery, pageSize: number, metadataOnly = false,
): Promise<LiveLeadData> {
  const [page, stages, profiles, filters, columns, configuration] = await Promise.all([
    metadataOnly ? Promise.resolve({ leads: [], hasMore: false, nextCursor: null }) : fetchLeadPage(supabase, query, pageSize),
    fetchStages(supabase), fetchProfiles(supabase),
    supabase.from("saved_filters").select("id,name,filter_json,pinned_to_dashboard").eq("owner_id", user.id).order("created_at"),
    supabase.from("user_columns").select("columns_json").eq("user_id", user.id).eq("view_name", "leads").maybeSingle(),
    fetchLeadConfiguration(supabase),
  ]);
  dbError(filters.error); dbError(columns.error);
  const savedFilters = (filters.data ?? []).map((row) => {
    const filter = renameLegacyUntouchedOperators(row.filter_json);
    if (!isSavedLeadFilter(filter)) throw new HttpError(400, `Saved filter "${row.name}" has invalid configuration.`);
    return { ...row, filter_json: filter };
  });
  return { ...page, stages, profiles, filters: savedFilters, columns: columns.data?.columns_json ?? null, configuration, user };
}
