import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { razorpayRequest } from "@/lib/server/razorpay";
import { stripeRequest } from "@/lib/server/stripe";

type Invoice = { id: string; total: number | string; currency: string; billing_email?: string | null };
export type VerifiedPayment = {
  provider: "razorpay" | "stripe"; paymentId: string; linkId: string; amount: number; currency: string; url: string;
};
const cents = z.number().int().positive();
const razorpayLink = z.object({
  id: z.string().regex(/^plink_[A-Za-z0-9]+$/), short_url: z.string().url(), status: z.string(),
  amount: cents, amount_paid: z.number().int().nonnegative(), currency: z.string(),
  reference_id: z.string().nullish(), notes: z.object({ invoice_id: z.string().optional() }).passthrough().or(z.array(z.unknown())).optional(),
  customer: z.object({ email: z.string().optional() }).optional(),
  payments: z.array(z.object({ payment_id: z.string().regex(/^pay_[A-Za-z0-9]+$/) })).optional(),
});
const stripeSession = z.object({
  id: z.string().startsWith("cs_"), mode: z.string(), payment_status: z.string(),
  amount_total: z.number().int().nullable(), currency: z.string().nullable(), payment_intent: z.string().nullable(),
  client_reference_id: z.string().nullable().optional(),
  metadata: z.object({ invoice_id: z.string().optional() }).nullish(),
  customer_details: z.object({ email: z.string().nullable() }).nullable().optional(),
  customer_email: z.string().nullable().optional(),
});

function providerData<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(502, "Payment provider returned incomplete verification data.");
  return parsed.data;
}
function sameEmail(email: string | null | undefined, invoice: Invoice) {
  return Boolean(email && invoice.billing_email && email.trim().toLowerCase() === invoice.billing_email.trim().toLowerCase());
}
function matchesInvoice(invoice: Invoice, amount: number, currency: string, email?: string | null, invoiceId?: string | null) {
  return amount === Math.round(Number(invoice.total) * 100) && currency.toUpperCase() === invoice.currency
    && (invoiceId ? invoiceId === invoice.id : sameEmail(email, invoice));
}
function paymentUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, "Enter a valid payment URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new HttpError(400, "Use an HTTPS Razorpay or Stripe payment URL.");
  return url;
}

export async function verifyInvoicePaymentUrl(invoice: Invoice, value: string): Promise<VerifiedPayment> {
  const url = paymentUrl(value);
  if (invoice.currency === "INR" && ["rzp.io", "rzp.in", "payments.razorpay.com"].includes(url.hostname)) {
    let found: z.infer<typeof razorpayLink> | undefined;
    for (let page = 0; page < 10; page++) {
      const result = providerData(z.object({ items: z.array(razorpayLink) }),
        await razorpayRequest(`payment_links?count=100&skip=${page * 100}`));
      found = result.items.find(link => new URL(link.short_url).origin + new URL(link.short_url).pathname === url.origin + url.pathname);
      if (found || result.items.length < 100) break;
    }
    if (!found) throw new HttpError(404, "Payment link not found in the configured Razorpay account (latest 1,000 links). Ask finance to reconcile older links.");
    return verifyRazorpayLink(invoice, found.id, value);
  }
  if (invoice.currency === "USD" && url.hostname === "checkout.stripe.com") {
    const sessionId = url.pathname.match(/\/(cs_(?:test_|live_)?[A-Za-z0-9]+)(?:\/|$)/)?.[1];
    if (!sessionId) throw new HttpError(400, "This Stripe URL does not contain a Checkout session ID.");
    return verifyStripeSession(invoice, sessionId, value);
  }
  if (invoice.currency === "USD" && url.hostname === "buy.stripe.com") {
    let linkId = "";
    let after = "";
    for (let page = 0; page < 10; page++) {
      const result = providerData(z.object({ data: z.array(z.object({ id: z.string(), url: z.string() })), has_more: z.boolean() }),
        await stripeRequest(`payment_links?limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`));
      linkId = result.data.find(link => new URL(link.url).origin + new URL(link.url).pathname === url.origin + url.pathname)?.id ?? "";
      if (linkId || !result.has_more || !result.data.length) break;
      after = result.data[result.data.length - 1].id;
    }
    if (!linkId) throw new HttpError(404, "Payment link not found in the configured Stripe account (latest 1,000 links).");
    const matches: z.infer<typeof stripeSession>[] = [];
    after = "";
    for (let page = 0; page < 10; page++) {
      const result = providerData(z.object({ data: z.array(stripeSession), has_more: z.boolean() }),
        await stripeRequest(`checkout/sessions?payment_link=${encodeURIComponent(linkId)}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`));
      matches.push(...result.data.filter(session => session.payment_status === "paid" && session.mode === "payment"
        && matchesInvoice(invoice, session.amount_total ?? 0, session.currency ?? "",
          session.customer_details?.email ?? session.customer_email, session.metadata?.invoice_id)));
      if (!result.has_more) break;
      if (page === 9 || !result.data.length) throw new HttpError(409, "Too many payments on this link. Paste the specific Stripe Checkout session URL instead.");
      after = result.data[result.data.length - 1].id;
    }
    if (matches.length !== 1) throw new HttpError(409, matches.length ? "Multiple matching payments. Paste the specific Stripe Checkout session URL." : "No matching paid payment exists for this lead, amount and currency.");
    return verifyStripeSession(invoice, matches[0].id, value);
  }
  throw new HttpError(400, "Use a company Razorpay link for INR or Stripe link for USD. Other payments require admin verification with a reference and evidence.");
}

