import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { databaseError, parseInput } from "@/lib/server/operational";
import type { SupabaseClient } from "@supabase/supabase-js";

export const intakeLeadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).refine((value) => /^\+?[\d\s().-]+$/.test(value) && value.replace(/\D/g, "").length >= 7 && value.replace(/\D/g, "").length <= 15, "A valid phone number is required."),
  email: z.union([z.string().trim().email().max(254), z.literal("")]).optional(),
  country: z.string().trim().max(100).optional(),
  course: z.string().trim().max(200).optional(),
  qualification: z.string().trim().max(200).optional(),
  message: z.string().trim().max(10000).optional(),
}).strict();
export const intakeSchema = z.object({
  event_id: z.string().trim().min(1).max(200),
  lead: intakeLeadSchema,
  transcript: z.array(z.object({
    role: z.enum(["user", "assistant", "agent"]),
    content: z.string().min(1).max(4000),
  }).strict()).max(100).optional(),
}).strict();
export const sourceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  channel: z.enum(["website", "chatbot", "facebook"]),
  owner_id: z.string().uuid(),
  stage_id: z.union([z.string().uuid(), z.literal("")]).optional(),
  facebook_page_id: z.string().regex(/^\d{1,40}$/).optional(),
  facebook_form_id: z.string().regex(/^\d{1,40}$/).optional(),
  allowed_origins: z.array(z.string().url().max(300).refine((value) => new URL(value).origin === value, "Use origins without paths or trailing slashes.")).max(20).default([]),
}).superRefine((value, ctx) => {
  if (value.channel === "facebook" && !value.facebook_page_id)
    ctx.addIssue({ code: "custom", message: "Facebook page ID is required.", path: ["facebook_page_id"] });
  if (value.channel !== "facebook" && (value.facebook_page_id || value.facebook_form_id))
    ctx.addIssue({ code: "custom", message: "Page and form IDs are only valid for Facebook sources.", path: ["facebook_form_id"] });
});

export function checkIntegrationOrigin(request: Request) {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) throw new HttpError(503, "Configure NEXT_PUBLIC_APP_URL before managing integrations.");
  let expected: string;
  try { expected = new URL(configured).origin; }
  catch { throw new HttpError(503, "NEXT_PUBLIC_APP_URL is invalid."); }
  if (request.headers.get("origin") !== expected) throw new HttpError(403, "Request origin is not allowed.");
}

export function facebookVersion(config: Record<string, string>) {
  const version = config.FACEBOOK_GRAPH_VERSION;
  if (!version || !/^v\d+\.\d+$/.test(version)) throw new HttpError(503, "Configure a supported FACEBOOK_GRAPH_VERSION (for example v25.0).");
  return version;
}

export async function facebookGraph(path: string, token: string, config: Record<string, string>, fields?: string) {
  if (!config.FACEBOOK_APP_SECRET) throw new HttpError(503, "Configure FACEBOOK_APP_SECRET.");
  const url = new URL(`https://graph.facebook.com/${facebookVersion(config)}/${path}`);
  if (fields) url.searchParams.set("fields", fields);
  url.searchParams.set("appsecret_proof", createHmac("sha256", config.FACEBOOK_APP_SECRET).update(token).digest("hex"));
  let response: Response;
  try {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(15000) });
  } catch { throw new HttpError(502, "Meta request failed or timed out. Check Page access and retry."); }
  if (!response.ok) throw new HttpError(502, "Meta request failed. Verify the Page token, app review, Page permissions and leads_retrieval access.");
  try { return await response.json() as unknown; }
  catch { throw new HttpError(502, "Meta returned an invalid response."); }
}

export async function checkFacebookPage(pageId: string, token: string, config: Record<string, string>) {
  const identity = parseInput(z.object({ id: z.string(), name: z.string().optional() }), await facebookGraph("me", token, config, "id,name"));
  if (identity.id !== pageId) throw new HttpError(400, "The token belongs to a different Page. Supply this Page's own access token.");
  return identity;
}

