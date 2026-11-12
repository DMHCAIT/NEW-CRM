import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchLead } from "@/lib/crm-data";
import { HttpError, isEmail, jsonError, readJson, requireString, requireUser } from "@/lib/server/auth";
import { dbError, uuid } from "@/lib/live-leads";
import { prepareGmailSend, sendGmailMessage } from "@/lib/server/operational-gmail";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { checkOrigin } from "@/lib/server/login";
import { sanitizeSignature, signatureText } from "@/lib/server/email-signature";
import { parseNoteImages } from "@/lib/server/note-images";
import { initiateTelecmiCall } from "@/lib/server/telecmi";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.edit");
    const id = uuid((await context.params).id);
    const lead = await fetchLead(supabase, id);
    if (!lead || lead.isArchived) throw new HttpError(404, "Lead not found.");
    if (Number(request.headers.get("content-length") ?? 0) > 20_200_000) throw new HttpError(413, "Note attachments exceed the request size limit.");
    const body = await readJson<Record<string, unknown>>(request);
    if (body.action === "note") {
      const images = parseNoteImages(body.images);
      const content = images.length && body.content === "" ? "" : requireString(body.content, "Note", 10000);
      const { error } = images.length
        ? await supabase.rpc("add_live_lead_note", { lead_id: id, note_content: content, images_json: images })
        : await supabase.from("notes").insert({ lead_id: id, user_id: user.id, content });
      dbError(error);
    } else if (body.action === "activity") {
      const { error } = await supabase.from("activities").insert({ lead_id: id, user_id: user.id, type: "manual", description: requireString(body.content, "Activity", 10000) });
      dbError(error);
    } else if (body.action === "telecmi_call") {
      return NextResponse.json(await initiateTelecmiCall(lead, user, body.requestId));
    } else if (body.action === "call_started") {
      const { error } = await supabase.from("activities").insert({
        lead_id: id, user_id: user.id, type: "call", description: "Phone app opened to call lead",
        meta: { actor_name: user.profile.fullName },
      });
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
      if (body.includeSignature !== undefined && typeof body.includeSignature !== "boolean") throw new HttpError(400, "Invalid signature option.");
      const [signature, mailbox] = await Promise.all([
        body.includeSignature === false ? Promise.resolve("") : (async () => {
          const { data: profile, error } = await supabase.from("profiles").select("email_signature_html").eq("id", user.id).single();
          dbError(error);
          if (!profile) throw new HttpError(404, "Your email signature profile could not be found.");
          return sanitizeSignature(profile.email_signature_html);
        })(),
        prepareGmailSend(getSupabaseAdminClient(), user.id, user.email),
      ]);
      const textSignature = signatureText(signature);
      const plain = content + (textSignature ? `\n\n${textSignature}` : "");
      const escaped = content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const html = `<div style="white-space:pre-wrap">${escaped.replace(/\r?\n/g, "<br>")}</div>${signature ? `<br><div>${signature}</div>` : ""}`;
      const { data, error } = await supabase.from("emails").insert({ lead_id: id, user_id: user.id, from_email: mailbox.email, to_email: lead.email, subject, body: plain, body_html: html, direction: "outbound", status: "queued" }).select("id").single();
      dbError(error);
      let message: { id: string };
      try {
        message = await sendGmailMessage(mailbox, lead.email, subject, plain, html);
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
