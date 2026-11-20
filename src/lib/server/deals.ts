import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { databaseError } from "@/lib/server/operational";
import { dealPageSize, dealRecordSchema, type DealSnapshotRecord, type DealStage } from "@/lib/deals";

const pageSize = dealPageSize;
const scanSize = 500;
const fields = "id,name,email,phone,course,stage_id,created_at";
const timestamp = z.string().datetime({ offset: true });
const recordSchema = dealRecordSchema;
const projectionSchema = z.object({
  id: z.string(), created_at: timestamp,
  conversion: z.array(z.object({ created_at: timestamp })).max(1),
});
type Stage = DealStage;
type DateRange = { from: string; to: string; timezone: string };

function readResult<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new HttpError(500, "Deal results could not be loaded. Please retry.");
  return parsed.data;
}

function exactCount(count: number | null) {
  if (count === null) throw new HttpError(500, "Deal totals could not be loaded. Please retry.");
  return count;
}

function stageEntryFilter(stageId: string) {
  return `type.eq.created,and(type.eq.updated,meta->previous_stage_id.not.is.null,or(meta->>previous_stage_id.is.null,meta->>previous_stage_id.neq.${stageId}))`;
}

export async function fetchDealSnapshot(supabase: SupabaseClient, stages: Stage[]): Promise<DealSnapshotRecord[] | null> {
  const selected = stages.filter(stage => ["closed won", "already enrolled"].includes(stage.name.toLowerCase()));
  if (!selected.length) return [];
  const stageIds = selected.map(stage => z.string().uuid().parse(stage.id));
  const aliases = selected.map((_, index) => `conversion_${index}`);
  const conversionSchema = z.array(z.object({ created_at: timestamp })).max(1);
  const rows: DealSnapshotRecord[] = [];
  let available: number;
  do {
    let query = supabase.from("leads")
      .select(`${fields},${aliases.map(alias => `${alias}:activities(created_at)`).join(",")}`, { count: "exact" })
      .in("stage_id", stageIds).eq("is_archived", false).is("merged_into_id", null);
    for (const [index, stageId] of stageIds.entries()) {
      const alias = aliases[index];
      query = query.eq(`${alias}.meta->>stage_id`, stageId).or(stageEntryFilter(stageId), { referencedTable: alias })
        .order("created_at", { referencedTable: alias, ascending: false }).order("id", { referencedTable: alias, ascending: false })
        .limit(1, { referencedTable: alias });
    }
    const { data, error, count } = await query.order("created_at", { ascending: false }).order("id", { ascending: false }).range(rows.length, 500);
    databaseError(error);
    available = exactCount(count);
    if (available > 500) return null;
    const records = readResult(recordSchema.passthrough().array(), data);
    if (!records.length && rows.length < available) throw new HttpError(500, "Deals could not be fully loaded. Please retry.");
    for (const record of records) {
      const index = stageIds.indexOf(record.stage_id);
      if (index < 0) throw new HttpError(500, "Unexpected deal stage. Please retry.");
      const conversion = readResult(conversionSchema, record[aliases[index]]);
      rows.push({ ...readResult(recordSchema, record), converted_at: conversion[0]?.created_at ?? null });
    }
  } while (rows.length < available);
  return rows;
}

export async function fetchDealPage(supabase: SupabaseClient, stages: Stage[], page: number, dates: DateRange | null) {
  const selected = stages.filter(stage => ["closed won", "already enrolled"].includes(stage.name.toLowerCase()));
  const stageIds = selected.map(stage => stage.id);
  if (!stageIds.length) return { leads: [], counts: [] };
  const offset = (page - 1) * pageSize;
  const base = (columns: string, count?: "exact") => supabase.from("leads").select(columns, { count })
    .in("stage_id", stageIds).eq("is_archived", false).is("merged_into_id", null);
  if (!dates) {
    const [records, counts] = await Promise.all([
      base(fields).order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + pageSize),
      Promise.all(selected.map(async stage => {
        const { count, error } = await supabase.from("leads").select("id", { count: "exact", head: true })
          .eq("stage_id", stage.id).eq("is_archived", false).is("merged_into_id", null);
        databaseError(error);
        return { stage_id: stage.id, total: exactCount(count) };
      })),
    ]);
    databaseError(records.error);
    return { leads: readResult(recordSchema.array(), records.data), counts };
  }

  // Widen UTC bounds for timezone offsets, then check exact local dates against the latest entry.
  const earliest = new Date(`${dates.from}T00:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - 1);
  const latest = new Date(`${dates.to}T00:00:00Z`);
  latest.setUTCDate(latest.getUTCDate() + 2);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: dates.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const scanned = await Promise.all(selected.map(async stage => {
    const stageId = z.string().uuid().parse(stage.id);
    const matches: z.infer<typeof projectionSchema>[] = [];
    let total = 0;
    let from = 0;
    let available: number;
    do {
      const entryFilter = stageEntryFilter(stageId);
      let query = base("id,created_at,candidate:activities!inner(),conversion:activities(created_at)", "exact").eq("stage_id", stageId);
      for (const alias of ["candidate", "conversion"]) {
        query = query.eq(`${alias}.meta->>stage_id`, stageId).or(entryFilter, { referencedTable: alias });
      }
      if (earliest.getUTCFullYear() > 0) query = query.gte("candidate.created_at", earliest.toISOString());
      if (latest.getUTCFullYear() <= 9999) query = query.lt("candidate.created_at", latest.toISOString());
      // Only candidates are date-bounded: a later re-entry must still supersede an earlier conversion.
      const { data, error, count } = await query
        .order("created_at", { referencedTable: "conversion", ascending: false })
        .order("id", { referencedTable: "conversion", ascending: false })
        .limit(1, { referencedTable: "conversion" })
        .order("created_at", { ascending: false }).order("id", { ascending: false })
        .range(from, from + scanSize - 1);
      databaseError(error);
      const records = readResult(projectionSchema.array(), data);
      available = exactCount(count);
      if (!records.length && from < available) throw new HttpError(500, "Conversion dates could not be fully loaded. Please retry.");
      from += records.length;
      for (const record of records) {
        const conversion = record.conversion[0];
        if (!conversion) continue;
        const parts = formatter.formatToParts(new Date(conversion.created_at));
        const day = ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value.padStart(type === "year" ? 4 : 2, "0")).join("-");
        if (day < dates.from || day > dates.to) continue;
        total++;
        if (matches.length < offset + pageSize + 1) matches.push(record);
      }
    } while (from < available);
    return { stage_id: stageId, total, matches };
  }));
  const ids = scanned.flatMap(stage => stage.matches)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id))
    .slice(offset, offset + pageSize + 1).map(record => record.id);
  const counts = scanned.map(({ stage_id, total }) => ({ stage_id, total }));
  if (!ids.length) return { leads: [], counts };
  const { data, error } = await base(fields).in("id", ids)
    .order("created_at", { ascending: false }).order("id", { ascending: false });
  databaseError(error);
  return { leads: readResult(recordSchema.array(), data), counts };
}
