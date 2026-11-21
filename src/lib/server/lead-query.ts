import type { SupabaseClient } from "@supabase/supabase-js";
import { LEAD_SELECT, mapLead, type LeadRow } from "@/lib/crm-data";
import { criterionError, dateRange, isSavedLeadFilter, localDateKey, matchesTextCriterion, type SavedLeadFilter } from "@/lib/lead-filters";
import { HttpError } from "@/lib/server/auth";
import { dbError } from "@/lib/live-leads";
import { fetchLeadModifiers, findMatchingModifierIds } from "@/lib/server/lead-modifiers";

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
    if (c.field === "recentVisitSource") return { ...c, field: "source" };
    if (c.field === "untouched") return c;
    const range = dateRange(c.operator, c.value, localNow);
    if (range) return { ...c, operator: "between", value: range[0], secondValue: range[1] };
    if (c.operator === "overdue") return { ...c, operator: "before", value: localDateKey(localNow) };
    return c;
  }) };
}

type LeadPageIds = Omit<LeadPage, "leads"> & { ids: string[] };

async function fetchDatabaseLeadPageIds(client: SupabaseClient, query: LeadQuery, pageSize: number): Promise<LeadPageIds> {
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
  if (!ids.length) return { ids, hasMore: false, nextCursor: null, ...(query.countOnly ? { total: data.total } : {}) };
  return { ids, hasMore: data.hasMore, nextCursor: data.hasMore ? {
    createdAt: cursor.createdAt, id: cursor.id, name: cursor.name, followUpAt: cursor.followUpAt,
  } : null };
}

type ModifierCandidate = { id: string; modified_by: string | null; created_at: string; name: string; next_followup_at: string | null };

async function fetchLeadPageIds(client: SupabaseClient, query: LeadQuery, pageSize: number): Promise<LeadPageIds> {
  const modifierCriteria = query.filter.criteria.filter(criterion => criterion.field === "modifiedBy");
  if (!modifierCriteria.length) return fetchDatabaseLeadPageIds(client, query, pageSize);

  const otherCriteria = query.filter.criteria.filter(criterion => criterion.field !== "modifiedBy");
  if (query.countOnly && !otherCriteria.length && !query.filter.query.trim()
    && !query.dashboard && !query.owner && !query.stage && !query.cursor) {
    let assigneeId: string | undefined;
    if (query.filter.quickView === "My Leads") {
      const { data, error } = await client.auth.getUser();
      dbError(error);
      if (!data.user) throw new HttpError(401, "Sign in to view your leads.");
      assigneeId = data.user.id;
    }
    const { ids, includeEmpty } = await findMatchingModifierIds(modifierCriteria, query.filter.matchMode);
    const batches: (string[] | null)[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) batches.push(ids.slice(offset, offset + 100));
    if (includeEmpty) batches.push(null);
    let total = 0;
    for (let offset = 0; offset < batches.length; offset += 4) {
      const counts = await Promise.all(batches.slice(offset, offset + 4).map(async batch => {
        let request = client.from("leads").select("id", { count: "exact", head: true }).eq("is_archived", false);
        if (assigneeId) request = request.eq("assignee_id", assigneeId);
        request = batch ? request.in("modified_by", batch) : request.is("modified_by", null);
        const { count, error } = await request;
        dbError(error);
        if (!Number.isSafeInteger(count) || count === null || count < 0) throw new HttpError(500, "Invalid lead count response.");
        return count;
      }));
      total += counts.reduce((sum, count) => sum + count, 0);
    }
    if (!Number.isSafeInteger(total)) throw new HttpError(500, "Invalid lead count response.");
    return { ids: [], hasMore: false, nextCursor: null, total };
  }
  const scanQuery: LeadQuery = {
    ...query, countOnly: false, offset: 0,
    filter: { ...query.filter, criteria: query.filter.matchMode === "all" ? otherCriteria : [] },
  };
  const modifiers = await fetchLeadModifiers(client);
  const names = new Map(modifiers.map(modifier => [modifier.modifier_id, modifier.full_name]));
  const otherMatches = new Set<string>();
  if (query.filter.matchMode === "any" && otherCriteria.length) {
    let cursor = query.cursor;
    for (;;) {
      const page = await fetchDatabaseLeadPageIds(client, {
        ...scanQuery, cursor, filter: { ...query.filter, criteria: otherCriteria },
      }, 100);
      page.ids.forEach(id => otherMatches.add(id));
      if (!page.hasMore) break;
      if (!page.nextCursor || page.nextCursor.id === cursor?.id) throw new HttpError(500, "Lead filter pagination did not advance.");
      cursor = page.nextCursor;
    }
  }

  const matched: ModifierCandidate[] = [];
  let total = 0;
  let cursor = query.cursor;
  for (;;) {
    const page = await fetchDatabaseLeadPageIds(client, { ...scanQuery, cursor }, 100);
    if (page.ids.length) {
      const { data, error } = await client.from("leads").select("id,modified_by,created_at,name,next_followup_at")
        .in("id", page.ids).eq("is_archived", false).returns<ModifierCandidate[]>();
      dbError(error);
      if (!Array.isArray(data)) throw new HttpError(500, "Invalid lead filter response.");
      const missing = data.filter(row => row.modified_by && !names.has(row.modified_by)).map(row => row.id);
      if (missing.length) {
        const updated = await fetchLeadModifiers(client, missing);
        updated.forEach(modifier => names.set(modifier.modifier_id, modifier.full_name));
      }
      const rows = new Map(data.map(row => [row.id, row]));
      for (const id of page.ids) {
        const row = rows.get(id);
        if (!row) continue;
        const name = row.modified_by ? names.get(row.modified_by) : "";
        if (name === undefined) throw new HttpError(409, "Lead editors changed while filtering. Refresh and try again.");
        const matches = query.filter.matchMode === "all"
          ? modifierCriteria.every(criterion => matchesTextCriterion(name, criterion))
          : otherMatches.has(id) || modifierCriteria.some(criterion => matchesTextCriterion(name, criterion));
        if (!matches) continue;
        total++;
        if (!query.countOnly && total > query.offset) matched.push(row);
        if (!query.countOnly && matched.length > pageSize) break;
      }
    }
    if ((!query.countOnly && matched.length > pageSize) || !page.hasMore) break;
    if (!page.nextCursor || page.nextCursor.id === cursor?.id) throw new HttpError(500, "Lead filter pagination did not advance.");
    cursor = page.nextCursor;
  }
  if (query.countOnly) return { ids: [], hasMore: false, nextCursor: null, total };
  const hasMore = matched.length > pageSize;
  const last = matched[pageSize - 1];
  return {
    ids: matched.slice(0, pageSize).map(row => row.id), hasMore,
    nextCursor: hasMore ? { id: last.id, createdAt: last.created_at, name: last.name, followUpAt: last.next_followup_at } : null,
  };
}

