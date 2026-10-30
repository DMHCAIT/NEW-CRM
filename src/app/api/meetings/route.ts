import { NextResponse } from "next/server";
import { HttpError, isEmail, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { databaseError, integrationRequirements, parseInput } from "@/lib/server/operational";
import { integrationStatus } from "@/lib/server/integration-settings";
import { meetingInput } from "@/lib/server/operational-validation";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { createZoomMeeting, deleteZoomMeeting } from "@/lib/server/zoom";
import { emailMeetingRecipients } from "@/lib/server/meeting-mail";

const staffRoles = ["counselor", "team_lead", "manager", "admin", "super_admin"] as const;
type StaffRole = typeof staffRoles[number];
type StaffProfile = { id: string; full_name: string; email: string; role: StaffRole };

async function activeStaff() {
  const { data, error } = await getSupabaseAdminClient().from("profiles")
    .select("id,full_name,email,role,status,deleted_at")
    .in("role", [...staffRoles]).eq("status", "active").is("deleted_at", null).order("full_name");
  databaseError(error);
  return (data ?? []) as StaffProfile[];
}

async function checkZoomOverlap(supabase: Awaited<ReturnType<typeof requireUser>>["supabase"], startAt: string, duration: number, excludeId?: string) {
  const endAt = new Date(new Date(startAt).getTime() + duration * 60_000).toISOString();
  let query = supabase.from("meetings").select("id,start_at,duration_min")
    .not("zoom_meeting_id", "is", null).in("status", ["scheduled", "in_progress"]).gte("start_at", new Date(new Date(startAt).getTime() - 480 * 60_000).toISOString()).lt("start_at", endAt).limit(500);
  if (excludeId) query = query.neq("id", excludeId);
  const { data, error } = await query;
  databaseError(error);
  const start = new Date(startAt).getTime();
  if ((data ?? []).some(meeting => start < new Date(meeting.start_at).getTime() + Number(meeting.duration_min) * 60_000)) {
    throw new HttpError(409, "This time overlaps another scheduled Zoom meeting. Choose a different time (the account has one Zoom host). ");
  }
}

export async function GET() {
  try {
    const { supabase, user } = await requireUser("meetings.view");
    const canManage = ["manager", "admin", "super_admin"].includes(user.profile.role) && user.permissions.includes("meetings.manage");
    const canAdminManage = ["admin", "super_admin"].includes(user.profile.role) || user.permissions.includes("users.manage") || user.permissions.includes("access.manage");
    const [{ data, error }, staffProfiles, zoom] = await Promise.all([
      supabase.from("meetings")
        .select("id,title,host_id,join_url,start_at,duration_min,status,zoom_meeting_id,calendar_sequence")
        .is("lead_id", null)
        .order("start_at", { ascending: false }).limit(200),
      canManage ? activeStaff() : Promise.resolve([]),
      integrationStatus("zoom", integrationRequirements.zoom),
    ]);
    databaseError(error);
    const meetings = data ?? [];
    const meetingIds = meetings.map(meeting => meeting.id);
    const admin = getSupabaseAdminClient();
    const attendeeRows = meetingIds.length ? await admin.from("meeting_attendees").select("meeting_id,user_id").in("meeting_id", meetingIds) : { data: [], error: null };
    databaseError(attendeeRows.error);
    const attendeeIds = [...new Set((attendeeRows.data ?? []).map(row => row.user_id).filter(Boolean))];
    const attendeeProfiles = attendeeIds.length ? await admin.from("profiles").select("id,full_name,role").in("id", attendeeIds) : { data: [], error: null };
    databaseError(attendeeProfiles.error);
    const people = new Map((attendeeProfiles.data ?? []).map(profile => [profile.id, { id: profile.id, name: profile.full_name, role: profile.role }]));
    const attendeesByMeeting = new Map<string, { id: string; name: string; role: string }[]>();
    for (const row of attendeeRows.data ?? []) {
      if (!row.user_id) continue;
      const person = people.get(row.user_id);
      if (!person) continue;
      const existing = attendeesByMeeting.get(row.meeting_id) ?? [];
      existing.push(person);
      attendeesByMeeting.set(row.meeting_id, existing);
    }
    const visibleMeetings = meetings.map(meeting => ({
      ...meeting,
      attendees: attendeesByMeeting.get(meeting.id) ?? [],
      isAttendee: (attendeesByMeeting.get(meeting.id) ?? []).some(person => person.id === user.id),
    }));
    const staff = staffProfiles.map(({ id, full_name, email, role }) => ({ id, name: full_name, email, role }));
    return NextResponse.json({ meetings: visibleMeetings, staff, userId: user.id, canManage, canAdminManage, zoom });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  let zoom: Awaited<ReturnType<typeof createZoomMeeting>> | undefined;
  let meetingId: string | undefined;
  let supabase: Awaited<ReturnType<typeof requireUser>>["supabase"] | undefined;
  try {
    const current = await requireUser("meetings.manage");
    supabase = current.supabase;
    const { user } = current;
    if (!["manager", "admin", "super_admin"].includes(user.profile.role)) throw new HttpError(403, "Only managers and administrators can schedule meetings.");
    const input = parseInput(meetingInput, await readJson(request));
    const requestedIds: string[] = input.attendee_ids ?? [];
    const requestedRoles: StaffRole[] = input.attendee_roles ?? [];
    if (!requestedIds.length && !requestedRoles.length) throw new HttpError(400, "Choose at least one staff attendee.");
    const staff = await activeStaff();
    const requested = new Set(requestedIds);
    const resolved = staff.filter(person => requested.has(person.id) || requestedRoles.includes(person.role));
    if (resolved.length > 200) throw new HttpError(400, "A meeting can have at most 200 staff attendees.");
    if (requestedIds.some(id => !staff.some(person => person.id === id))) {
      throw new HttpError(400, "One or more attendees are not active staff members.");
    }
    const attendeeIds = [...new Set(resolved.map(person => person.id))].filter(id => id !== user.id);
    const recipients = resolved.filter(person => person.id !== user.id);
    if (!recipients.length) throw new HttpError(400, "Choose at least one attendee other than the meeting host.");
    const invalidEmail = recipients.find(person => !isEmail(person.email ?? ""));
    if (invalidEmail) throw new HttpError(400, `Set a valid email address for ${invalidEmail.full_name} before inviting them.`);
    if (input.provider === "zoom") {
      if (input.duration_min > 40) throw new HttpError(400, "Zoom meetings on the free plan can be up to 40 minutes.");
      await checkZoomOverlap(supabase, input.start_at, input.duration_min);
      zoom = await createZoomMeeting({ topic: input.title, startAt: input.start_at, durationMin: input.duration_min, agenda: input.agenda });
    }
    meetingId = crypto.randomUUID();
    const { data: meeting, error: meetingError } = await supabase.from("meetings").insert({
      id: meetingId, title: input.title, lead_id: null, host_id: user.id,
      start_at: input.start_at, duration_min: input.duration_min, agenda: input.agenda || null, status: "scheduled",
      zoom_meeting_id: zoom ? String(zoom.id) : null, join_url: zoom?.join_url ?? null, passcode: zoom?.password ?? null,
      calendar_sequence: 0,
    }).select("id,title,start_at,duration_min,join_url,passcode").single();
    if (meetingError) throw new Error(meetingError.message);
    const { error: attendeeError } = await supabase.from("meeting_attendees").insert(attendeeIds.map(user_id => ({ meeting_id: meetingId!, user_id })));
    if (attendeeError) throw new Error(attendeeError.message);
    let delivery: { emailed: number; emailError?: string };
    try {
      delivery = await emailMeetingRecipients(meeting, recipients.map(person => ({ email: person.email, name: person.full_name })), user.profile.fullName);
    } catch (emailError) {
      delivery = { emailed: 0, emailError: emailError instanceof Error ? emailError.message : "Email delivery failed." };
    }
    return NextResponse.json({ meeting: { id: meeting.id }, ...delivery }, { status: 201 });
  } catch (error) {
    if (meetingId && supabase) {
      try { await getSupabaseAdminClient().from("meetings").delete().eq("id", meetingId); }
      catch { /* Best-effort cleanup after a failed insert. */ }
    }
    if (zoom) {
      try { await deleteZoomMeeting(String(zoom.id)); }
      catch { return jsonError(new Error(`Meeting could not be saved. Zoom meeting ${zoom.id} could not be rolled back; remove it in Zoom.`)); }
    }
    return jsonError(error);
  }
}
