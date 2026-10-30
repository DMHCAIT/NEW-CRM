import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchProfiles } from "@/lib/crm-data";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { checkOrigin } from "@/lib/server/login";
import { changeManagedPassword } from "@/lib/server/password-management";

const passwordSchema = z.string().min(12).max(128);

const profileSchema = z.object({
  fullName: z.string().trim().min(1).max(150),
  email: z.string().trim().email().max(254),
  role: z.enum(["counselor", "team_lead", "manager", "admin", "super_admin"]),
  reportingTo: z.string().uuid().nullable(),
  status: z.enum(["active", "inactive"]),
  phone: z.string().max(50).default(""),
  ivrExtension: z.string().max(100).default(""),
});

export async function GET() {
  try {
    const { supabase, user } = await requireUser("users.view");
    const profiles = await fetchProfiles(supabase, { includeInactive: true });
    const admin = user.profile.role === "admin" || user.profile.role === "super_admin";
    const { data: activity, error } = admin ? await supabase.rpc("admin_user_last_activity")
      : { data: [], error: null };
    if (error) throw error;
    return NextResponse.json({ profiles, activity, canManage: user.profile.role === "super_admin", currentUserId: user.id });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser("users.manage");
    if (user.profile.role !== "super_admin") throw new HttpError(403, "Only Super Admin can manage users.");
    const parsed = profileSchema.extend({ password: passwordSchema }).safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "Enter valid user details and a password of 12 to 128 characters.");
    const profile = parsed.data;
    const admin = getSupabaseAdminClient();
    if (profile.reportingTo) {
      const { data, error } = await admin.from("profiles").select("id").eq("id", profile.reportingTo).eq("status", "active").is("deleted_at", null).maybeSingle();
      if (error) throw error;
      if (!data) throw new HttpError(400, "Reporting manager must be an active CRM user.");
    }
    const { data, error } = await admin.auth.admin.createUser({ email: profile.email, password: profile.password, email_confirm: true });
    if (error || !data.user) throw new HttpError(400, error?.message ?? "User creation failed.");
    const { error: insertError } = await admin.from("profiles").insert({
      id: data.user.id, full_name: profile.fullName, email: profile.email, role: profile.role,
      reporting_to: profile.reportingTo, status: profile.status, phone: profile.phone, ivr_extension: profile.ivrExtension,
    });
    if (insertError) {
      const { error: cleanupError } = await admin.auth.admin.deleteUser(data.user.id);
      if (cleanupError) console.error("Could not remove unprovisioned Auth user", cleanupError);
      throw insertError;
    }
    const { error: auditError } = await admin.from("audit_logs").insert({ actor_id: user.id, action: "user.created", entity_type: "profile", entity_id: data.user.id });
    if (auditError) {
      console.error("User created but audit recording failed", { userId: data.user.id, code: auditError.code });
      throw new HttpError(503, "User was created, but audit recording failed. Contact your system administrator; do not create the user again.");
    }
    return NextResponse.json({ created: true });
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser("users.manage");
    if (user.profile.role !== "super_admin") throw new HttpError(403, "Only Super Admin can manage users.");
    const result = z.discriminatedUnion("action", [
      z.object({ action: z.literal("password"), id: z.string().uuid(), password: passwordSchema }),
      z.object({ action: z.literal("update"), id: z.string().uuid(), profile: profileSchema }),
    ]).safeParse(await readJson(request));
    if (!result.success) {
      const passwordError = result.error.issues.some((issue) => issue.path[0] === "password");
      throw new HttpError(400, passwordError ? "Passwords must contain 12 to 128 characters." : "Invalid user details or action. Refresh the page and check the user details.");
    }
    const body = result.data;
    const admin = getSupabaseAdminClient();
    const { data: current, error: findError } = await admin.from("profiles").select("id,email").eq("id", body.id).is("deleted_at", null).single();
    if (findError) throw findError;
    if (body.action === "password") {
      await changeManagedPassword(admin, body.id, body.password, user.id);
      return NextResponse.json({ saved: true, signInRequired: body.id === user.id });
    } else {
      if (body.id === user.id && (body.profile.role !== "super_admin" || body.profile.status !== "active"))
        throw new HttpError(400, "You cannot deactivate or demote your own Super Admin account.");
      if (body.profile.email.toLowerCase() !== current.email?.toLowerCase()) throw new HttpError(400, "Email changes require administrator coordination in Supabase Auth; they cannot be changed here.");
      const seen = new Set<string>([body.id]);
      let manager = body.profile.reportingTo;
      while (manager) {
        if (seen.has(manager)) throw new HttpError(400, "Reporting hierarchy cannot contain a cycle.");
        seen.add(manager);
        const { data, error } = await admin.from("profiles").select("reporting_to,status,deleted_at").eq("id", manager).single();
        if (error) throw error;
        if (data.status !== "active" || data.deleted_at) throw new HttpError(400, "Reporting manager must be active.");
        manager = data.reporting_to;
      }
      const { error } = await admin.from("profiles").update({
        full_name: body.profile.fullName, role: body.profile.role, reporting_to: body.profile.reportingTo,
        status: body.profile.status, phone: body.profile.phone, ivr_extension: body.profile.ivrExtension, updated_at: new Date().toISOString(),
      }).eq("id", body.id);
      if (error) throw error;
      if (body.profile.status === "inactive") {
        const { error: revokeError } = await admin.from("login_sessions").update({ signed_out_at: new Date().toISOString() }).eq("user_id", body.id).is("signed_out_at", null);
        if (revokeError) throw revokeError;
      }
    }
    const { error: auditError } = await admin.from("audit_logs").insert({ actor_id: user.id, action: `user.${body.action}`, entity_type: "profile", entity_id: body.id });
    if (auditError) throw auditError;
    return NextResponse.json({ saved: true });
  } catch (error) { return jsonError(error); }
}

export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser("users.manage");
    if (user.profile.role !== "super_admin") throw new HttpError(403, "Only Super Admin can delete users.");
    const parsed = z.object({ id: z.string().uuid(), email: z.string().email() }).safeParse(await readJson(request));
    if (!parsed.success) throw new HttpError(400, "Select a user and confirm their email address.");
    if (parsed.data.id === user.id) throw new HttpError(400, "You cannot delete your own Super Admin account.");
    const admin = getSupabaseAdminClient();
    const { data: target, error: findError } = await admin.from("profiles").select("id,email").eq("id", parsed.data.id).is("deleted_at", null).maybeSingle();
    if (findError) throw findError;
    if (!target) throw new HttpError(404, "User not found.");
    if (target.email?.toLowerCase() !== parsed.data.email.toLowerCase()) throw new HttpError(400, "The confirmation email does not match this user.");
    const { error } = await admin.auth.admin.deleteUser(target.id);
    if (error) {
      console.error("Login account deletion failed", { userId: target.id, code: error.code });
      throw new HttpError(503, "The login account could not be deleted. Check database migrations and account dependencies, then try again.");
    }
    const { error: auditError } = await admin.from("audit_logs").insert({
      actor_id: user.id, action: "user.deleted", entity_type: "profile", entity_id: target.id,
    });
    if (auditError) {
      console.error("Login deleted but audit recording failed", { userId: target.id, code: auditError.code });
      throw new HttpError(503, "The login account was deleted, but audit recording failed. Contact your system administrator.");
    }
    return NextResponse.json({ deleted: true });
  } catch (error) { return jsonError(error); }
}
