import { NextResponse } from "next/server";
import { HttpError, jsonError } from "@/lib/server/auth";
import { razorpaySignatureValid } from "@/lib/server/razorpay";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError } from "@/lib/server/operational";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";
import { sendPaymentReceipt } from "@/lib/server/invoice-delivery";

type RazorpayEntity = {
  id?: unknown;
  status?: unknown;
  reference_id?: unknown;
  amount?: unknown;
  currency?: unknown;
  method?: unknown;
};
type RazorpayWebhookEvent = {
  event?: unknown;
  payload?: {
    payment_link?: { entity?: RazorpayEntity };
    payment?: { entity?: RazorpayEntity };
  };
};

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const signature = request.headers.get("x-razorpay-signature");
    if (!signature || !razorpaySignatureValid(raw, signature, requireIntegrationValue(await getIntegrationConfig("razorpay"), "RAZORPAY_WEBHOOK_SECRET")))
      throw new HttpError(401, "Invalid webhook signature.");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, "Invalid JSON."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Invalid event payload.");
    const event = parsed as RazorpayWebhookEvent;
    if (event.event !== "payment_link.paid") return NextResponse.json({ ignored: true });
    const link = event.payload?.payment_link?.entity;
    const payment = event.payload?.payment?.entity;
    if (!link || !payment || typeof link.id !== "string" || !link.id || link.id.length > 100 || link.status !== "paid" ||
      typeof link.reference_id !== "string" || !link.reference_id ||
      typeof payment.id !== "string" || !payment.id || payment.id.length > 100 ||
      payment.status !== "captured" || typeof payment.amount !== "number" || !Number.isSafeInteger(payment.amount) || payment.amount <= 0 ||
      typeof link.amount !== "number" || !Number.isSafeInteger(link.amount) || link.amount <= 0 || link.amount !== payment.amount ||
      typeof payment.currency !== "string" || !/^[A-Z]{3}$/.test(payment.currency) || payment.currency !== link.currency) {
      throw new HttpError(400, "Invalid captured payment-link event.");
    }
    const admin = getSupabaseAdminClient();
    const { data: invoice, error } = await admin.from("invoices")
      .select("id,invoice_no,total,currency,status,razorpay_payment_link_id")
      .eq("razorpay_payment_link_id", link.id).maybeSingle();
    databaseError(error);
    if (!invoice || invoice.id !== link.reference_id || Math.round(Number(invoice.total) * 100) !== payment.amount || invoice.currency !== payment.currency)
      throw new HttpError(400, "Razorpay payment link does not match an invoice.");
    const { data: recorded, error: paymentError } = await admin.rpc("operational_record_payment_link", {
      p_invoice_id: invoice.id,
      p_link_id: link.id,
      p_payment_id: payment.id,
      p_amount_paise: payment.amount,
      p_currency: payment.currency,
      p_method: typeof payment.method === "string" ? payment.method : null,
      p_payload: event,
    });
    databaseError(paymentError);
    await sendPaymentReceipt(admin, invoice.id);
    return NextResponse.json({ recorded: Boolean(recorded) });
  } catch (error) { return jsonError(error); }
}
