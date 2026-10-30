import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError } from "@/lib/server/auth";
import { getIntegrationConfig } from "@/lib/server/integration-settings";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError, parseInput } from "@/lib/server/operational";
import { boundedBody, facebookGraph, facebookLead, facebookPageToken, facebookSignatureValid, facebookSource, intakeJson, recordIntake, secureEqual } from "@/lib/server/operational-intake";

const metaId = z.string().regex(/^\d{1,40}$/);
const envelope = z.object({
  object: z.string(),
  entry: z.array(z.object({
    id: metaId,
    changes: z.array(z.object({ field: z.string(), value: z.object({
      leadgen_id: metaId.optional(), page_id: metaId.optional(), form_id: metaId.optional(),
    }).passthrough() })).max(100),
  }).passthrough()).max(100),
}).passthrough();
const leadSchema = z.object({
  id: metaId, form_id: metaId.optional(),
  field_data: z.array(z.object({ name: z.string(), values: z.array(z.string()) })).max(100),
});

export async function GET(request: Request) {
  try {
    const config = await getIntegrationConfig("facebook");
    if (!config.FACEBOOK_WEBHOOK_VERIFY_TOKEN) throw new HttpError(503, "Configure FACEBOOK_WEBHOOK_VERIFY_TOKEN.");
    const query = new URL(request.url).searchParams;
    if (query.get("hub.mode") !== "subscribe" || !secureEqual(query.get("hub.verify_token") ?? "", config.FACEBOOK_WEBHOOK_VERIFY_TOKEN)) throw new HttpError(403, "Invalid webhook verification token.");
    const challenge = query.get("hub.challenge");
    if (!challenge || challenge.length > 1000) throw new HttpError(400, "Missing challenge.");
    return new Response(challenge, { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const raw = await boundedBody(request);
    const config = await getIntegrationConfig("facebook");
    if (!config.FACEBOOK_APP_SECRET) throw new HttpError(503, "Configure FACEBOOK_APP_SECRET.");
    if (!facebookSignatureValid(raw, request.headers.get("x-hub-signature-256"), config.FACEBOOK_APP_SECRET)) throw new HttpError(401, "Invalid Facebook signature.");
    const event = parseInput(envelope, intakeJson(raw));
    if (event.object !== "page") return NextResponse.json({ ignored: true });
    const admin = getSupabaseAdminClient();
    let accepted = 0;
    for (const entry of event.entry) {
      const token = await facebookPageToken(admin, entry.id, config);
      if (!token) continue;
      for (const change of entry.changes) {
        if (change.field !== "leadgen" || !change.value.leadgen_id) continue;
        if (change.value.page_id && change.value.page_id !== entry.id) throw new HttpError(400, "Page ID mismatch.");
        const eventId = `facebook:${change.value.leadgen_id}`;
        let formId = change.value.form_id;
        let lead: z.infer<typeof leadSchema> | undefined;
        if (!formId) {
          lead = parseInput(leadSchema, await facebookGraph(change.value.leadgen_id, token, config, "id,form_id,field_data,created_time"));
          formId = lead.form_id;
          // Without an authoritative form ID, a catch-all could bypass an exact route.
          if (!formId) throw new HttpError(502, "Meta did not return a form ID; routing cannot be safely determined.");
        }
        const settings = await facebookSource(admin, entry.id, formId);
        if (!settings) continue;
        const { data: existing, error: existingError } = await admin.from("inbound_events").select("id").eq("source_id", settings.source_id).eq("external_event_id", eventId).maybeSingle();
        databaseError(existingError);
        if (existing) { accepted++; continue; }
        const { data: source, error: sourceError } = await admin.from("lead_sources").select("is_active").eq("id", settings.source_id).maybeSingle();
        databaseError(sourceError);
        if (!source?.is_active) continue;
        lead ??= parseInput(leadSchema, await facebookGraph(change.value.leadgen_id, token, config, "id,form_id,field_data,created_time"));
        if (lead.id !== change.value.leadgen_id) throw new HttpError(502, "Facebook returned a different lead ID.");
        if (lead.form_id && lead.form_id !== formId) throw new HttpError(502, "Facebook returned a different form ID.");
        await recordIntake(admin, settings.source_id, { event_id: eventId, lead: facebookLead(lead.field_data) });
        accepted++;
      }
    }
    return NextResponse.json({ accepted });
  } catch (error) { return jsonError(error); }
}
