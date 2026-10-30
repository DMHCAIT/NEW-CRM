import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "@/lib/server/auth";

export async function changeManagedPassword(admin: SupabaseClient, userId: string, password: string, actorId: string) {
  const { error: updateError } = await admin.auth.admin.updateUserById(userId, { password });
  if (updateError) {
    console.error("Managed password update rejected", { code: updateError.code, status: updateError.status });
    throw new HttpError(400, "The password could not be changed. Check the configured password policy and try again.");
  }
  try {
    const { error: revokeError } = await admin.from("login_sessions").update({ signed_out_at: new Date().toISOString() }).eq("user_id", userId).is("signed_out_at", null);
    if (revokeError) throw revokeError;
    const { error: challengeError } = await admin.from("login_challenges").delete().eq("user_id", userId);
    if (challengeError) throw challengeError;
    const { error: tokenError } = await admin.from("password_setup_tokens").delete().eq("user_id", userId);
    if (tokenError) throw tokenError;
    const { error: auditError } = await admin.from("audit_logs").insert({
      actor_id: actorId, action: "user.password_changed", entity_type: "profile", entity_id: userId,
    });
    if (auditError) throw auditError;
  } catch (error) {
    console.error("Password changed but session cleanup or auditing failed", { userId, code: typeof error === "object" && error !== null && "code" in error ? error.code : "unknown" });
    throw new HttpError(503, "Password was changed, but session revocation or audit recording failed. Contact your system administrator before proceeding.");
  }
}