export async function fetchLeadPages(client: SupabaseClient, queries: LeadQuery[], pageSize = 25, options: { latestNote?: boolean } = {}): Promise<LeadPage[]> {
  const pages = await Promise.all(queries.map(query => fetchLeadPageIds(client, query, pageSize)));
  const ids = [...new Set(pages.flatMap(page => page.ids))];
  const batches: string[][] = [];
  // Bound PostgREST URL length and row counts while sharing reads across stages.
  for (let offset = 0; offset < ids.length; offset += 100) batches.push(ids.slice(offset, offset + 100));
  const records = await Promise.all(batches.map(async batch => {
    let request = client.from("leads").select(options.latestNote ? `${LEAD_SELECT},latest_note:notes(content)` : LEAD_SELECT)
      .in("id", batch).eq("is_archived", false);
    if (options.latestNote) request = request
      .order("created_at", { referencedTable: "latest_note", ascending: false })
      .order("id", { referencedTable: "latest_note", ascending: false })
      .limit(1, { referencedTable: "latest_note" });
    const result = await request.returns<(LeadRow & { latest_note?: { content: string }[] })[]>();
    dbError(result.error);
    const missingModifierIds = (result.data ?? []).filter(row => row.modified_by && !mapLead(row).modifiedBy).map(row => row.id);
    const modifiers = missingModifierIds.length ? await fetchLeadModifiers(client, missingModifierIds) : [];
    const modifierNames = new Map(modifiers.map(modifier => [modifier.modifier_id, modifier.full_name]));
    return (result.data ?? []).map(row => {
      const lead = mapLead(row);
      if (row.modified_by && !lead.modifiedBy) {
        const name = modifierNames.get(row.modified_by);
        if (name === undefined) throw new HttpError(409, "Lead editors changed while loading. Refresh and try again.");
        lead.modifiedBy = name;
      }
      if (!options.latestNote) return lead;
      const note = row.latest_note?.[0];
      return { ...lead, latestNote: note ? note.content || "Image attachment" : undefined };
    });
  }));
  const byId = new Map(records.flat().map(lead => [lead.id, lead]));
  return pages.map(({ ids: pageIds, ...page }) => ({
    ...page, leads: pageIds.flatMap(id => { const lead = byId.get(id); return lead ? [lead] : []; }),
  }));
}

export async function fetchLeadPage(client: SupabaseClient, query: LeadQuery, pageSize = 50): Promise<LeadPage> {
  const [page] = await fetchLeadPages(client, [query], pageSize, { latestNote: true });
  return page;
}
