import { NextResponse } from "next/server";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { databaseError, parseInput, uuid } from "@/lib/server/operational";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireUser("invoices.view");
    const id = parseInput(uuid, (await context.params).id);
    const { data, error } = await supabase.from("invoices").select("status,paid_at").eq("id", id).maybeSingle();
    databaseError(error);
    if (!data) throw new HttpError(404, "Invoice not found or inaccessible.");
    return NextResponse.json({ status: data.status, paidAt: data.paid_at }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
