import { NextResponse } from "next/server";
import { dbError, normalizePhone, uuid } from "@/lib/live-leads";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.create");
    if (user.profile.role !== "team_lead" || !(["leads.view", "leads.edit", "leads.assign"] as const).every(
      permission => user.permissions.includes(permission),
    )) throw new HttpError(403, "Team lead permissions are required.");
    const body = await readJson<unknown>(request);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Invalid lead or contact details.");
    const fields = body as Record<string, unknown>;
    if (typeof fields.leadId !== "string" || typeof fields.stageId !== "string"
      || typeof fields.phone !== "string" || typeof fields.countryCode !== "string" || typeof fields.email !== "string"
      || fields.phone.length > 30 || fields.countryCode.length > 160 || fields.email.length > 254) {
      throw new HttpError(400, "Invalid lead or contact details.");
    }
    const { data, error } = await supabase.rpc("enable_sales_lead", {
      p_lead_id: uuid(fields.leadId), p_stage_id: uuid(fields.stageId),
      p_phone: normalizePhone(fields.phone, fields.countryCode), p_email: fields.email.trim(),
    });
    dbError(error);
    if (typeof data !== "string") throw new HttpError(500, "Lead was enabled but the response was invalid. Check your leads before retrying.");
    return NextResponse.json({ id: data });
  } catch (error) { return jsonError(error); }
}
