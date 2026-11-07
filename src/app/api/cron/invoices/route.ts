import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { HttpError, jsonError } from "@/lib/server/auth";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { deliverScheduledInvoices } from "@/lib/server/invoice-scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const secret = process.env.INVOICE_CRON_SECRET;
    if (!secret || secret.length < 32) throw new HttpError(503, "Invoice scheduler credentials are not configured.");
    const expected = Buffer.from(`Bearer ${secret}`);
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new HttpError(401, "Invalid scheduler credentials.");
    const results = await deliverScheduledInvoices(getSupabaseAdminClient());
    return NextResponse.json({ processed: results.length, failed: results.filter(row => !row.sent).length },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
