import { NextResponse } from "next/server";
import { HttpError, jsonError } from "@/lib/server/auth";
import { zoomSignatureValid, zoomUrlValidationResponse } from "@/lib/server/zoom";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError } from "@/lib/server/operational";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (!request.headers.get("x-zm-signature")) throw new HttpError(401, "Invalid webhook signature.");
    const secret = requireIntegrationValue(await getIntegrationConfig("zoom"), "ZOOM_WEBHOOK_SECRET_TOKEN");
    if (!zoomSignatureValid(raw, request.headers.get("x-zm-request-timestamp"), request.headers.get("x-zm-signature"), secret)) throw new HttpError(401, "Invalid webhook signature.");
    let event;
    try { event = JSON.parse(raw); } catch { throw new HttpError(400, "Invalid JSON."); }
    if (event.event === "endpoint.url_validation") {
      if (typeof event.payload?.plainToken !== "string") throw new HttpError(400, "Missing validation token.");
      return NextResponse.json(zoomUrlValidationResponse(event.payload.plainToken, secret));
    }
    if (!["meeting.started", "meeting.ended"].includes(event.event)) return NextResponse.json({ ignored: true });
    const zoomId = event.payload?.object?.id;
    if (!(typeof zoomId === "number" || typeof zoomId === "string")) throw new HttpError(400, "Missing meeting ID.");
    const admin = getSupabaseAdminClient();
    // Monotonic transitions prevent a delayed 'started' event reopening a completed meeting.
    const { error } = await admin.from("meetings").update({ status: event.event === "meeting.ended" ? "completed" : "in_progress" }).eq("zoom_meeting_id", String(zoomId)).in("status", event.event === "meeting.ended" ? ["scheduled", "in_progress"] : ["scheduled"]);
    databaseError(error);
    return NextResponse.json({ received: true });
  } catch (error) { return jsonError(error); }
}