async function verifyRazorpayLink(invoice: Invoice, id: string, url: string): Promise<VerifiedPayment> {
  const link = providerData(razorpayLink, await razorpayRequest(`payment_links/${encodeURIComponent(id)}`));
  const boundId = !Array.isArray(link.notes) ? link.notes?.invoice_id : undefined;
  if (link.status !== "paid") throw new HttpError(409, "Razorpay has not confirmed this payment as paid.");
  if (link.amount_paid !== link.amount || !matchesInvoice(invoice, link.amount, link.currency, link.customer?.email, boundId))
    throw new HttpError(409, "Razorpay payment does not match this invoice's lead, amount and currency.");
  if (link.payments?.length !== 1) throw new HttpError(409, "Split or missing provider payments require admin reconciliation with evidence.");
  const payment = providerData(z.object({ id: z.string(), status: z.string(), amount: cents, currency: z.string() }),
    await razorpayRequest(`payments/${encodeURIComponent(link.payments[0].payment_id)}`));
  if (payment.status !== "captured" || payment.amount !== link.amount || payment.currency !== link.currency)
    throw new HttpError(409, "Razorpay has not captured the exact invoice amount.");
  return { provider: "razorpay", paymentId: payment.id, linkId: link.id, amount: payment.amount, currency: payment.currency, url };
}

async function verifyStripeSession(invoice: Invoice, id: string, url: string): Promise<VerifiedPayment> {
  const session = providerData(stripeSession, await stripeRequest(`checkout/sessions/${encodeURIComponent(id)}`));
  if (session.id !== id || session.mode !== "payment" || session.payment_status !== "paid" || !session.payment_intent)
    throw new HttpError(409, "Stripe has not confirmed this Checkout session as paid.");
  if (!matchesInvoice(invoice, session.amount_total ?? 0, session.currency ?? "",
    session.customer_details?.email ?? session.customer_email, session.metadata?.invoice_id))
    throw new HttpError(409, "Stripe payment does not match this invoice's lead, amount and currency.");
  return { provider: "stripe", paymentId: session.payment_intent, linkId: session.id,
    amount: session.amount_total!, currency: session.currency!.toUpperCase(), url };
}

export async function verifySavedInvoicePayment(invoice: Invoice & {
  razorpay_payment_link_id?: string | null; razorpay_short_url?: string | null;
  stripe_session_id?: string | null; stripe_checkout_url?: string | null;
}) {
  if (invoice.currency === "INR" && invoice.razorpay_payment_link_id)
    return verifyRazorpayLink(invoice, invoice.razorpay_payment_link_id, invoice.razorpay_short_url ?? "");
  if (invoice.currency === "USD" && invoice.stripe_session_id)
    return verifyStripeSession(invoice, invoice.stripe_session_id, invoice.stripe_checkout_url ?? "");
  throw new HttpError(409, "No payment link is saved. Paste the company-generated payment URL or ask finance to reconcile.");
}
