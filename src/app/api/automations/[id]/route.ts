import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, readJson, requireUser } from "@/lib/server/auth";
import { accessibleLead, databaseError, parseInput, uuid } from "@/lib/server/operational";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireUser("automations.manage");
    const id = parseInput(uuid, (await context.params).id);
    const input = parseInput(z.object({ is_active: z.boolean() }), await readJson(request));
    const { data, error } = await supabase.from("automations").update({ is_active: input.is_active, updated_at: new Date().toISOString() }).eq("id", id).select("id").single();
    databaseError(error);
    return NextResponse.json({ automation: data });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireUser("automations.manage");
    const id = parseInput(uuid, (await context.params).id);
    const input = parseInput(z.object({ lead_id: z.string().uuid().nullable().optional() }), await readJson(request));
    if (input.lead_id) await accessibleLead(supabase, input.lead_id);
    const { data, error } = await supabase.rpc("operational_run_automation", { p_id: id, p_lead_id: input.lead_id ?? null });
    databaseError(error);
    return NextResponse.json({ message: `Executed for ${data} accessible lead(s). Each lead is processed at most once per rule, operator and UTC database day.`, count: data });
  } catch (error) { return jsonError(error); }
}
