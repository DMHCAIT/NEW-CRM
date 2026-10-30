import { NextResponse } from "next/server";
import { jsonError, readJson, requireUser } from "@/lib/server/auth";
import { databaseError, leadOptions, parseInput } from "@/lib/server/operational";
import { automationInput } from "@/lib/server/operational-validation";

export async function GET() {
  try {
    const { supabase, user } = await requireUser("automations.view");
    const [{ data, error }, { data: logs, error: logsError }] = await Promise.all([
      supabase.from("automations").select("*").order("priority").order("created_at"),
      supabase.from("automation_logs").select("id,automation_id,lead_id,result,details,created_at").order("created_at", { ascending: false }).limit(100),
    ]);
    databaseError(error); databaseError(logsError);
    return NextResponse.json({ automations: data ?? [], logs: logs ?? [], leads: await leadOptions(supabase), canManage: user.permissions.includes("automations.manage"), canEditLeads: user.permissions.includes("leads.edit") });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const { supabase, user } = await requireUser("automations.manage");
    const input = parseInput(automationInput, await readJson(request));
    const { data, error } = await supabase.from("automations").insert({
      name: input.name, trigger_config: { type: input.trigger }, conditions_json: [],
      actions_json: [{ type: input.action, days: input.days }], is_active: input.is_active, created_by: user.id,
    }).select("id").single();
    databaseError(error);
    return NextResponse.json({ automation: data }, { status: 201 });
  } catch (error) { return jsonError(error); }
}
