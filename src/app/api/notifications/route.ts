import { NextResponse } from "next/server";
import { z } from "zod";
import { dbError } from "@/lib/live-leads";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";

export async function GET() {
  const started = Date.now();
  try {
    const { supabase } = await requireUser();
    const authenticated = Date.now();
    const { data, error } = await supabase.rpc("crm_notification_snapshot");
    dbError(error);
    return NextResponse.json(data, { headers: {
      "Cache-Control": "private, no-store",
      "Server-Timing": `auth;dur=${authenticated - started}, data;dur=${Date.now() - authenticated}`,
    } });
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser();
    const parsed = z.object({ id: z.string().uuid() }).safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "Choose a valid notification.");
    const { data, error } = await supabase.from("notifications").update({ is_read: true }).eq("id", parsed.data.id)
      .eq("user_id", user.id).select("id").maybeSingle();
    dbError(error);
    if (!data) throw new HttpError(404, "Notification not found.");
    return NextResponse.json({ ok: true });
  } catch (error) { return jsonError(error); }
}
