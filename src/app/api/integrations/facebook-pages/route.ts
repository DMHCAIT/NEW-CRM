import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError, parseInput } from "@/lib/server/operational";
import { assertIntegrationAdmin, decryptIntegrationValues, encryptIntegrationValues, getIntegrationConfig } from "@/lib/server/integration-settings";
import { checkFacebookPage, checkIntegrationOrigin, testFacebookPage } from "@/lib/server/operational-intake";

const pageId = z.string().regex(/^\d{1,40}$/);
const tokenSchema = z.string().trim().min(10).max(8192).refine((value) => !/\s/.test(value), "Invalid Page token.");
const metadata = "page_id,page_name,is_active,created_at,updated_at";
const masked = <T extends object>(page: T) => ({ ...page, tokenConfigured: true, tokenMask: "••••••••" });

export async function GET() {
  try {
    const { user } = await requireUser("integrations.manage");
    assertIntegrationAdmin(user);
    const { data, error } = await getSupabaseAdminClient().from("facebook_page_connections").select(metadata).order("created_at", { ascending: false });
    databaseError(error);
    return NextResponse.json({ pages: (data ?? []).map(masked) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const { user } = await requireUser("integrations.manage");
    assertIntegrationAdmin(user);
    checkIntegrationOrigin(request);
    const input = parseInput(z.object({ page_id: pageId, access_token: tokenSchema }).strict(), await readJson(request));
    const identity = await checkFacebookPage(input.page_id, input.access_token, await getIntegrationConfig("facebook"));
    const { data, error } = await getSupabaseAdminClient().from("facebook_page_connections").insert({
      page_id: input.page_id, page_name: identity.name ?? input.page_id, created_by: user.id,
      encrypted_credentials: encryptIntegrationValues({ FACEBOOK_PAGE_ACCESS_TOKEN: input.access_token }),
    }).select(metadata).single();
    if (error?.code === "23505") throw new HttpError(409, "This Page is already connected. Update its connection instead.");
    databaseError(error);
    if (!data) throw new HttpError(500, "Page connection could not be saved.");
    return NextResponse.json({ page: masked(data), leadAccessProven: false }, { status: 201 });
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: Request) {
  try {
    const { user } = await requireUser("integrations.manage");
    assertIntegrationAdmin(user);
    checkIntegrationOrigin(request);
    const input = parseInput(z.union([
      z.object({ page_id: pageId, action: z.literal("test") }).strict(),
      z.object({ page_id: pageId, access_token: tokenSchema.optional(), is_active: z.boolean().optional() }).strict()
        .refine((value) => value.access_token !== undefined || value.is_active !== undefined, "Provide a token or active state."),
    ]), await readJson(request));
    const admin = getSupabaseAdminClient();
    if ("action" in input) {
      const { data, error } = await admin.from("facebook_page_connections").select("encrypted_credentials").eq("page_id", input.page_id).maybeSingle();
      databaseError(error);
      if (!data) throw new HttpError(404, "Page connection not found.");
      const token = decryptIntegrationValues(data.encrypted_credentials).FACEBOOK_PAGE_ACCESS_TOKEN;
      if (!token) throw new HttpError(503, "Reconnect this Page.");
      return NextResponse.json(await testFacebookPage(input.page_id, token, await getIntegrationConfig("facebook")));
    }
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.is_active !== undefined) update.is_active = input.is_active;
    if (input.access_token) {
      const identity = await checkFacebookPage(input.page_id, input.access_token, await getIntegrationConfig("facebook"));
      update.encrypted_credentials = encryptIntegrationValues({ FACEBOOK_PAGE_ACCESS_TOKEN: input.access_token });
      update.page_name = identity.name ?? input.page_id;
    }
    const { data, error } = await admin.from("facebook_page_connections").update(update).eq("page_id", input.page_id).select(metadata).maybeSingle();
    databaseError(error);
    if (!data) throw new HttpError(404, "Page connection not found.");
    return NextResponse.json({ page: masked(data) });
  } catch (error) { return jsonError(error); }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await requireUser("integrations.manage");
    assertIntegrationAdmin(user);
    checkIntegrationOrigin(request);
    const input = parseInput(z.object({ page_id: pageId }).strict(), await readJson(request));
    const { data, error } = await getSupabaseAdminClient().from("facebook_page_connections").delete().eq("page_id", input.page_id).select("page_id").maybeSingle();
    databaseError(error);
    if (!data) throw new HttpError(404, "Page connection not found.");
    return NextResponse.json({ page_id: data.page_id, message: "Page disconnected. Remove legacy environment credentials too if configured for this Page." });
  } catch (error) { return jsonError(error); }
}
