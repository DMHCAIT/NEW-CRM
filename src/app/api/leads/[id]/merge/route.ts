import { NextResponse } from "next/server";
import { fetchLead } from "@/lib/crm-data";
import { dbError, uuid } from "@/lib/live-leads";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.merge");
    if (!user.permissions.includes("leads.view")) throw new HttpError(403, "Lead view permission is required.");
    const sourceId = uuid((await context.params).id);
    const body = await readJson<{ targetId: string }>(request);
    const targetId = uuid(body.targetId);
    if (sourceId === targetId) throw new HttpError(400, "Choose a different destination lead.");
    const [source, target] = await Promise.all([fetchLead(supabase, sourceId), fetchLead(supabase, targetId)]);
    if (!source || !target || source.isArchived || target.isArchived || source.mergedIntoId || target.mergedIntoId) {
      throw new HttpError(404, "Both leads must be active and within your accessible scope.");
    }
    const { data, error } = await supabase.rpc("merge_live_leads", { source_id: sourceId, target_id: targetId });
    dbError(error);
    return NextResponse.json(data);
  } catch (error) { return jsonError(error); }
}
