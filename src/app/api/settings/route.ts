import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchStages } from "@/lib/crm-data";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";
import { fetchLeadConfiguration } from "@/lib/live-leads";
import { LEAD_PICKLIST_KEYS } from "@/lib/lead-picklists";

const picklistSchema = (max: number, maxLength: number) => z.array(z.string().trim().min(1).max(maxLength))
  .min(1).max(max).transform((values) => values.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
const sortPicklists = (picklists: Record<(typeof LEAD_PICKLIST_KEYS)[number], string[]>) =>
  Object.fromEntries(LEAD_PICKLIST_KEYS.map((key) => [key, [...picklists[key]].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))]));

const settingsSchema = z.object({
  stages: z.array(z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(100), is_terminal: z.boolean() })).min(1).max(100),
  settings: z.object({
    duplicateFields: z.enum(["phone_email", "phone", "email"]),
    creationPolicy: z.enum(["block", "warn", "allow"]),
    fields: z.array(z.object({
      name: z.string().trim().min(1).max(100),
      active: z.boolean(),
      type: z.enum(["text", "dropdown"]).default("text"),
      options: z.array(z.string().trim().min(1).max(200)).max(400).default([]),
    }).superRefine((field, context) => {
      if (field.type === "dropdown" && field.options.length === 0)
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Dropdown field "${field.name}" needs at least one value.` });
      if (new Set(field.options.map((value) => value.toLocaleLowerCase())).size !== field.options.length)
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Dropdown values for "${field.name}" must be unique.` });
    })).max(100),
    picklists: z.object({
      countryCode: picklistSchema(400, 160),
      country: picklistSchema(400, 100),
      qualification: picklistSchema(100, 100),
      category: picklistSchema(100, 100),
      course: picklistSchema(400, 200),
      source: picklistSchema(200, 100),
    }),
  }),
});

export async function GET() {
  try {
    const { supabase, user } = await requireUser("settings.manage");
    const [stages, settings] = await Promise.all([fetchStages(supabase), fetchLeadConfiguration(supabase)]);
    return NextResponse.json({ stages, settings, canManagePicklists: ["admin", "super_admin"].includes(user.profile.role) });
  } catch (error) { return jsonError(error); }
}

export async function PUT(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("settings.manage");
    const parsed = settingsSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "Check your stage names, field names, and duplicate rules.");
    if (new Set(parsed.data.stages.map((stage) => stage.name.toLowerCase())).size !== parsed.data.stages.length)
      throw new HttpError(400, "Stage names must be unique.");
    if (!parsed.data.stages.some((stage) => stage.name.toLocaleLowerCase() === "fresh" && !stage.is_terminal))
      throw new HttpError(400, "The Fresh stage is required and cannot be terminal.");
    const currentStages = await fetchStages(supabase, { includeInactive: true });
    const stageConfiguration = (values: typeof parsed.data.stages) => values.map(({ id, name, is_terminal }) => ({ id: id ?? "", name: name.trim(), is_terminal }));
    const currentStageConfiguration = currentStages.filter((stage) => stage.is_active).map(({ id, name, is_terminal }) => ({ id, name, is_terminal }));
    if (JSON.stringify(stageConfiguration(parsed.data.stages)) !== JSON.stringify(currentStageConfiguration)
      && !["admin", "super_admin"].includes(user.profile.role))
      throw new HttpError(403, "Only Admins and Super Admins can change dropdown values.");
    for (const values of Object.values(parsed.data.settings.picklists)) {
      if (new Set(values.map((value) => value.toLocaleLowerCase())).size !== values.length)
        throw new HttpError(400, "Dropdown values must be unique.");
    }
    const current = await fetchLeadConfiguration(supabase);
    if (new Set(parsed.data.settings.fields.map((field) => field.name.toLocaleLowerCase())).size !== parsed.data.settings.fields.length)
      throw new HttpError(400, "Lead field names must be unique.");
    if (JSON.stringify(parsed.data.settings.fields) !== JSON.stringify(current.fields)
      && !["admin", "super_admin"].includes(user.profile.role))
      throw new HttpError(403, "Only Admins and Super Admins can add, remove, or configure lead fields.");
    if (JSON.stringify(sortPicklists(parsed.data.settings.picklists)) !== JSON.stringify(sortPicklists(current.picklists))
      && !["admin", "super_admin"].includes(user.profile.role))
      throw new HttpError(403, "Only Admins and Super Admins can change dropdown values.");
    const { error } = await supabase.rpc("save_crm_configuration", { stage_rows: parsed.data.stages, settings_value: parsed.data.settings });
    if (error) throw error;
    return NextResponse.json({ saved: true });
  } catch (error) { return jsonError(error); }
}
