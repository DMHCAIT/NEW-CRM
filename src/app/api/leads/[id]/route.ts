import { NextResponse } from "next/server";
import { fetchLead, fetchProfiles, fetchStages } from "@/lib/crm-data";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { dbError, fetchLeadConfiguration, parseLead, uuid, validateCustomFields } from "@/lib/live-leads";
import { checkOrigin } from "@/lib/server/login";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const { supabase, user } = await requireUser("leads.view");
    const id = uuid((await context.params).id);
    const lead = await fetchLead(supabase, id);
    if (!lead || lead.isArchived) throw new HttpError(404, "Lead not found.");
    const [stages, profiles, notes, activities, emails, configuration, extras, mailbox, scheduledCalls, duplicates] = await Promise.all([
      fetchStages(supabase), fetchProfiles(supabase),
      supabase.from("notes").select("id,content,created_at,user_id").eq("lead_id", id).order("created_at", { ascending: false }),
      supabase.from("activities").select("id,type,description,meta,created_at,user_id").eq("lead_id", id).order("created_at", { ascending: false }),
      supabase.from("emails").select("id,subject,body,status,from_email,to_email,direction,created_at,user_id").eq("lead_id", id).order("created_at", { ascending: false }),
      fetchLeadConfiguration(supabase),
      supabase.from("leads").select("custom_fields,call_schedule_revision").eq("id", id).single(),
      getSupabaseAdminClient().from("gmail_connections").select("email").eq("user_id", user.id).maybeSingle(),
      supabase.from("scheduled_calls").select("id,user_id,scheduled_at,status,created_at,schedule_revision").eq("lead_id", id).order("scheduled_at", { ascending: true }),
      supabase.rpc("lead_duplicate_owners", { lead_id: id }),
    ]);
    [notes, activities, emails, extras, mailbox, scheduledCalls, duplicates].forEach((r) => dbError(r.error));
    const latestCall = [...(scheduledCalls.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
    const canScheduleCall = !latestCall || latestCall.schedule_revision < extras.data!.call_schedule_revision;
    return NextResponse.json({ lead: { ...lead, customFields: extras.data?.custom_fields ?? {} }, configuration, stages, profiles, notes: notes.data, activities: activities.data, emails: emails.data, mailbox: mailbox.data, scheduledCalls: scheduledCalls.data, canScheduleCall, duplicates: duplicates.data, user });
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.edit");
    const id = uuid((await context.params).id);
    const current = await fetchLead(supabase, id);
    if (!current || current.isArchived) throw new HttpError(404, "Lead not found.");
    const body = await readJson<Record<string, unknown>>(request);
    const extras = await supabase.from("leads").select("custom_fields").eq("id", id).single();
    dbError(extras.error);
    const previousFields = extras.data?.custom_fields ?? {};
    const input = parseLead({
      name: current.name, phone: current.phone, countryCode: current.countryCode ?? "", altPhone: current.altPhone ?? "", email: current.email,
      country: current.country, course: current.course, qualification: current.qualification, category: current.category ?? "", source: current.source,
      stageId: current.stageId ?? null, assigneeId: current.assigneeId ?? null, followUpAt: current.followUpAt ?? null,
      closureFee: current.closureFee, customFields: previousFields, ...body,
    });
    validateCustomFields(input.custom_fields, await fetchLeadConfiguration(supabase), previousFields);
    input.custom_fields = { ...previousFields, ...input.custom_fields };
    if (input.assignee_id !== (current.assigneeId ?? null) && (!user.permissions.includes("leads.assign") || !["team_lead", "manager", "admin", "super_admin"].includes(user.profile.role))) throw new HttpError(403, "Assignment permission and a team lead, manager or administrator role are required.");
    if (Object.hasOwn(body, "stageId") && input.stage_id && !(await fetchStages(supabase)).some(stage => stage.id === input.stage_id)) throw new HttpError(400, "Choose an active CRM stage.");
    const columnInputs: Record<keyof typeof input, string[]> = {
      name: ["name"], phone: ["phone", "countryCode"], normalized_phone: ["phone", "countryCode"], country_code: ["countryCode"],
      alt_phone: ["altPhone"], email: ["email"], normalized_email: ["email"], country: ["country"], course: ["course"],
      qualification: ["qualification"], category: ["category"], source: ["source"], stage_id: ["stageId"],
      assignee_id: ["assigneeId"], next_followup_at: ["followUpAt"], closure_fee: ["closureFee"], custom_fields: ["customFields"],
    };
    const changes = Object.fromEntries(Object.entries(input).filter(([column]) =>
      columnInputs[column as keyof typeof input].some(key => Object.hasOwn(body, key))));
    if (!Object.keys(changes).length) throw new HttpError(400, "No lead fields were supplied.");
    const { data, error } = await supabase.from("leads").update({ ...changes, modified_by: user.id }).eq("id", id).eq("is_archived", false).select("id").maybeSingle();
    dbError(error);
    if (!data) throw new HttpError(403, "Lead update was not permitted.");
    return NextResponse.json(data);
  } catch (error) { return jsonError(error); }
}

export async function DELETE(request: Request, context: Context) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.delete");
    if (!["admin", "super_admin"].includes(user.profile.role)) throw new HttpError(403, "Only admins and super admins can delete leads.");
    const { data, error } = await supabase.from("leads").update({ is_archived: true, modified_by: user.id }).eq("id", uuid((await context.params).id)).eq("is_archived", false).select("id").maybeSingle();
    dbError(error);
    if (!data) throw new HttpError(404, "Lead not found or not permitted.");
    return NextResponse.json({ archived: true });
  } catch (error) { return jsonError(error); }
}
