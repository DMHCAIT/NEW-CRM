import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError, parseInput } from "@/lib/server/operational";
import { checkIntegrationOrigin, keyHash, sourceSchema } from "@/lib/server/operational-intake";
import { assertIntegrationAdmin } from "@/lib/server/integration-settings";

export async function GET() {
  try {
    const { supabase, user } = await requireUser("integrations.view");
    // Source management is organization-wide; only managers may see its detailed configuration.
    if (!user.permissions.includes("integrations.manage")) return NextResponse.json({ sources: [], owners: [], stages: [], canManage: false });
    try { assertIntegrationAdmin(user); }
    catch (error) {
      if (error instanceof HttpError && error.status === 403)
        return NextResponse.json({ sources: [], owners: [], stages: [], canManage: false });
      throw error;
    }
    const admin = getSupabaseAdminClient();
    const [{ data: sources, error }, { data: owners, error: ownerError }, { data: stages, error: stageError }] = await Promise.all([
      admin.from("lead_sources").select("id,name,allowed_origins,is_active,created_at,intake_source_settings(channel,owner_id,stage_id,facebook_page_id,facebook_form_id)").order("created_at", { ascending: false }),
      supabase.from("profiles").select("id,full_name").eq("status", "active").is("deleted_at", null).order("full_name"),
      supabase.from("lead_stages").select("id,name").eq("is_active", true).order("sort_order"),
    ]);
    databaseError(error); databaseError(ownerError); databaseError(stageError);
    return NextResponse.json({ sources: sources ?? [], owners: owners ?? [], stages: stages ?? [], canManage: true, facebookRouting: "Exact page + form route takes precedence over the page catch-all (null form ID), including when that exact route is disabled." });
  } catch (error) { return jsonError(error); }
}
export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser("integrations.manage");
    assertIntegrationAdmin(user);
    checkIntegrationOrigin(request);
    const input = parseInput(sourceSchema, await readJson(request));
    const { data: owner, error: ownerError } = await supabase.from("profiles").select("id").eq("id", input.owner_id).eq("status", "active").is("deleted_at", null).maybeSingle();
    databaseError(ownerError);
    if (!owner) throw new HttpError(400, "Choose an active accessible owner.");
    if (input.stage_id) {
      const { data: stage, error } = await supabase.from("lead_stages").select("id").eq("id", input.stage_id).eq("is_active", true).maybeSingle();
      databaseError(error);
      if (!stage) throw new HttpError(400, "Choose an active stage.");
    }
    const admin = getSupabaseAdminClient();
    const key = randomBytes(32).toString("base64url");
    const id = crypto.randomUUID();
    const { error } = await admin.from("lead_sources").insert({ id, name: input.name, api_key_hash: keyHash(key), allowed_origins: input.allowed_origins });
    if (error?.code === "23505") throw new HttpError(409, "A source with this name already exists. Choose a different source name.");
    databaseError(error);
    const { error: settingsError } = await admin.from("intake_source_settings").insert({ source_id: id, channel: input.channel, owner_id: input.owner_id, stage_id: input.stage_id || null, facebook_page_id: input.channel === "facebook" ? input.facebook_page_id : null, facebook_form_id: input.channel === "facebook" ? input.facebook_form_id ?? null : null, created_by: user.id });
    if (settingsError) {
      const { error: cleanupError } = await admin.from("lead_sources").delete().eq("id", id);
      if (cleanupError) {
        console.error("Source routing cleanup failed", { code: cleanupError.code });
        throw new HttpError(500, "Source routing could not be saved or cleaned up. Contact an administrator before retrying.");
      }
      if (settingsError.code === "23505") throw new HttpError(409, "A source already routes this Page/form combination.");
      databaseError(settingsError);
    }
    return NextResponse.json({
      id, apiKey: input.channel === "facebook" ? null : key,
      message: input.channel === "facebook"
        ? "Facebook route created. An exact Page/form route takes precedence over the Page catch-all. Connect this Page's own token separately."
        : "Source created. Save this API key now; it cannot be retrieved again. Signing secrets belong only on your trusted server.",
    }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
export async function PATCH(request: Request) {
  try {
    const { supabase, user } = await requireUser("integrations.manage");
    assertIntegrationAdmin(user);
    checkIntegrationOrigin(request);
    const input = parseInput(z.union([
      z.object({ id: z.string().uuid(), is_active: z.boolean() }).strict(),
      z.object({ id: z.string().uuid(), owner_id: z.string().uuid(), stage_id: z.union([z.string().uuid(), z.literal("")]) }).strict(),
    ]), await readJson(request));
    if ("owner_id" in input) {
      const { data: owner, error } = await supabase.from("profiles").select("id").eq("id", input.owner_id).eq("status", "active").is("deleted_at", null).maybeSingle();
      databaseError(error);
      if (!owner) throw new HttpError(400, "Choose an active accessible owner.");
      if (input.stage_id) {
        const { data: stage, error: stageError } = await supabase.from("lead_stages").select("id").eq("id", input.stage_id).eq("is_active", true).maybeSingle();
        databaseError(stageError);
        if (!stage) throw new HttpError(400, "Choose an active stage.");
      }
      const admin = getSupabaseAdminClient();
      const { data, error: updateError } = await admin.from("intake_source_settings").update({ owner_id: input.owner_id, stage_id: input.stage_id || null }).eq("source_id", input.id).select("source_id").maybeSingle();
      databaseError(updateError);
      if (!data) throw new HttpError(404, "Configured source not found.");
      return NextResponse.json({ id: input.id, message: "New submissions will use the updated owner and stage. Existing leads are unchanged." });
    }
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.from("lead_sources").update({ is_active: input.is_active }).eq("id", input.id).select("id").single();
    databaseError(error);
    if (!data) throw new HttpError(404, "Source not found.");
    return NextResponse.json({ id: data.id });
  } catch (error) { return jsonError(error); }
}
