import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";
import { fetchProfiles } from "@/lib/crm-data";

export async function GET() {
  try {
    const { supabase } = await requireUser("access.manage");
    const [roles, overrides, profiles] = await Promise.all([
      supabase.from("role_permissions").select("role,permission_key,allowed"),
      supabase.from("user_permission_overrides").select("user_id,permission_key,allowed"),
      fetchProfiles(supabase, { includeInactive: true }),
    ]);
    if (roles.error) throw roles.error;
    if (overrides.error) throw overrides.error;
    return NextResponse.json({ roles: roles.data, overrides: overrides.data, profiles });
  } catch (error) { return jsonError(error); }
}

export async function PUT(request: Request) {
  try {
    checkOrigin(request);
    const { supabase } = await requireUser("access.manage");
    const result = z.object({
      role: z.enum(["counselor", "team_lead", "manager", "admin"]).optional(),
      userId: z.string().uuid().optional(), grants: z.record(z.boolean()),
    }).safeParse(await readJson(request));
    if (!result.success || Boolean(result.data.role) === Boolean(result.data.userId)) throw new HttpError(400, "Choose a role or user and valid permission grants.");
    const { error } = await supabase.rpc("save_access_configuration", {
      target_role: result.data.role ?? null, target_user: result.data.userId ?? null, grants: result.data.grants,
    });
    if (error) throw error;
    return NextResponse.json({ saved: true });
  } catch (error) { return jsonError(error); }
}
