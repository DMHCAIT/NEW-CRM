import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => issue.message).join(" "));
  return result.data;
}

export function databaseError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

export const uuid = z.string().uuid();

export async function accessibleLead(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase.from("leads").select("id,name,email,assignee_id").eq("id", id).eq("is_archived", false).is("merged_into_id", null).maybeSingle();
  databaseError(error);
  if (!data) throw new HttpError(404, "Lead not found or not accessible.");
  return data;
}

export async function leadOptions(supabase: SupabaseClient) {
  const { data, error } = await supabase.from("leads").select("id,name").eq("is_archived", false).is("merged_into_id", null).order("name").limit(500);
  databaseError(error);
  return data ?? [];
}

export const integrationRequirements = {
  zoom: ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"],
  razorpay: ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET"],
  smtp: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"],
};

export function configurationStatus(names: string[]) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  return { configured: missing.length === 0, required: names, missing };
}
