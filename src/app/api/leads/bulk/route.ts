import { NextResponse } from "next/server";
import { fetchStages } from "@/lib/crm-data";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { dbError, uuid } from "@/lib/live-leads";
import { checkOrigin } from "@/lib/server/login";

type BulkUpdate = { action?: unknown; ids: unknown; assigneeId?: unknown; stageId?: unknown };

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.edit");
    const body = await readJson<BulkUpdate>(request);
    if (!body || (body.action !== undefined && body.action !== "stage")) throw new HttpError(400, "Invalid bulk action.");
    const transfer = body.action !== "stage";
    if (transfer && (!user.permissions.includes("leads.assign") || !["team_lead", "manager", "admin", "super_admin"].includes(user.profile.role))) {
      throw new HttpError(403, "Assignment permission and a team lead, manager or administrator role are required.");
    }
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100) {
      throw new HttpError(400, "Select between 1 and 100 leads per batch.");
    }
    const ids = [...new Set(body.ids.map(id => {
      if (typeof id !== "string") throw new HttpError(400, "Invalid record ID.");
      return uuid(id);
    }))];
    if (transfer && typeof body.assigneeId !== "string") throw new HttpError(400, "Choose an assignee.");
    const assigneeId = transfer && typeof body.assigneeId === "string" ? uuid(body.assigneeId) : undefined;
    const stageId = body.stageId === undefined ? undefined : typeof body.stageId === "string" ? uuid(body.stageId) : null;
    if (stageId === null || (!transfer && !stageId)) throw new HttpError(400, "Choose an active CRM stage.");
    if (stageId && !(await fetchStages(supabase)).some(stage => stage.id === stageId)) {
      throw new HttpError(400, "Choose an active CRM stage.");
    }

    const changes = { modified_by: user.id, ...(assigneeId ? { assignee_id: assigneeId } : {}), ...(stageId ? { stage_id: stageId } : {}) };
    const { data, error } = await supabase.from("leads").update(changes).eq("is_archived", false).in("id", ids).select("id");
    dbError(error);
    return NextResponse.json({ updatedIds: (data ?? []).map((lead: { id: string }) => lead.id) });
  } catch (error) {
    return jsonError(error);
  }
}
