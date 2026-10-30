import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const { user, supabase } = await requireUser();
    if (user.profile.role !== "super_admin") throw new HttpError(403, "Only Super Admin can sign out device sessions.");
    const parsed = z.object({ sessionId: z.string().uuid() }).safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "Select a valid device session.");
    const { data: claims, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError) throw claimsError;
    const admin = getSupabaseAdminClient();
    const { data: target, error } = await admin.from("login_sessions")
      .update({ signed_out_at: new Date().toISOString() }).eq("session_id", parsed.data.sessionId)
      .is("signed_out_at", null).gt("expires_at", new Date().toISOString())
      .select("session_id,user_id").maybeSingle();
    if (error) throw error;
    if (!target) throw new HttpError(409, "This session is already signed out, expired or no longer exists. Refresh the history.");
    const { error: auditError } = await admin.from("audit_logs").insert({
      actor_id: user.id, action: "session.revoked", entity_type: "login_session", entity_id: target.session_id,
      changes: { user_id: target.user_id },
    });
    if (auditError) {
      console.error("Device session revoked but audit recording failed", { sessionId: target.session_id, code: auditError.code });
      throw new HttpError(503, "The device session was signed out, but audit recording failed. Refresh the history and contact your administrator.");
    }
    return NextResponse.json({ revoked: true, signInRequired: claims?.claims.session_id === target.session_id });
  } catch (error) { return jsonError(error); }
}
