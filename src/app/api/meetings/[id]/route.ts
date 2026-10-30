import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { databaseError, parseInput, uuid } from "@/lib/server/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { deleteZoomMeeting, updateZoomMeeting } from "@/lib/server/zoom";
import { emailMeetingRecipients } from "@/lib/server/meeting-mail";

const adminRoles = ["admin", "super_admin"];
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, user } = await requireUser("meetings.view");
    const id = parseInput(uuid, (await context.params).id);
    const input = parseInput(z.object({ action: z.enum(["cancel", "complete", "reschedule"]), start_at: z.string().datetime({ offset: true }).optional() }), await readJson(request));
    const isAdmin = adminRoles.includes(user.profile.role) || user.permissions.includes("users.manage") || user.permissions.includes("access.manage");
    if ((!user.permissions.includes("meetings.manage") || !["manager", "admin", "super_admin"].includes(user.profile.role)) && !isAdmin) throw new HttpError(403, "You do not have permission for this action.");
    const { data: meeting, error } = await supabase.from("meetings").select("id,title,host_id,status,zoom_meeting_id,join_url,passcode,start_at,duration_min,calendar_sequence").eq("id", id).maybeSingle();
    databaseError(error);
    if (!meeting || (meeting.host_id !== user.id && !isAdmin)) throw new HttpError(403, "Only the meeting host or an administrator can change this meeting.");
    if (meeting.status !== "scheduled") throw new HttpError(409, "Only scheduled meetings can be changed.");
    if (input.action === "complete" && meeting.zoom_meeting_id) throw new HttpError(400, "Zoom meetings are completed by signed Zoom events. Configure the meeting.ended webhook.");
    const sequence = Number(meeting.calendar_sequence ?? 0) + 1;
    if (input.action === "reschedule") {
      if (!input.start_at || new Date(input.start_at).getTime() <= Date.now()) throw new HttpError(400, "Choose a future start time.");
      if (meeting.zoom_meeting_id) {
        const endAt = new Date(new Date(input.start_at).getTime() + meeting.duration_min * 60_000).toISOString();
        const { data: others, error: overlapError } = await supabase.from("meetings").select("start_at,duration_min").not("zoom_meeting_id", "is", null).in("status", ["scheduled", "in_progress"]).gte("start_at", new Date(new Date(input.start_at).getTime() - 480 * 60_000).toISOString()).lt("start_at", endAt).neq("id", id).limit(500);
        databaseError(overlapError);
        if ((others ?? []).some(other => new Date(input.start_at!).getTime() < new Date(other.start_at).getTime() + Number(other.duration_min) * 60_000)) throw new HttpError(409, "This time overlaps another scheduled Zoom meeting. Choose a different time (the account has one Zoom host).");
        await updateZoomMeeting(meeting.zoom_meeting_id, { startAt: input.start_at });
      }
    } else if (input.action === "cancel" && meeting.zoom_meeting_id) await deleteZoomMeeting(meeting.zoom_meeting_id);
    const change = input.action === "reschedule" ? { start_at: input.start_at, calendar_sequence: sequence } : { status: input.action === "cancel" ? "cancelled" : "completed", calendar_sequence: sequence };
    const { data, error: updateError } = await supabase.from("meetings").update(change).eq("id", id).eq("status", "scheduled").select("id").maybeSingle();
    databaseError(updateError);
    if (!data) throw new HttpError(409, "Meeting changed while this action was running. Refresh and verify the provider state.");
    if (input.action === "complete") return NextResponse.json({ meeting: data });

    const admin = getSupabaseAdminClient();
    const { data: rows, error: attendeesError } = await admin.from("meeting_attendees").select("user_id").eq("meeting_id", id);
    databaseError(attendeesError);
    const attendeeIds = [...new Set((rows ?? []).map(row => row.user_id).filter(Boolean))];
    const { data: profiles, error: profilesError } = attendeeIds.length ? await admin.from("profiles").select("id,full_name,email").in("id", attendeeIds) : { data: [], error: null };
    databaseError(profilesError);
    const recipients = (profiles ?? []).filter(person => typeof person.email === "string" && person.email.includes("@")).map(person => ({ name: person.full_name, email: person.email }));
    const { data: host, error: hostError } = await admin.from("profiles").select("full_name").eq("id", meeting.host_id).maybeSingle();
    databaseError(hostError);
    try {
      const delivery = await emailMeetingRecipients({ id: meeting.id, title: meeting.title, start_at: input.action === "reschedule" ? input.start_at! : meeting.start_at, duration_min: meeting.duration_min, join_url: meeting.join_url, passcode: meeting.passcode }, recipients, host?.full_name ?? user.profile.fullName, input.action === "cancel" ? "CANCEL" : "REQUEST", sequence);
      return NextResponse.json({ meeting: data, ...delivery });
    } catch (emailError) {
      return NextResponse.json({ meeting: data, emailed: 0, emailError: emailError instanceof Error ? emailError.message : "Email delivery failed." });
    }
  } catch (error) { return jsonError(error); }
}
