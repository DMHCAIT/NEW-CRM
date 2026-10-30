import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { mapProfile, PROFILE_SELECT, type ProfileRow } from "@/lib/crm-data";
import { DEFAULT_ROLE_PERMISSIONS } from "@/lib/permissions";
import type { CurrentUser, Permission } from "@/lib/types";

export const PAGE_USER_HEADER = "x-crm-page-user";

const permissions = new Set<string>(Object.values(DEFAULT_ROLE_PERMISSIONS).flat());
const permission = z.custom<Permission>(value => typeof value === "string" && permissions.has(value));
const currentUserSchema: z.ZodType<CurrentUser> = z.object({
  id: z.string(),
  email: z.string(),
  profile: z.object({
    id: z.string(), fullName: z.string(), email: z.string(), phone: z.string(),
    role: z.enum(["counselor", "team_lead", "manager", "admin", "super_admin"]),
    reportingTo: z.string().nullable(), status: z.enum(["active", "inactive"]),
    ivrExtension: z.string(), deletedAt: z.string().nullable(),
  }),
  permissions: z.array(permission),
});

export function encodePageUser(user: CurrentUser | null): string {
  return encodeURIComponent(JSON.stringify(user));
}

export function decodePageUser(value: string): CurrentUser | null {
  return currentUserSchema.nullable().parse(JSON.parse(decodeURIComponent(value)));
}

export async function loadCurrentUser(supabase: SupabaseClient, touchSession = false): Promise<CurrentUser | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const [{ data: verified, error: verificationError }, { data: profile, error: profileError }, { data: granted, error: permissionError }] = await Promise.all([
    supabase.rpc(touchSession ? "touch_login_session" : "is_verified_session"),
    supabase.from("profiles").select(PROFILE_SELECT).eq("id", user.id).maybeSingle<ProfileRow>(),
    supabase.rpc("my_permissions"),
  ]);
  if (verificationError) throw new Error(verificationError.message);
  if (verified !== true) return null;
  if (profileError) throw new Error(profileError.message);
  if (permissionError) throw new Error(permissionError.message);
  if (!profile || profile.status !== "active" || profile.deleted_at) return null;
  return {
    id: user.id,
    email: user.email ?? "",
    profile: mapProfile(profile, user.email ?? ""),
    permissions: z.array(permission).parse(granted),
  };
}
