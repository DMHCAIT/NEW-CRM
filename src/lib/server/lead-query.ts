import type { SupabaseClient } from "@supabase/supabase-js";
import { LEAD_SELECT, mapLead, type LeadRow } from "@/lib/crm-data";
import { criterionError, dateRange, isSavedLeadFilter, localDateKey, type SavedLeadFilter } from "@/lib/lead-filters";
import { HttpError } from "@/lib/server/auth";
import { dbError } from "@/lib/live-leads";

export const DEFAULT_FILTER: SavedLeadFilter = {
  id: "", name: "", criteria: [], matchMode: "all", query: "", quickView: "All accessible leads",
};
export type LeadCursor = { createdAt: string; id: string; name?: string; followUpAt?: string | null };
export type LeadPage = { leads: ReturnType<typeof mapLead>[]; hasMore: boolean; nextCursor: LeadCursor | null; total?: number };

export function parseQueryFilter(value: unknown): SavedLeadFilter {
  if (!isSavedLeadFilter(value) || value.criteria.length > 100 || value.query.length > 500
    || value.criteria.some(c => c.value.length > 10000 || criterionError(c))) {
    throw new HttpError(400, "Invalid lead filter. Complete each condition before applying it.");
  }
  return value;
}

export function queryParameters(params: URLSearchParams) {
  let filter: unknown = DEFAULT_FILTER;
  let cursor: unknown = null;
  try {
    if (params.has("filter")) filter = JSON.parse(params.get("filter")!);
    if (params.has("cursor")) cursor = JSON.parse(params.get("cursor")!);
  } catch { throw new HttpError(400, "Invalid lead query."); }
  if (cursor !== null && (typeof cursor !== "object" || !("id" in cursor) || !("createdAt" in cursor)
    || typeof cursor.id !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(cursor.id)
    || typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt)))) {
    throw new HttpError(400, "Invalid page cursor.");
  }
  const timezone = params.get("timezone") || "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); }
  catch { throw new HttpError(400, "Invalid time zone."); }
  const offset = Number(params.get("offset") ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new HttpError(400, "Invalid page offset.");
  const sort = params.get("sort") ?? "newest";
  if (!["newest", "name", "followUp"].includes(sort)) throw new HttpError(400, "Invalid lead sort.");
  if (cursor && sort !== "newest" && (!("name" in cursor) || typeof cursor.name !== "string"
    || (sort === "followUp" && (!("followUpAt" in cursor) || (cursor.followUpAt !== null
      && (typeof cursor.followUpAt !== "string" || !Number.isFinite(Date.parse(cursor.followUpAt)))))))) {
    throw new HttpError(400, "Invalid sort cursor.");
  }
  return {
    filter: parseQueryFilter(filter), cursor: cursor as LeadCursor | null,
    timezone, dashboard: params.get("dashboard") === "1",
    countOnly: params.get("count") === "1", offset,
    owner: params.get("owner") ?? "", stage: params.get("stage") ?? "", sort,
  };
}

export type LeadQuery = ReturnType<typeof queryParameters>;

// Resolve relative dates in the requested timezone, including around UTC midnight.
export function databaseFilter(filter: SavedLeadFilter, timezone: string, dashboard = false, now = new Date()) {
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => key.find(p => p.type === type)!.value;
  const localNow = new Date(Number(part("year")), Number(part("month")) - 1, Number(part("day")), 12);
  return { ...filter, dashboard, criteria: filter.criteria.map(c => {
    if (c.field === "untouched") return c;
    const range = dateRange(c.operator, c.value, localNow);
    if (range) return { ...c, operator: "between", value: range[0], secondValue: range[1] };
    if (c.operator === "overdue") return { ...c, operator: "before", value: localDateKey(localNow) };
    return c;
  }) };
}

export async function fetchLeadPage(client: SupabaseClient, query: LeadQuery, pageSize = 50): Promise<LeadPage> {
  const { data, error } = await client.rpc("crm_lead_page", {
    filter_json: databaseFilter(query.filter, query.dashboard ? "UTC" : query.timezone, query.dashboard),
    timezone_name: query.dashboard ? "UTC" : query.timezone,
    page_size: pageSize, after_created: query.cursor?.createdAt ?? null, after_id: query.cursor?.id ?? null,
    count_only: query.countOnly, owner_filter: query.owner, stage_filter: query.stage,
    sort_key: query.sort, page_offset: query.offset, sort_cursor: query.cursor ?? {},
  });
  dbError(error);
  if (!data || !Array.isArray(data.ids) || data.ids.length > pageSize || !data.ids.every((id: unknown) => typeof id === "string")
    || typeof data.hasMore !== "boolean" || (query.countOnly && !Number.isSafeInteger(data.total))) {
    throw new HttpError(500, "Invalid lead query response.");
  }
  const ids: string[] = data.ids;
  const cursor = data.nextCursor;
  if (data.hasMore && (!cursor || typeof cursor.id !== "string" || typeof cursor.createdAt !== "string"
    || !Number.isFinite(Date.parse(cursor.createdAt)))) throw new HttpError(500, "Invalid lead page cursor.");
  if (!ids.length) return { leads: [], hasMore: false, nextCursor: null, ...(query.countOnly ? { total: data.total } : {}) };
  const result = await client.from("leads").select(LEAD_SELECT).in("id", ids).eq("is_archived", false).returns<LeadRow[]>();
  dbError(result.error);
  const byId = new Map((result.data ?? []).map(row => [row.id, row]));
  const leads = ids.flatMap(id => { const row = byId.get(id); return row ? [mapLead(row)] : []; });
  return { leads, hasMore: data.hasMore, nextCursor: data.hasMore ? {
    createdAt: cursor.createdAt, id: cursor.id, name: cursor.name, followUpAt: cursor.followUpAt,
  } : null };
}
