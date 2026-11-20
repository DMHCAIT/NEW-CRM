import type { SupabaseClient } from "@supabase/supabase-js";
import { dealConversionRange, parseDealQuery } from "@/lib/deal-filters";
import { filterDealSnapshot, type DealWorkspaceData } from "@/lib/deals";
import { HttpError } from "@/lib/server/auth";
import { fetchDealPage, fetchDealSnapshot } from "@/lib/server/deals";
import { databaseError } from "@/lib/server/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import type { CurrentUser } from "@/lib/types";

export async function fetchDealWorkspace(supabase: SupabaseClient, user: CurrentUser, search: URLSearchParams): Promise<DealWorkspaceData> {
  if (!["accounts", "admin", "super_admin"].includes(user.profile.role)) throw new HttpError(403, "You do not have permission to view deals.");
  const parsed = parseDealQuery(search);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(issue => issue.message).join(" "));
  const { filters, page } = parsed.data;
  const timezone = process.env.CRM_TIMEZONE || "Asia/Kolkata";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const today = ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  const { data, error } = await getSupabaseAdminClient().from("lead_stages").select("id,name");
  databaseError(error);
  const stages = (data ?? []).filter(stage => ["closed won", "already enrolled"].includes(stage.name.toLowerCase()));
  const snapshot = await fetchDealSnapshot(supabase, stages);
  const dates = dealConversionRange(filters, today);
  const selected = stages.filter(stage => filters.stage === "all" || stage.name.toLowerCase() === filters.stage.replaceAll("_", " "));
  const result = snapshot ? filterDealSnapshot(snapshot, stages, filters, page, today, timezone)
    : await fetchDealPage(supabase, selected, page, dates ? { ...dates, timezone } : null);
  return { result, snapshot, stages, filters, page, timezone, today, loadedAt: Date.now() };
}
