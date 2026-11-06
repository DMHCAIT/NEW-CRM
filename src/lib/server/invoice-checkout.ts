import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { invoiceWindowExpired } from "@/lib/invoice-policy";
import { HttpError } from "@/lib/server/auth";
import { databaseError } from "@/lib/server/operational";
import { createStripeCheckout, stripeRequest } from "@/lib/server/stripe";

type CheckoutInvoice = {
  id: string; invoice_no: string; total: number | string; currency: string; status: string;
  payment_expires_at: string; billing_email?: string | null; tax_review_required?: boolean;
  stripe_session_id?: string | null; stripe_checkout_url?: string | null; stripe_expires_at?: string | null;
  payment_revision?: number;
};
export function stripeCheckoutExpiry(deadline: string, now = Date.now()) {
  const end = Math.floor(new Date(deadline).getTime() / 1000);
  const current = Math.floor(now / 1000);
  if (!Number.isFinite(end) || end <= current) throw new HttpError(410, "The four-day payment window has expired.");
  // Stripe requires 30 minutes per session. The approved final-session grace is capped at deadline + 30 minutes.
  return end - current < 1860 ? end + 1800 : Math.min(end, current + 86340);
}

export async function ensureInvoiceCheckout(admin: SupabaseClient, invoice: CheckoutInvoice, token: string) {
  if (invoiceWindowExpired(invoice)) throw new HttpError(410, "The four-day payment window has expired. Contact your lead owner for a new invoice.");
  if (invoice.status !== "sent" || invoice.tax_review_required || invoice.currency !== "USD")
    throw new HttpError(409, "This invoice is not available for Stripe payment.");
  if (!invoice.billing_email) throw new HttpError(409, "The invoice billing email is missing. Contact finance.");
  if (invoice.stripe_session_id) {
    const result = z.object({
      id: z.string(), status: z.enum(["open", "complete", "expired"]), payment_status: z.string(),
      expires_at: z.number().int(), url: z.string().url().nullable(),
    }).safeParse(await stripeRequest(`checkout/sessions/${encodeURIComponent(invoice.stripe_session_id)}`));
    if (!result.success || result.data.id !== invoice.stripe_session_id) throw new HttpError(502, "Stripe returned invalid session state. Contact finance.");
    if (result.data.status === "complete" || result.data.payment_status === "paid")
      throw new HttpError(409, "Stripe is processing or confirming this payment. Refresh the invoice status; do not pay twice.");
    if (result.data.status === "open" && result.data.expires_at * 1000 > Date.now() && result.data.url) {
      if (new URL(result.data.url).hostname !== "checkout.stripe.com") throw new HttpError(502, "Stripe returned an invalid payment URL.");
      return result.data.url;
    }
    if (result.data.status !== "expired") throw new HttpError(409, "Stripe session needs reconciliation before renewal.");
  }
  const lease = new Date().toISOString();
  let claim = admin.from("invoices").update({ payment_link_lock_at: lease }).eq("id", invoice.id)
    .eq("status", "sent").eq("tax_review_required", false).is("payment_link_lock_at", null);
  claim = invoice.stripe_session_id ? claim.eq("stripe_session_id", invoice.stripe_session_id) : claim.is("stripe_session_id", null);
  const { data: claimed, error: claimError } = await claim.select("id").maybeSingle();
  databaseError(claimError);
  if (!claimed) throw new HttpError(409, "Checkout creation is in progress or requires reconciliation. Refresh before retrying.");
  const expiresAt = stripeCheckoutExpiry(invoice.payment_expires_at);
  const session = await createStripeCheckout({
    invoiceId: invoice.id, invoiceNo: invoice.invoice_no, amount: Number(invoice.total),
    email: invoice.billing_email, statusToken: token, expiresAt, previousSessionId: invoice.stripe_session_id,
    revision: invoice.payment_revision,
  });
  const { error: historyError } = await admin.from("invoice_checkout_sessions").insert({
    session_id: session.id, invoice_id: invoice.id, expires_at: new Date(expiresAt * 1000).toISOString(),
  });
  databaseError(historyError);
  const { data: saved, error: saveError } = await admin.from("invoices").update({
    stripe_session_id: session.id, stripe_checkout_url: session.url,
    stripe_expires_at: new Date(expiresAt * 1000).toISOString(), payment_link_lock_at: null,
  }).eq("id", invoice.id).eq("payment_link_lock_at", lease).eq("status", "sent").select("id").maybeSingle();
  databaseError(saveError);
  if (!saved) throw new HttpError(409, "Checkout was created but the invoice changed. Contact finance before paying.");
  return session.url;
}
