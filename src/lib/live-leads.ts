import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CurrentUser } from "@/lib/types";
import { DEFAULT_LEAD_PICKLISTS } from "@/lib/lead-picklists";

export const leadConfiguration = z.object({
  duplicateFields: z.enum(["phone_email", "phone", "email"]).default("phone_email"),
  creationPolicy: z.enum(["block", "warn", "allow"]).default("block"),
  fields: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    active: z.boolean(),
    type: z.enum(["text", "dropdown"]).default("text"),
    options: z.array(z.string().trim().min(1).max(200)).max(400).default([]),
  })).max(100).default([]),
  picklists: z.object({
    countryCode: z.array(z.string().trim().min(1).max(160)).default(DEFAULT_LEAD_PICKLISTS.countryCode),
    country: z.array(z.string().trim().min(1).max(100)).default(DEFAULT_LEAD_PICKLISTS.country),
    qualification: z.array(z.string().trim().min(1).max(100)).default(DEFAULT_LEAD_PICKLISTS.qualification),
    category: z.array(z.string().trim().min(1).max(100)).default(DEFAULT_LEAD_PICKLISTS.category),
    course: z.array(z.string().trim().min(1).max(200)).default(DEFAULT_LEAD_PICKLISTS.course),
    source: z.array(z.string().trim().min(1).max(100)).default(DEFAULT_LEAD_PICKLISTS.source),
  }).default(DEFAULT_LEAD_PICKLISTS),
});
export type LeadConfiguration = z.infer<typeof leadConfiguration>;
export async function fetchLeadConfiguration(client: SupabaseClient): Promise<LeadConfiguration> {
  const { data, error } = await client.from("crm_settings").select("value").eq("setting_key", "lead_configuration").maybeSingle();
  dbError(error);
  const parsed = leadConfiguration.safeParse(data?.value ?? {});
  if (!parsed.success) throw new HttpError(500, "Lead configuration is invalid. Contact an administrator.");
  return parsed.data;
}

export const leadInput = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(7).max(30).refine((v) => /^\+?[\d\s().-]+$/.test(v) && v.replace(/\D/g, "").length >= 7, "Invalid phone"),
  countryCode: z.string().trim().max(160).optional().default(""),
  altPhone: z.string().trim().max(30).optional().default(""),
  email: z.union([z.literal(""), z.string().trim().email().max(254)]).optional().default(""),
  country: z.string().trim().max(100).optional().default(""),
  course: z.string().trim().max(200).optional().default(""),
  qualification: z.string().trim().max(200).optional().default(""),
  category: z.string().trim().max(100).optional().default(""),
  source: z.string().trim().min(1).max(100).optional().default("manual"),
  stageId: z.string().uuid().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  followUpAt: z.union([z.literal(""), z.string().datetime({ offset: true })]).nullable().optional(),
  closureFee: z.number().finite().min(0).max(9999999999.99).optional().default(0),
  customFields: z.record(z.string().max(100), z.string().max(2000)).refine((v) => Object.keys(v).length <= 100, "Too many custom fields").optional().default({}),
}).strict();

export function normalizePhone(phone: string, countryCode = "") {
  const digits = phone.replace(/\D/g, "");
  const code = (countryCode.match(/\(([^)]+)\)/)?.[1]?.split("/")[0] ?? "").replace(/\D/g, "");
  return code && !digits.startsWith(code) ? `${code}${digits}` : digits;
}

export function parseLead(value: unknown) {
  const result = leadInput.safeParse(value);
  if (!result.success) throw new HttpError(400, result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const v = result.data;
  const normalizedPhone = normalizePhone(v.phone, v.countryCode);
  return {
    name: v.name, phone: v.phone, country_code: v.countryCode || null, normalized_phone: normalizedPhone,
    alt_phone: v.altPhone || null, email: v.email || null, normalized_email: v.email?.toLowerCase() || null,
    country: v.country || null, course: v.course || null, qualification: v.qualification || null, category: v.category || null,
    source: v.source, stage_id: v.stageId, assignee_id: v.assigneeId,
    next_followup_at: v.followUpAt || null, closure_fee: v.closureFee, custom_fields: v.customFields,
  };
}

export function validateNewLeadFields(input: ReturnType<typeof parseLead>, config: LeadConfiguration) {
  const required: [string, string, string[]][] = [
    ["email", input.email ?? "", []],
    ["countryCode", input.country_code ?? "", config.picklists.countryCode],
    ["country", input.country ?? "", config.picklists.country],
    ["qualification", input.qualification ?? "", config.picklists.qualification],
    ["category", input.category ?? "", config.picklists.category],
    ["course", input.course ?? "", config.picklists.course],
    ["source", input.source, config.picklists.source],
  ];
  for (const [field, value, options] of required) {
    if (!value) throw new HttpError(400, `${field} is required.`);
    if (options.length && !options.includes(value)) throw new HttpError(400, `Choose a valid ${field}.`);
  }
  if (!input.stage_id) throw new HttpError(400, "Stage is required.");
}

export function uuid(value: string) {
  if (!z.string().uuid().safeParse(value).success) throw new HttpError(400, "Invalid record ID.");
  return value;
}

export function dbError(error: { message: string } | null) {
  if (error) throw new HttpError(400, error.message);
}

export function validateCustomFields(fields: Record<string, string>, config: LeadConfiguration, previous: Record<string, string> = {}) {
  const definitions = new Map(config.fields.map((field) => [field.name, field]));
  for (const [key, value] of Object.entries(fields)) {
    const definition = definitions.get(key);
    if ((!definition?.active || !definition) && previous[key] !== value) throw new HttpError(400, `Custom field "${key}" is not active.`);
    if (definition?.active && definition.type === "dropdown" && value && !definition.options.includes(value) && previous[key] !== value)
      throw new HttpError(400, `Choose a valid value for "${key}".`);
  }
}

type DuplicateKey = { normalized_phone: string; normalized_email: string | null };
export function duplicateRows(rows: DuplicateKey[], config: LeadConfiguration) {
  const phones = new Set<string>(), emails = new Set<string>();
  for (const row of rows) {
    if (config.duplicateFields !== "email" && phones.has(row.normalized_phone)) return true;
    if (config.duplicateFields !== "phone" && row.normalized_email && emails.has(row.normalized_email)) return true;
    phones.add(row.normalized_phone); if (row.normalized_email) emails.add(row.normalized_email);
  }
  return false;
}

export async function enforceDuplicatePolicy(client: SupabaseClient, rows: DuplicateKey[], _config: LeadConfiguration, user: CurrentUser, confirmed: boolean) {
  // The database helper checks global matches without exposing out-of-scope records.
  const { data, error } = await client.rpc("check_live_lead_duplicates", { rows_json: rows });
  dbError(error);
  if (data === "block") throw new HttpError(409, "Duplicate lead blocked by CRM configuration.");
  if (data === "warn" && (!confirmed || !["admin", "super_admin"].includes(user.profile.role))) throw new HttpError(409, "Duplicate warning: matching leads exist. Only an administrator can explicitly confirm creating duplicates.");
  if (!["clear", "warn", "block"].includes(data)) throw new HttpError(500, "Duplicate policy could not be checked.");
}
