import { NextResponse } from "next/server";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { dbError, uuid } from "@/lib/live-leads";
import { checkOrigin } from "@/lib/server/login";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.delete");
    if (!user.permissions.includes("leads.import") || !["admin", "super_admin"].includes(user.profile.role)) {
      throw new HttpError(403, "Administrator and lead import permission are required.");
    }
    const { data, error } = await supabase.rpc("delete_live_lead_import", { sheet_id: uuid((await context.params).id) });
    dbError(error);
    return NextResponse.json({ deleted: data });
  } catch (error) { return jsonError(error); }
}
