import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { assertIntegrationAdmin } from "@/lib/server/integration-settings";
import { checkOrigin } from "@/lib/server/login";
import { databaseError, parseInput } from "@/lib/server/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { TELECMI_CALL_MESSAGE } from "@/lib/telecmi";

const mappingSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"), userId: z.string().uuid(),
    agentId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,99}$/, "Enter a TeleCMI agent ID of 1 to 100 letters, digits, underscores, dots, @ or hyphens."),
    revision: z.string().uuid().nullable(),
  }).strict(),
  z.object({ action: z.literal("remove"), userId: z.string().uuid(), revision: z.string().uuid() }).strict(),
]);

export async function GET() {
  try {
    const { user } = await requireUser("integrations.view");
    const canManage = ["admin", "super_admin"].includes(user.profile.role) && user.permissions.includes("integrations.manage");
    if (!canManage) return NextResponse.json({ canManage: false, message: TELECMI_CALL_MESSAGE, users: [], mappings: [] }, { headers: { "Cache-Control": "no-store" } });
    const admin = getSupabaseAdminClient();
    const [profiles, mappings] = await Promise.all([
      admin.from("profiles").select("id,full_name,email,status").is("deleted_at", null).order("full_name"),
      admin.from("telecmi_agent_mappings").select("user_id,agent_id,revision,updated_at").order("updated_at"),
    ]);
    databaseError(profiles.error);
    databaseError(mappings.error);
    return NextResponse.json({ canManage, message: TELECMI_CALL_MESSAGE, users: profiles.data ?? [], mappings: mappings.data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser("integrations.manage");
    assertIntegrationAdmin(user);
    const input = parseInput(mappingSchema, await readJson(request));
    const admin = getSupabaseAdminClient();
    const { data: current, error: readError } = await admin.from("telecmi_agent_mappings").select("revision").eq("user_id", input.userId).maybeSingle();
    databaseError(readError);
    if ((current?.revision ?? null) !== input.revision) throw new HttpError(409, "TeleCMI mapping changed in another session. Refresh before saving or removing.");
    if (input.action === "remove") {
      const { data, error } = await admin.from("telecmi_agent_mappings").delete().eq("user_id", input.userId).eq("revision", input.revision).select("user_id").maybeSingle();
      databaseError(error);
      if (!data) throw new HttpError(409, "TeleCMI mapping changed. Refresh and try again.");
      return NextResponse.json({ message: "TeleCMI agent mapping removed. This user can no longer initiate TeleCMI calls." });
    }
    const { data: profile, error: profileError } = await admin.from("profiles").select("id").eq("id", input.userId).eq("status", "active").is("deleted_at", null).maybeSingle();
    databaseError(profileError);
    if (!profile) throw new HttpError(400, "Choose an active CRM user for this TeleCMI agent.");
    const patch = { agent_id: input.agentId, revision: randomUUID(), updated_by: user.id, updated_at: new Date().toISOString() };
    if (current) {
      const { data, error } = await admin.from("telecmi_agent_mappings").update(patch).eq("user_id", input.userId).eq("revision", current.revision).select("user_id").maybeSingle();
      if (error?.code === "23505") throw new HttpError(409, "That TeleCMI agent is already mapped to a CRM user. Refresh and choose a different agent.");
      databaseError(error);
      if (!data) throw new HttpError(409, "TeleCMI mapping changed. Refresh and try again.");
    } else {
      const { error } = await admin.from("telecmi_agent_mappings").insert({ user_id: input.userId, ...patch });
      if (error?.code === "23505") throw new HttpError(409, "This CRM user or TeleCMI agent already has a mapping. Refresh before trying again.");
      databaseError(error);
    }
    return NextResponse.json({ message: "TeleCMI agent mapping saved. With account credentials configured, this user can use Click to call on a lead." });
  } catch (error) { return jsonError(error); }
}
