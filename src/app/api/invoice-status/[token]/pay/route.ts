import { NextResponse } from "next/server";
import { HttpError, jsonError } from "@/lib/server/auth";
import { databaseError } from "@/lib/server/operational";
import { statusTokenHash } from "@/lib/server/razorpay";
import { issuedInvoicePaymentUrl } from "@/lib/server/invoice-payment-url";
import { getSupabaseAdminClient } from "@/lib/supabase/server";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await context.params;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new HttpError(404, "Invoice payment is unavailable.");
    const admin = getSupabaseAdminClient();
    const { data: invoice, error } = await admin.from("invoices").select("*")
      .eq("status_token_hash", statusTokenHash(token)).maybeSingle();
    databaseError(error);
    if (!invoice) throw new HttpError(404, "Invoice payment is unavailable.");
    const url = issuedInvoicePaymentUrl(invoice);
    const destination = new URL(url);
    return NextResponse.redirect(destination, { status: 303, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) { return jsonError(error); }
}
