import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { databaseError } from "@/lib/server/operational";
import { razorpayRequest } from "@/lib/server/razorpay";
import { stripeRequest } from "@/lib/server/stripe";

export async function cancelInvoicePaymentLinks(admin: SupabaseClient, invoice: {
  id: string; razorpay_payment_link_id?: string | null; stripe_session_id?: string | null;
  payment_link_lock_at?: string | null; email_lock_at?: string | null;
}) {
  if (invoice.payment_link_lock_at || invoice.email_lock_at) throw new HttpError(409, "An interrupted payment or email operation needs finance reconciliation before this invoice can be changed.");
  const lease = new Date().toISOString();
  const { data: claimed, error: claimError } = await admin.from("invoices").update({ payment_link_lock_at: lease })
    .eq("id", invoice.id).in("status", ["sent", "pending_approval"]).is("payment_link_lock_at", null).is("email_lock_at", null).select("id").maybeSingle();
  databaseError(claimError);
  if (!claimed) throw new HttpError(409, "Invoice changed or payment operations are in progress. Refresh before retrying.");
  if (invoice.razorpay_payment_link_id) {
    const path = `payment_links/${encodeURIComponent(invoice.razorpay_payment_link_id)}`;
    const link = z.object({ status: z.string(), amount_paid: z.number() }).parse(await razorpayRequest(path));
    if (link.amount_paid > 0 || !["created", "cancelled", "expired"].includes(link.status))
      throw new HttpError(409, "This Razorpay link has a payment or uncertain state. Reconcile received funds before changing this invoice.");
    if (link.status === "created") {
      const cancelled = z.object({ status: z.literal("cancelled") }).safeParse(await razorpayRequest(`${path}/cancel`, "POST"));
      if (!cancelled.success) throw new HttpError(502, "Razorpay did not confirm cancellation. Finance reconciliation is required.");
    }
  }
  if (invoice.stripe_session_id) {
    const path = `checkout/sessions/${encodeURIComponent(invoice.stripe_session_id)}`;
    const session = z.object({ status: z.string(), payment_status: z.string() }).parse(await stripeRequest(path));
    if (session.status === "complete" || session.payment_status === "paid")
      throw new HttpError(409, "This Stripe session is paid or processing. Reconcile received funds before changing this invoice.");
    if (session.status === "open") {
      const expired = z.object({ status: z.literal("expired") }).safeParse(await stripeRequest(`${path}/expire`, new URLSearchParams()));
      if (!expired.success) throw new HttpError(502, "Stripe did not confirm expiration. Finance reconciliation is required.");
    } else if (session.status !== "expired") throw new HttpError(409, "The Stripe session state needs finance reconciliation.");
  }
  const { data: saved, error } = await admin.from("invoices").update({
    razorpay_payment_link_id: null, razorpay_short_url: null, stripe_session_id: null,
    stripe_checkout_url: null, stripe_expires_at: null, payment_link_lock_at: null,
  }).eq("id", invoice.id).eq("payment_link_lock_at", lease).in("status", ["sent", "pending_approval"]).select("id").maybeSingle();
  databaseError(error);
  if (!saved) throw new HttpError(409, "Provider links were cancelled, but the invoice changed. Finance reconciliation is required.");
}
