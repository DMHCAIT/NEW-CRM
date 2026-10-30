import { NextResponse } from "next/server";
import { statusTokenHash } from "@/lib/server/razorpay";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token))
    return NextResponse.json({ error: "Invoice status is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.from("invoices")
    .select("invoice_no,total,currency,status,paid_at,invoice_items(description)")
    .eq("status_token_hash", statusTokenHash(token)).maybeSingle();
  if (error || !data)
    return NextResponse.json({ error: "Invoice status is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const item = Array.isArray(data.invoice_items) ? data.invoice_items[0] : null;
  return NextResponse.json({
    invoiceNo: data.invoice_no,
    course: typeof item?.description === "string" ? item.description.slice(0, 120) : null,
    total: Number(data.total),
    currency: data.currency,
    status: data.status,
    paidAt: data.paid_at,
  }, { headers: { "Cache-Control": "no-store" } });
}
