import { createHmac, timingSafeEqual } from "node:crypto";
import { requireEnv } from "@/lib/server/env";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";

async function zoomToken(): Promise<string> {
  const config = await getIntegrationConfig("zoom");
  const credentials = Buffer.from(`${requireIntegrationValue(config, "ZOOM_CLIENT_ID")}:${requireIntegrationValue(config, "ZOOM_CLIENT_SECRET")}`).toString("base64");
  const response = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(requireIntegrationValue(config, "ZOOM_ACCOUNT_ID"))}`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json() as { access_token?: string; expires_in?: number; reason?: string; error?: string };
  if (!response.ok || !payload.access_token) throw new Error(`Zoom authentication failed (${response.status}). Check the credentials and app activation in Integrations.`);
  return payload.access_token;
}

async function zoomRequest<T>(path: string, init: { method: string; body?: unknown }): Promise<T> {
  const response = await fetch(`https://api.zoom.us/v2${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${await zoomToken()}`, "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) throw new Error(`Zoom API error: ${payload.message ?? response.status}`);
  return payload;
}

export type ZoomMeeting = { id: number; join_url: string; start_url: string; password?: string };

/** Hosts under ZOOM_HOST_USER (a Zoom user id/email in the account), or the account owner ("me"). */
async function zoomHost(hostEmail?: string) {
  const config = await getIntegrationConfig("zoom");
  if (config.ZOOM_USE_CRM_HOST_EMAIL === "true" && hostEmail) return encodeURIComponent(hostEmail);
  return encodeURIComponent(config.ZOOM_HOST_USER || "me");
}

export async function createZoomMeeting(input: { topic: string; startAt: string; durationMin: number; agenda?: string; hostEmail?: string }) {
  return zoomRequest<ZoomMeeting>(`/users/${await zoomHost(input.hostEmail)}/meetings`, {
    method: "POST",
    body: {
      topic: input.topic,
      type: 2,
      start_time: new Date(input.startAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
      duration: input.durationMin,
      timezone: process.env.CRM_TIMEZONE || "Asia/Kolkata",
      agenda: input.agenda,
      settings: { join_before_host: false, waiting_room: true },
    },
  });
}

export function updateZoomMeeting(zoomId: string, input: { topic?: string; startAt?: string; durationMin?: number }) {
  return zoomRequest<void>(`/meetings/${encodeURIComponent(zoomId)}`, {
    method: "PATCH",
    body: {
      topic: input.topic,
      start_time: input.startAt ? new Date(input.startAt).toISOString().replace(/\.\d{3}Z$/, "Z") : undefined,
      duration: input.durationMin,
      timezone: process.env.CRM_TIMEZONE || "Asia/Kolkata",
    },
  });
}

export function deleteZoomMeeting(zoomId: string) {
  return zoomRequest<void>(`/meetings/${encodeURIComponent(zoomId)}?schedule_for_reminder=true`, { method: "DELETE" });
}

export function zoomSignatureValid(rawBody: string, timestamp: string | null, signature: string | null, secret = requireEnv("ZOOM_WEBHOOK_SECRET_TOKEN")) {
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function zoomUrlValidationResponse(plainToken: string, secret = requireEnv("ZOOM_WEBHOOK_SECRET_TOKEN")) {
  return { plainToken, encryptedToken: createHmac("sha256", secret).update(plainToken).digest("hex") };
}
