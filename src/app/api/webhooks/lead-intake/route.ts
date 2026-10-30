import { NextResponse } from "next/server";
import { HttpError, jsonError } from "@/lib/server/auth";
import { getIntegrationConfig } from "@/lib/server/integration-settings";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError, parseInput, uuid } from "@/lib/server/operational";
import { boundedBody, intakeJson, intakeSchema, intakeSignatureValid, keyHash, recordIntake } from "@/lib/server/operational-intake";

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new HttpError(415, "Use Content-Type: application/json.");
    const raw = await boundedBody(request);
    const config = await getIntegrationConfig("intake");
    if (!config.LEAD_INTAKE_SIGNING_KEY) throw new HttpError(503, "Configure LEAD_INTAKE_SIGNING_KEY.");
    if (!intakeSignatureValid(raw, request.headers.get("x-crm-timestamp"), request.headers.get("x-crm-signature"), config.LEAD_INTAKE_SIGNING_KEY)) throw new HttpError(401, "Invalid or expired intake signature.");
    const sourceId = parseInput(uuid, request.headers.get("x-crm-source"));
    const key = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)?.[1];
    if (!key) throw new HttpError(401, "A source API key is required.");
    const input = parseInput(intakeSchema, intakeJson(raw));
    const admin = getSupabaseAdminClient();
    const { data: source, error } = await admin.from("lead_sources").select("id,allowed_origins,intake_source_settings(channel)").eq("id", sourceId).eq("api_key_hash", keyHash(key)).eq("is_active", true).maybeSingle();
    databaseError(error);
    if (!source) throw new HttpError(401, "Invalid source credentials.");
    const settings = source.intake_source_settings as unknown as { channel: string } | null;
    if (!settings || !["website", "chatbot"].includes(settings.channel)) throw new HttpError(403, "Source is not a website or chatbot source.");
    const origin = request.headers.get("origin");
    if (source.allowed_origins.length && (!origin || !source.allowed_origins.includes(origin))) throw new HttpError(403, "Source origin is not allowed.");
    // Deliberately return no CRM identifiers or existing-lead details to the external sender.
    const result = await recordIntake(admin, sourceId, input);
    return NextResponse.json({ accepted: true, event_id: input.event_id, replayed: result.status === "replayed" }, { status: 202 });
  } catch (error) { return jsonError(error); }
}
