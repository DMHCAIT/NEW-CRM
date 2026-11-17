import { z } from "zod";
import { countryCodeMatchesOptions } from "@/lib/lead-phone";
import type { LeadConfiguration } from "@/lib/live-leads";

export const leadInput = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(7).max(30).refine((v) => /^\+?[\d\s().-]+$/.test(v) && v.replace(/\D/g, "").length >= 7, "Invalid phone"),
  countryCode: z.string().trim().max(160).optional().default(""),
  altPhone: z.string().trim().max(30).optional().default(""),
  email: z.string().trim().max(254).refine(value => !value || value.includes("@"), "Invalid email").optional().default(""),
  country: z.string().trim().max(100).optional().default(""),
  billingAddress: z.string().trim().max(2000).optional().default(""),
  course: z.string().trim().max(200).optional().default(""),
  qualification: z.string().trim().max(200).optional().default(""),
  speciality: z.string().trim().max(200).optional().default(""),
  category: z.string().trim().max(100).optional().default(""),
  source: z.string().trim().min(1).max(100).optional().default("manual"),
  stageId: z.string().uuid().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  followUpAt: z.union([z.literal(""), z.string().datetime({ offset: true })]).nullable().optional(),
  closureFee: z.number().finite().min(0).max(9999999999.99).optional().default(0),
  expectedClosureDate: z.union([z.literal(""), z.string().date()]).nullable().optional(),
  customFields: z.record(z.string().max(100), z.string().max(2000)).refine((v) => Object.keys(v).length <= 100, "Too many custom fields").optional().default({}),
}).strict();

export function sanitizeLeadImportCells(source: Record<string, unknown>, configuration: Pick<LeadConfiguration, "fields" | "picklists">) {
  const values = { ...source };
  let clearedCells = 0;
  for (const key of [
    "countryCode", "altPhone", "country", "billingAddress", "course", "qualification",
    "speciality", "category", "source", "followUpAt", "closureFee", "expectedClosureDate",
  ] as const) {
    const parsed = leadInput.shape[key].safeParse(values[key]);
    if (!parsed.success) {
      values[key] = key === "closureFee" ? 0 : key === "source" ? "import" : "";
      clearedCells++;
    } else {
      values[key] = parsed.data;
    }
  }
  const countryCode = String(values.countryCode ?? "");
  const countryCodes = configuration.picklists.countryCode;
  if (countryCode && countryCodes.length && !countryCodes.includes(countryCode) && !countryCodeMatchesOptions(countryCode, countryCodes)) {
    values.countryCode = "";
    clearedCells++;
  }
  const note = typeof source.note === "string" ? source.note.trim() : "";
  values.note = note.length <= 10000 ? note : "";
  if (note.length > 10000 || (source.note != null && typeof source.note !== "string")) clearedCells++;

  const definitions = new Map(configuration.fields.filter(field => field.active).map(field => [field.name, field]));
  const customFields = source.customFields && typeof source.customFields === "object" && !Array.isArray(source.customFields)
    ? source.customFields : {};
  values.customFields = Object.fromEntries(Object.entries(customFields).flatMap(([key, value]) => {
    const definition = definitions.get(key);
    if (!definition || key.length > 100) {
      clearedCells++;
      return [];
    }
    if (typeof value !== "string" || value.length > 2000 || (definition.type === "dropdown" && value && !definition.options.includes(value))) {
      clearedCells++;
      return [[key, ""]];
    }
    return [[key, value]];
  }));
  return { values, clearedCells };
}
