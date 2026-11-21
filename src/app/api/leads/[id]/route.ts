import { NextResponse } from "next/server";
import { fetchLead, fetchProfiles, fetchStages, LEAD_SELECT, mapLead, type LeadRow } from "@/lib/crm-data";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { dbError, fetchLeadConfiguration, parseLead, uuid, validateCustomFields } from "@/lib/live-leads";
import { checkOrigin } from "@/lib/server/login";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { currentGmailMailbox } from "@/lib/server/operational-gmail";
import { fetchLeadModifiers } from "@/lib/server/lead-modifiers";

type Context = { params: Promise<{ id: string }> };
type SavedLead = LeadRow & { custom_fields: Record<string, string>; call_schedule_revision: number };
type LeadExtras = { custom_fields: Record<string, string>; call_schedule_revision: number; pending_assignment: { token: string } | null };
const leadExtras = "custom_fields,call_schedule_revision,pending_assignment:pending_lead_stage_assignments(token)";
export async function GET(request: Request, context: Context) {
  const started = Date.now();
  try {
    const { supabase, user } = await requireUser();
    const accountsReader = user.profile.role === "accounts";
    if (accountsReader ? !user.permissions.includes("deals.view") : !user.permissions.includes("leads.view")) {
      throw new HttpError(403, "You do not have permission to view this lead.");
    }
    const authenticated = Date.now();
    const id = uuid((await context.params).id);
    const params = new URL(request.url).searchParams;
    const section = params.get("section");
    if (section !== null && !["overview", "note", "email", "calls", "invoices", "courses", "workspace"].includes(section)) throw new HttpError(400, "Invalid lead section.");
    const workspace = section === "workspace";
    const all = section === null || workspace;
    const sectionErrors: Record<string, string> = {};
    const includeMetadata = params.get("metadata") !== "0";
    const withActivities = all || (params.get("history") === "1" && ["overview", "calls"].includes(section ?? ""));
    const lead = await fetchLead(supabase, id);
    if (!lead || lead.isArchived || (accountsReader && (lead.mergedIntoId
      || !["closed won", "already enrolled"].includes(lead.stage.toLowerCase())))) throw new HttpError(404, "Lead not found.");
    const leadLoaded = Date.now();
    const [stages, profiles, notes, activities, emails, configuration, extras, mailbox, scheduledCalls, duplicates, noteCount, emailCount, modifiers] = await Promise.all([
      includeMetadata ? fetchStages(supabase) : undefined, includeMetadata ? fetchProfiles(supabase) : undefined,
      all || section === "note" ? supabase.from("notes").select("id,content,created_at,user_id,images:note_images(id,filename)").eq("lead_id", id).order("created_at", { ascending: false }) : { data: [], error: null },
      withActivities ? supabase.from("activities").select("id,type,description,meta,created_at,user_id").eq("lead_id", id).order("created_at", { ascending: false }) : { data: [], error: null },
      all || section === "email" ? supabase.from("emails").select("id,subject,body,status,from_email,to_email,direction,created_at,user_id").eq("lead_id", id).order("created_at", { ascending: false }) : { data: [], error: null },
      includeMetadata ? fetchLeadConfiguration(supabase) : undefined,
      supabase.from("leads").select(leadExtras).eq("id", id).single<LeadExtras>(),
      !accountsReader && (all || section === "email") ? currentGmailMailbox(getSupabaseAdminClient(), user.id, user.email).catch(error => {
        if (!workspace) throw error;
        console.error("Could not prepare lead mailbox", error);
        sectionErrors.email = "Mailbox details could not be loaded. Open Emails to retry.";
        return null;
      }) : null,
      supabase.from("scheduled_calls").select("id,user_id,scheduled_at,status,created_at,schedule_revision").eq("lead_id", id).order("scheduled_at", { ascending: true }),
      accountsReader ? { data: [], error: null } : supabase.rpc("lead_duplicate_owners", { lead_id: id }),
      all || section === "note" ? null : supabase.from("notes").select("id", { count: "exact", head: true }).eq("lead_id", id),
      all || section === "email" ? null : supabase.from("emails").select("id", { count: "exact", head: true }).eq("lead_id", id),
      !accountsReader && !lead.modifiedBy ? fetchLeadModifiers(supabase, [id]) : [],
    ]);
    if (modifiers.length) lead.modifiedBy = modifiers[0].full_name;
    for (const [key, result] of [["note", notes], ["history", activities], ["email", emails]] as const) {
      if (workspace && result.error) {
        console.error(`Could not prepare lead ${key}`, result.error);
        sectionErrors[key] = `Lead ${key} could not be loaded. Open the related list to retry.`;
      } else dbError(result.error);
    }
    [extras, scheduledCalls, duplicates].forEach((r) => dbError(r.error));
    if (noteCount) dbError(noteCount.error);
    if (emailCount) dbError(emailCount.error);
    const latestCall = [...(scheduledCalls.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0];
    const canScheduleCall = !latestCall || latestCall.schedule_revision < extras.data!.call_schedule_revision;
    return NextResponse.json({ lead: { ...lead, customFields: extras.data?.custom_fields ?? {} }, assignmentPendingId: extras.data?.pending_assignment?.token ?? null, configuration, stages, profiles, notes: notes.data ?? [], activities: activities.data ?? [], emails: emails.data ?? [], counts: { notes: noteCount?.count ?? notes.data?.length ?? 0, emails: emailCount?.count ?? emails.data?.length ?? 0 }, mailbox, scheduledCalls: scheduledCalls.data, canScheduleCall, duplicates: duplicates.data, user, ...(workspace ? { sectionErrors } : {}) }, { headers: {
      "Cache-Control": "private, no-store",
      "Server-Timing": `auth;dur=${authenticated - started}, lead;dur=${leadLoaded - authenticated}, related;dur=${Date.now() - leadLoaded}`,
    } });
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: Request, context: Context) {
  const started = Date.now();
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.edit");
    const authenticated = Date.now();
    const id = uuid((await context.params).id);
    const body = await readJson<Record<string, unknown>>(request);
    const assignmentTiming = new URL(request.url).searchParams.get("assignment");
    if (assignmentTiming !== null && assignmentTiming !== "on-exit") throw new HttpError(400, "Invalid assignment timing.");
    const [current, extras, configuration, stages] = await Promise.all([
      fetchLead(supabase, id),
      supabase.from("leads").select(leadExtras).eq("id", id).single<LeadExtras>(),
      Object.hasOwn(body, "customFields") ? fetchLeadConfiguration(supabase) : undefined,
      Object.hasOwn(body, "stageId") ? fetchStages(supabase) : undefined,
    ]);
    if (!current || current.isArchived) throw new HttpError(404, "Lead not found.");
    dbError(extras.error);
    const previousFields = extras.data?.custom_fields ?? {};
    const input = parseLead({
      name: current.name, phone: current.phone, countryCode: current.countryCode ?? "", altPhone: current.altPhone ?? "", email: current.email,
      country: current.country, billingAddress: current.billingAddress ?? "", course: current.course, qualification: current.qualification,
      speciality: current.speciality ?? "", category: current.category ?? "", source: current.source,
      stageId: current.stageId ?? null, assigneeId: current.assigneeId ?? null, followUpAt: current.followUpAt ?? null,
      closureFee: current.closureFee, expectedClosureDate: current.expectedClosureDate ?? null, customFields: previousFields, ...body,
    });
    if (configuration) validateCustomFields(input.custom_fields, configuration, previousFields);
    input.custom_fields = { ...previousFields, ...input.custom_fields };
    if (input.assignee_id !== (current.assigneeId ?? null) && (!user.permissions.includes("leads.assign") || !["team_lead", "manager", "admin", "super_admin"].includes(user.profile.role))) throw new HttpError(403, "Assignment permission and a team lead, manager or administrator role are required.");
    if (Object.hasOwn(body, "stageId") && input.stage_id && !stages?.some(stage => stage.id === input.stage_id)) throw new HttpError(400, "Choose an active CRM stage.");
    const columnInputs: Record<keyof typeof input, string[]> = {
      name: ["name"], phone: ["phone", "countryCode"], normalized_phone: ["phone", "countryCode"], country_code: ["countryCode"],
      alt_phone: ["altPhone"], email: ["email"], normalized_email: ["email"], country: ["country"], course: ["course"],
      qualification: ["qualification"], speciality: ["speciality"], billing_address: ["billingAddress"], category: ["category"], source: ["source"], stage_id: ["stageId"],
      assignee_id: ["assigneeId"], next_followup_at: ["followUpAt"], closure_fee: ["closureFee"], expected_closure_date: ["expectedClosureDate"], custom_fields: ["customFields"],
    };
    const changes = Object.fromEntries(Object.entries(input).filter(([column]) =>
      columnInputs[column as keyof typeof input].some(key => Object.hasOwn(body, key))));
    if (!Object.keys(changes).length) throw new HttpError(400, "No lead fields were supplied.");
    const stageChanged = input.stage_id !== (current.stageId ?? null);
    const deferred = assignmentTiming === "on-exit" && stageChanged && !!input.stage_id
      && stages?.find(stage => stage.id === input.stage_id)?.name.toLowerCase() !== "closed won";
    let data: SavedLead | null;
    let assignmentPendingId: string | null = extras.data?.pending_assignment?.token ?? null;
    if (deferred) {
      const { data: result, error } = await supabase.rpc("save_lead_with_deferred_assignment", {
        p_lead_id: id, p_changes: { ...changes, modified_by: user.id }, p_token: crypto.randomUUID(),
      }).single<{ lead: SavedLead; assignment_pending_id: string | null }>();
      dbError(error);
      data = result?.lead ?? null;
      assignmentPendingId = result?.assignment_pending_id ?? null;
    } else {
      const result = await supabase.from("leads").update({ ...changes, modified_by: user.id }).eq("id", id).eq("is_archived", false)
        .select(`${LEAD_SELECT},custom_fields,call_schedule_revision`).maybeSingle<SavedLead>();
      dbError(result.error);
      data = result.data;
      if (stageChanged || input.assignee_id !== (current.assigneeId ?? null)) assignmentPendingId = null;
    }
    if (!data) throw new HttpError(403, "Lead update was not permitted.");
    let saved = data;
    if (stageChanged) {
      // Re-read joined details and any ownership changes made by the stage trigger.
      const { data: final, error: finalError } = await supabase.from("leads")
        .select(`${LEAD_SELECT},custom_fields,call_schedule_revision`).eq("id", id)
        .maybeSingle<SavedLead>();
      dbError(finalError);
      if (!final) return NextResponse.json({ id, reassigned: true });
      saved = final;
    }
    return NextResponse.json({
      id: saved.id, lead: { ...mapLead(saved), customFields: saved.custom_fields }, assignmentPendingId,
      scheduleUnlocked: Number(saved.call_schedule_revision) > Number(extras.data?.call_schedule_revision),
    }, { headers: { "Server-Timing": `auth;dur=${authenticated - started}, save;dur=${Date.now() - authenticated}` } });
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
