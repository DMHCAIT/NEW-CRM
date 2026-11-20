import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DEFAULT_ROLE_PERMISSIONS } from "@/lib/permissions";
import type { CurrentUser, Permission } from "@/lib/types";

export const PAGE_USER_HEADER = "x-crm-page-user";

const permissions = new Set<string>(Object.values(DEFAULT_ROLE_PERMISSIONS).flat());
const permission = z.custom<Permission>(value => typeof value === "string" && permissions.has(value));
const currentUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  profile: z.object({
    id: z.string(), fullName: z.string(), email: z.string(), phone: z.string(),
    role: z.enum(["counselor", "team_lead", "manager", "accounts", "admin", "super_admin"]),
    reportingTo: z.string().nullable(), status: z.enum(["active", "inactive"]),
    ivrExtension: z.string(), deletedAt: z.string().nullable(),
  }),
  permissions: z.array(permission),
}) satisfies z.ZodType<CurrentUser>;
const requestContextSchema = currentUserSchema.extend({ permissions: z.array(z.string()) });

export function encodePageUser(user: CurrentUser | null): string {
  return encodeURIComponent(JSON.stringify(user));
}

export function decodePageUser(value: string): CurrentUser | null {
  return currentUserSchema.nullable().parse(JSON.parse(decodeURIComponent(value)));
}

export async function loadCurrentUser(supabase: SupabaseClient, touchSession = false): Promise<CurrentUser | null> {
  const [{ data: { user } }, context] = await Promise.all([
    supabase.auth.getUser(),
    supabase.rpc("crm_request_context", { touch_session: touchSession }),
  ]);
  if (!user) return null;
  if (context.error) throw new Error(context.error.message);
  if (context.data === null) return null;
  const actor = requestContextSchema.parse(context.data);
  if (actor.id !== user.id || actor.profile.id !== user.id) throw new Error("Session identity mismatch.");
  if (actor.profile.status !== "active" || actor.profile.deletedAt) return null;
  const granted = actor.permissions.filter((value): value is Permission => permissions.has(value));
  if (granted.length !== actor.permissions.length) {
    console.warn("CRM request context contains unsupported permission keys; these grants were ignored.", {
      count: actor.permissions.length - granted.length,
    });
  }
  return { ...actor, permissions: granted, email: user.email ?? "", profile: { ...actor.profile, email: actor.profile.email || user.email || "" } };
}
