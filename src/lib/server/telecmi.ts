import { z } from "zod";
import { leadCallNumber } from "@/lib/lead-phone";
import { HttpError } from "@/lib/server/auth";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import type { CurrentUser, Lead } from "@/lib/types";

const attemptSchema = z.object({
  claimed: z.boolean(),
  id: z.string().uuid(),
  status: z.enum(["requesting", "accepted", "rejected", "unknown"]),
  provider_request_id: z.string().nullable(),
});
const acceptedMessage = "TeleCMI accepted the call request. Answer your TeleCMI agent device to connect the lead. Connection is not yet confirmed.";

export async function initiateTelecmiCall(lead: Lead, user: CurrentUser, requestId: unknown) {
  const parsedId = z.string().uuid().safeParse(requestId);
  if (!parsedId.success) throw new HttpError(400, "A valid call request ID is required.");
  const number = leadCallNumber(lead.phone, lead.countryCode);
  if (!number) throw new HttpError(400, "This lead has no valid phone number.");
  const config = await getIntegrationConfig("telecmi");
  const token = requireIntegrationValue(config, "TELECMI_APP_SECRET").trim();
  const admin = getSupabaseAdminClient();
  const { data: mapping, error: mappingError } = await admin.from("telecmi_agent_mappings").select("agent_id").eq("user_id", user.id).maybeSingle();
  if (mappingError) throw new HttpError(503, "TeleCMI agent mapping could not be loaded. Check database access and apply the TeleCMI migrations.");
  if (!mapping) throw new HttpError(409, "Your CRM account has no TeleCMI agent mapping. Ask an administrator to add it in Integrations > TeleCMI agents.");
  const { data, error } = await admin.rpc("claim_telecmi_call", {
    call_id: parsedId.data, actor_id: user.id, target_lead_id: lead.id,
    actor_name: user.profile.fullName, agent: mapping.agent_id, destination: number.replace(/^\+/, ""),
  });
  if (error) throw new HttpError(503, "The call request could not be reserved. Check database access and apply the TeleCMI calling migration. No call was sent.");
  if (data === null) throw new HttpError(409, "A TeleCMI call was recently requested by your account. Wait 60 seconds and check your agent before calling again.");
  const attempt = attemptSchema.safeParse(data);
  if (!attempt.success || attempt.data.id !== parsedId.data || (attempt.data.status === "accepted" && !attempt.data.provider_request_id?.trim()))
    throw new HttpError(503, "The call reservation returned an invalid response. No call was sent; contact your administrator.");
  if (!attempt.data.claimed) {
    if (attempt.data.status === "accepted") return { ok: true, requestId: attempt.data.provider_request_id, message: acceptedMessage };
    throw new HttpError(409, "This call request was already processed or is still pending. Check TeleCMI before making another call.");
  }
  async function finish(status: "accepted" | "rejected" | "unknown", providerRequestId: string | null) {
    const result = await admin.rpc("finish_telecmi_call", {
      call_id: parsedId.data, outcome: status, provider_id: providerRequestId,
    });
    if (result.error || result.data !== true) throw new HttpError(502, "TeleCMI may have received this call, but its activity could not be updated. Check your agent and TeleCMI call history before retrying.");
  }
  async function reject(code: number): Promise<never> {
    await finish("rejected", null);
    if (code === 401 || code === 403)
      throw new HttpError(502, "TeleCMI rejected the app secret or agent ID. Ask your administrator to verify the India admin click-to-call credentials and agent mapping.");
    if (code === 404) throw new HttpError(502, "TeleCMI rejected the destination number. Check its country code and your account's outbound calling permissions.");
    throw new HttpError(429, "TeleCMI is limiting call requests. Wait before trying again.");
  }
  let response: Response;
  try {
    response = await fetch("https://piopiy.telecmi.com/v1/adminConnect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: mapping.agent_id, token, to: number.replace(/^\+/, ""), custom: parsedId.data }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    });
  } catch {
    await finish("unknown", null);
    throw new HttpError(502, "TeleCMI did not return a confirmed response. The call may still ring. Check your agent and TeleCMI call history before retrying.");
  }
  if ([401, 403, 404, 429].includes(response.status)) return reject(response.status);
  let payload: unknown;
  try { payload = await response.json(); } catch {
    await finish("unknown", null);
    throw new HttpError(502, "TeleCMI did not return a confirmed response. The call may still ring. Check your agent and TeleCMI call history before retrying.");
  }
  const result = z.object({ code: z.number(), request_id: z.string().trim().min(1).max(500).optional() }).safeParse(payload);
  if (response.ok && result.success && result.data.code === 200 && result.data.request_id) {
    await finish("accepted", result.data.request_id);
    return { ok: true, requestId: result.data.request_id, message: acceptedMessage };
  }
  if (response.ok && result.success && [401, 403, 404, 429].includes(result.data.code)) return reject(result.data.code);
  await finish("unknown", null);
  throw new HttpError(502, "TeleCMI returned an unexpected response. Check your agent and TeleCMI call history before retrying.");
}
