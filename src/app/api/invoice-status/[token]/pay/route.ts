import { NextResponse } from "next/server";
import { HttpError, jsonError } from "@/lib/server/auth";
import { ensureInvoiceCheckout } from "@/lib/server/invoice-checkout";
import { databaseError } from "@/lib/server/operational";
import { statusTokenHash } from "@/lib/server/razorpay";
import { invoiceProviderUrlValid, invoiceWindowExpired } from "@/lib/invoice-policy";
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
    if (invoice.status !== "sent" || invoice.tax_review_required
      || !["one_shot", "installments"].includes(invoice.payment_type))
      throw new HttpError(409, invoice.status === "paid" ? "This invoice is already paid. No further payment is required." : "This invoice is not available for online payment.");
    if (invoiceWindowExpired(invoice)) throw new HttpError(410, "The payment window has expired. Contact your lead owner.");
    let url: string;
    if (invoice.currency === "USD") {
      url = await ensureInvoiceCheckout(admin, invoice, token);
    } else if (invoice.currency === "INR") {
      if (!invoice.razorpay_short_url) throw new HttpError(409, "The Razorpay payment link has not been issued. Contact finance.");
      url = invoice.razorpay_short_url;
    } else {
      throw new HttpError(409, "This invoice currency is not supported for online payment.");
    }
    if (!invoiceProviderUrlValid(url, invoice.currency))
      throw new HttpError(502, "The payment provider URL is invalid. Contact finance.");
    const destination = new URL(url);
    return NextResponse.redirect(destination, { status: 303, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) { return jsonError(error); }
}
