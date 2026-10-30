import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";
import { integrationDefinitions } from "@/lib/integration-definitions";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { parseInput, databaseError } from "@/lib/server/operational";
import { assertIntegrationAdmin, decryptIntegrationValues, encryptIntegrationValues, getIntegrationConfig, integrationRecord, validateIntegrationConfig } from "@/lib/server/integration-settings";
import { checkIntegration } from "@/lib/server/integration-checks";
import { appUrl } from "@/lib/server/env";

const providerSchema = z.enum(["zoom", "razorpay", "smtp", "gmail", "intake", "facebook"]);
export async function GET() {
  try {
    const { user } = await requireUser("integrations.view");
    const canManage = ["admin", "super_admin"].includes(user.profile.role) && user.permissions.includes("integrations.manage");
    if (!canManage) return NextResponse.json({ canManage: false, settings: [], appUrl: appUrl() }, { headers: { "Cache-Control": "no-store" } });
    const settings = await Promise.all(integrationDefinitions.map(async definition => {
      const record = await integrationRecord(definition.id);
      const values = record ? decryptIntegrationValues(record.encrypted_values) : await getIntegrationConfig(definition.id);
      return {
        provider: definition.id, source: record ? "crm" : "environment", revision: record?.revision ?? null,
        values: Object.fromEntries(definition.fields.filter(field => !field.secret).map(field => [field.key, values[field.key] ?? ""])),
        saved: Object.fromEntries(definition.fields.map(field => [field.key, Boolean(values[field.key])])),
        updatedAt: record?.updated_at ?? null, testedAt: record?.tested_at ?? null, testStatus: record?.test_status ?? null, testMessage: record?.test_message ?? null,
      };
    }));
    return NextResponse.json({ canManage, settings, appUrl: appUrl() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser("integrations.manage");
    assertIntegrationAdmin(user);
    const input = parseInput(z.object({ provider: providerSchema, action: z.enum(["save", "test", "test_email"]), values: z.record(z.string().max(8192)).default({}), revision: z.string().uuid().nullable(), recipient: z.string().email().optional() }).strict(), await readJson(request));
    const definition = integrationDefinitions.find(item => item.id === input.provider)!;
    const supplied = input.values ?? {};
    if (Object.keys(supplied).some(key => !definition.fields.some(field => field.key === key))) throw new HttpError(400, "Unknown credential field.");
    if (input.action === "test_email" && (input.provider !== "smtp" || input.recipient !== user.email)) throw new HttpError(400, "Test emails may only be sent to your own CRM login address.");
    const row = await integrationRecord(input.provider);
    if ((row?.revision ?? null) !== input.revision) throw new HttpError(409, "Integration settings changed in another session. Refresh before saving or testing.");
    const current = row ? decryptIntegrationValues(row.encrypted_values) : await getIntegrationConfig(input.provider);
    const values = validateIntegrationConfig(input.provider, { ...current, ...Object.fromEntries(Object.entries(supplied).filter(([key, value]) => value !== "" || !definition.fields.find(field => field.key === key)?.secret)) });
    const admin = getSupabaseAdminClient();
    if (input.action === "save") {
      const saved = { encrypted_values: encryptIntegrationValues(values), revision: randomUUID(), updated_at: new Date().toISOString(), updated_by: user.id, tested_at: null, test_status: null, test_message: null };
      if (row) {
        const { data, error } = await admin.from("integration_credentials").update(saved).eq("provider", input.provider).eq("revision", row.revision).select("provider").maybeSingle();
        databaseError(error);
        if (!data) throw new HttpError(409, "Settings changed. Refresh and try again.");
      } else {
        const { error } = await admin.from("integration_credentials").insert({ provider: input.provider, ...saved });
        if (error?.code === "23505") throw new HttpError(409, "Settings were created in another session. Refresh and try again.");
        databaseError(error);
      }
      return NextResponse.json({ message: "Credentials saved encrypted. Run a connection check before using this integration." });
    }
    // Tests use only saved credentials, so their result always describes the active configuration.
    if (Object.keys(supplied).length) throw new HttpError(400, "Save changes before running a connection check.");
    let message: string;
    try {
      message = await checkIntegration(input.provider, values, input.action === "test_email" ? input.recipient : undefined);
    } catch (error) {
      if (row) {
        const { error: saveError } = await admin.from("integration_credentials").update({ tested_at: new Date().toISOString(), test_status: "failed", test_message: "Connection check failed. Check provider credentials, permissions and network access." }).eq("provider", input.provider).eq("revision", row.revision);
        databaseError(saveError);
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "Connection check failed. Verify provider credentials, public network access and TLS configuration.");
    }
    if (row) {
      const { data, error } = await admin.from("integration_credentials").update({ tested_at: new Date().toISOString(), test_status: "passed", test_message: message }).eq("provider", input.provider).eq("revision", row.revision).select("provider").maybeSingle();
      databaseError(error);
      if (!data) throw new HttpError(409, "Credentials changed during the check. Refresh and test again.");
    }
    return NextResponse.json({ message });
  } catch (error) { return jsonError(error); }
}
