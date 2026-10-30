import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { dbError } from "@/lib/live-leads";
import { HttpError } from "@/lib/server/auth";

const count = z.number().int().nonnegative();
const group = z.object({ name: z.string(), total: count, converted: count, stages: z.record(count) });
const summarySchema = z.object({
  total: count, newToday: count, converted: count, overdue: count, dueToday: count,
  daily: z.record(count),
  stages: z.array(z.object({ stage_id: z.string().nullable(), stage_name: z.string(), total: count })),
  country: z.array(group), course: z.array(group),
  countryLeaders: z.array(group), courseLeaders: z.array(group),
  combinations: z.array(z.object({ country: z.string(), course: z.string(), total: count, converted: count, rate: z.number() })),
});

export async function fetchDashboardSummary(client: SupabaseClient) {
  const { data, error } = await client.rpc("crm_dashboard_summary");
  dbError(error);
  const parsed = summarySchema.safeParse(data);
  if (!parsed.success) throw new HttpError(500, "Invalid dashboard summary.");
  return parsed.data;
}