export async function testFacebookPage(pageId: string, token: string, config: Record<string, string>) {
  const identity = await checkFacebookPage(pageId, token, config);
  // Read only: never subscribe the app, create a test lead, or retrieve a person's lead.
  const forms = parseInput(z.object({ data: z.array(z.object({ id: z.string(), name: z.string().optional(), status: z.string().optional() })), paging: z.object({ next: z.string().optional() }).optional() }),
    await facebookGraph(`${pageId}/leadgen_forms`, token, config, "id,name,status"));
  const subscriptions = parseInput(z.object({ data: z.array(z.object({ id: z.string(), subscribed_fields: z.array(z.string()).optional() })), paging: z.object({ next: z.string().optional() }).optional() }),
    await facebookGraph(`${pageId}/subscribed_apps`, token, config, "id,subscribed_fields"));
  const appId = config.FACEBOOK_APP_ID;
  const subscribed = Boolean(appId && subscriptions.data.some((app) => app.id === appId && app.subscribed_fields?.includes("leadgen")));
  return {
    page: identity, forms: forms.data, formsTruncated: Boolean(forms.paging?.next),
    identityVerified: true, formsReadable: true, subscriptionVerified: subscribed,
    subscriptionCheck: !appId ? "not_verified_app_id_missing" : subscribed ? "subscribed" : subscriptions.paging?.next ? "not_verified_results_truncated" : "not_subscribed",
    leadAccessProven: false,
    message: "Read-only checks only. Lead retrieval is not proven until a real authorized leadgen event is delivered successfully.",
  };
}

export async function facebookPageToken(admin: SupabaseClient, pageId: string, config: Record<string, string>) {
  const { data: connection, error } = await admin.from("facebook_page_connections").select("encrypted_credentials,is_active").eq("page_id", pageId).maybeSingle();
  databaseError(error);
  if (connection) {
    if (!connection.is_active) return null;
    const { decryptIntegrationValues } = await import("@/lib/server/integration-settings");
    const token = decryptIntegrationValues(connection.encrypted_credentials).FACEBOOK_PAGE_ACCESS_TOKEN;
    if (!token) throw new HttpError(503, "Reconnect this Facebook Page.");
    return token;
  }
  // A legacy token can only be used for its explicitly configured Page.
  return config.FACEBOOK_PAGE_ID === pageId ? config.FACEBOOK_PAGE_ACCESS_TOKEN || null : null;
}

export async function facebookSource(admin: SupabaseClient, pageId: string, formId?: string) {
  const query = admin.from("intake_source_settings").select("source_id,facebook_form_id").eq("channel", "facebook").eq("facebook_page_id", pageId);
  const { data, error } = await query;
  databaseError(error);
  const sources = (data ?? []) as { source_id: string; facebook_form_id: string | null }[];
  // Disabled form routes still take precedence: never silently reroute to a catch-all.
  return (formId ? sources.find((source) => source.facebook_form_id === formId) : undefined)
    ?? sources.find((source) => source.facebook_form_id === null) ?? null;
}

export const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
export function secureEqual(a: string, b: string) {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function intakeSignatureValid(raw: string, timestamp: string | null, signature: string | null, secret: string) {
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  return secureEqual(`v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`, signature);
}
export function facebookSignatureValid(raw: string, signature: string | null, secret: string) {
  return Boolean(signature && secureEqual(`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`, signature));
}

export async function boundedBody(request: Request, max = 524288) {
  if (Number(request.headers.get("content-length")) > max) throw new HttpError(413, "Request body is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Request body is required.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > max) { await reader.cancel(); throw new HttpError(413, "Request body is too large."); }
    chunks.push(part.value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export function intakeJson(raw: string) {
  try { return JSON.parse(raw) as unknown; } catch { throw new HttpError(400, "Body must be valid JSON."); }
}
export async function recordIntake(admin: SupabaseClient, sourceId: string, input: z.infer<typeof intakeSchema>) {
  const { data: allowed, error: rateError } = await admin.rpc("integration_intake_rate", { p_source_id: sourceId });
  databaseError(rateError);
  if (!allowed) throw new HttpError(429, "Source rate limit exceeded (60 requests/minute). Retry after one minute.");
  const { data, error } = await admin.rpc("integration_intake", { p_source_id: sourceId, p_event_id: input.event_id, p_lead: input.lead, p_transcript: input.transcript ?? null });
  databaseError(error);
  return data as { status: string; lead_id: string };
}

export function facebookLead(fields: { name: string; values: string[] }[]) {
  const values = Object.fromEntries(fields.map((field) => [field.name, field.values[0] ?? ""]));
  return parseInput(intakeLeadSchema, {
    name: values.full_name || [values.first_name, values.last_name].filter(Boolean).join(" "),
    phone: values.phone_number ?? "",
    email: values.email ?? "",
    ...(values.country ? { country: values.country } : {}),
    ...(values.course ? { course: values.course } : {}),
    ...(values.qualification ? { qualification: values.qualification } : {}),
  });
}
