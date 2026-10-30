import { NextResponse } from "next/server";
import { HttpError, jsonError, readJson, requireString, requireUser } from "@/lib/server/auth";
import { dbError, uuid } from "@/lib/live-leads";
import { isSavedLeadFilter, criterionError } from "@/lib/lead-filters";
import { REPORT_COLUMNS } from "@/lib/reports";
import { checkOrigin } from "@/lib/server/login";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("leads.view");
    const body = await readJson<Record<string, unknown>>(request);
    if (body.action === "columns") {
      if (!Array.isArray(body.columns) || !body.columns.length || !body.columns.every((key) => REPORT_COLUMNS.some((c) => c.key === key))) throw new HttpError(400, "Invalid columns.");
      dbError((await supabase.from("user_columns").upsert({ user_id: user.id, view_name: "leads", columns_json: body.columns }, { onConflict: "user_id,view_name" })).error);
    } else if (body.action === "save") {
      if (!isSavedLeadFilter(body.filter) || body.filter.criteria.some(criterionError)) throw new HttpError(400, "Invalid filter.");
      const { data, error } = await supabase.from("saved_filters").insert({ owner_id: user.id, name: requireString(body.filter.name, "Filter name", 120), filter_json: body.filter }).select("id").single();
      dbError(error); return NextResponse.json(data);
    } else if (body.action === "delete") {
      if (typeof body.id !== "string") throw new HttpError(400, "Filter ID required.");
      dbError((await supabase.from("saved_filters").delete().eq("id", uuid(body.id)).eq("owner_id", user.id)).error);
    } else throw new HttpError(400, "Unknown preference action.");
    return NextResponse.json({ ok: true });
  } catch (error) { return jsonError(error); }
}
