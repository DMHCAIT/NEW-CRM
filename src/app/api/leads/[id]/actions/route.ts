import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchLead } from "@/lib/crm-data";
import { HttpError, isEmail, jsonError, readJson, requireString, requireUser } from "@/lib/server/auth";
import { dbError, uuid } from "@/lib/live-leads";
import { prepareGmailSend, sendGmailMessage } from "@/lib/server/operational-gmail";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { checkOrigin } from "@/lib/server/login";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.edit");
    const id = uuid((await context.params).id);
    const lead = await fetchLead(supabase, id);
    if (!lead || lead.isArchived) throw new HttpError(404, "Lead not found.");
    const body = await readJson<Record<string, unknown>>(request);
    if (body.action === "note") {
      const { error } = await supabase.from("notes").insert({ lead_id: id, user_id: user.id, content: requireString(body.content, "Note", 10000) });
      dbError(error);
    } else if (body.action === "activity") {
      const { error } = await supabase.from("activities").insert({ lead_id: id, user_id: user.id, type: "manual", description: requireString(body.content, "Activity", 10000) });
      dbError(error);
    } else if (body.action === "schedule_call") {
      const value = requireString(body.scheduledAt, "Call date and time", 40);
      if (!z.string().datetime({ offset: true }).safeParse(value).success) throw new HttpError(400, "Choose a valid call date and time with a time zone.");
      const scheduledAt = new Date(value);
      if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) throw new HttpError(400, "Choose a future date and time for the call.");
      const { error } = await supabase.from("scheduled_calls").insert({ lead_id: id, user_id: user.id, scheduled_at: scheduledAt.toISOString(), status: "scheduled" });
      dbError(error);
    } else if (body.action === "update_call") {
      const callId = uuid(requireString(body.callId, "Call ID", 36));
      if (!["scheduled", "completed", "cancelled"].includes(String(body.status))) throw new HttpError(400, "Choose a valid call status.");
      let newTime: string | null = null;
      if (body.status === "scheduled") {
        const value = requireString(body.scheduledAt, "Call date and time", 40);
        if (!z.string().datetime({ offset: true }).safeParse(value).success || new Date(value).getTime() <= Date.now()) throw new HttpError(400, "Choose a valid future call date and time.");
        newTime = new Date(value).toISOString();
      }
      const { error } = await supabase.rpc("update_lead_scheduled_call", { lead_id: id, call_id: callId, new_status: body.status, new_time: newTime });
      dbError(error);
    } else if (body.action === "email") {
      if (!isEmail(lead.email)) throw new HttpError(400, "Lead has no valid email address.");
      const subject = requireString(body.subject, "Subject", 200);
      const content = requireString(body.content, "Message", 20000);
      if (/[\r\n]/.test(subject)) throw new HttpError(400, "Subject must be a single line.");
      const mailbox = await prepareGmailSend(getSupabaseAdminClient(), user.id, user.email);
      const { data, error } = await supabase.from("emails").insert({ lead_id: id, user_id: user.id, from_email: mailbox.email, to_email: lead.email, subject, body: content, direction: "outbound", status: "queued" }).select("id").single();
      dbError(error);
      let message: { id: string };
      try {
        message = await sendGmailMessage(mailbox, lead.email, subject, content);
      } catch (sendError) {
        const failed = await supabase.from("emails").update({ status: "failed" }).eq("id", data!.id);
        if (failed.error) throw new HttpError(500, "Gmail sending failed and the email log could not be updated. Check your Sent folder before retrying.");
        if (!(sendError instanceof HttpError)) throw new HttpError(502, "Gmail send could not be confirmed. Check your Sent folder before retrying.");
        throw sendError;
      }
      const result = await supabase.from("emails").update({ status: "sent", gmail_message_id: message.id, sent_at: new Date().toISOString() }).eq("id", data!.id);
      if (result.error) throw new HttpError(500, "Gmail accepted the email, but its log could not be updated. Do not resend without checking your Sent folder.");
    } else throw new HttpError(400, "Unknown lead action.");
    return NextResponse.json({ ok: true });
  } catch (error) { return jsonError(error); }
}
