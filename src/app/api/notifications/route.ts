import { NextResponse } from "next/server";
import { z } from "zod";
import { dbError } from "@/lib/live-leads";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    const due = await supabase.rpc("release_my_due_call_notifications");
    dbError(due.error);
    const [rows, count] = await Promise.all([
      supabase.from("notifications").select("id,type,payload,lead_id,is_read,created_at").eq("user_id", user.id)
        .order("created_at", { ascending: false }).limit(100),
      supabase.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("is_read", false),
    ]);
    dbError(rows.error); dbError(count.error);
    return NextResponse.json({ notifications: rows.data, unread: count.count ?? 0 }, { headers: { "Cache-Control": "private, no-store" } });
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
