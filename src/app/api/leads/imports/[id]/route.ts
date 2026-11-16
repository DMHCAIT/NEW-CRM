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
    const batchSize = Number(new URL(request.url).searchParams.get("batchSize") ?? 250);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new HttpError(400, "Invalid deletion batch size.");
    const sheetId = uuid((await context.params).id);
    const { data, error, status } = await supabase.rpc("delete_live_lead_import_batch", {
      sheet_id: sheetId, batch_size: batchSize,
    });
    if (error?.code === "PGRST202") {
      // Batched deletion migration not deployed yet; fall back to the original single-transaction deletion.
      const legacy = await supabase.rpc("delete_live_lead_import", { sheet_id: sheetId });
      if (legacy.error && legacy.status >= 500 && legacy.error.code !== "57014") {
        console.error("Lead import deletion failed", { status: legacy.status, code: legacy.error.code });
        throw new HttpError(503, "The database service is temporarily unavailable. Please retry.");
      }
      dbError(legacy.error);
      if (!Number.isSafeInteger(legacy.data) || legacy.data < 0) throw new HttpError(500, "Import deletion returned an invalid result.");
      return NextResponse.json({ deleted: legacy.data, done: true });
    }
    if (error && status >= 500 && error.code !== "57014") {
      console.error("Lead import deletion batch failed", { status, code: error.code });
      throw new HttpError(503, "The database service is temporarily unavailable. Please retry.");
    }
    dbError(error);
    if (!data || typeof data !== "object" || !("deleted" in data) || !("done" in data)
      || !Number.isSafeInteger(data.deleted) || data.deleted < 0 || typeof data.done !== "boolean") {
      throw new HttpError(500, "Import deletion returned an invalid result.");
    }
    return NextResponse.json(data);
  } catch (error) { return jsonError(error); }
}
