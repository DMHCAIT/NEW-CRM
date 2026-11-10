import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { HttpError, jsonError } from "@/lib/server/auth";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { deliverLeadNotifications } from "@/lib/server/notification-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const secret = process.env.NOTIFICATION_CRON_SECRET;
    if (!secret || secret.length < 32) throw new HttpError(503, "Notification scheduler credentials are not configured.");
    const expected = Buffer.from(`Bearer ${secret}`);
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new HttpError(401, "Invalid scheduler credentials.");
    const result = await deliverLeadNotifications(getSupabaseAdminClient());
    return NextResponse.json(result, { status: result.failed ? 502 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
