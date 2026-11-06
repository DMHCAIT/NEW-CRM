import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError } from "@/lib/server/auth";
import { stripeSignatureValid } from "@/lib/server/stripe";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError } from "@/lib/server/operational";
import { sendPaymentReceipt } from "@/lib/server/invoice-delivery";

const sessionSchema = z.object({
  id: z.string().startsWith("cs_").max(255), mode: z.literal("payment"), payment_status: z.literal("paid"),
  client_reference_id: z.string().uuid(), metadata: z.object({ invoice_id: z.string().uuid() }),
  amount_total: z.number().int().positive().safe(), currency: z.literal("usd"),
  payment_intent: z.string().startsWith("pi_").max(255),
});

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 512000) throw new HttpError(413, "Webhook payload is too large.");
    const secret = requireIntegrationValue(await getIntegrationConfig("stripe"), "STRIPE_WEBHOOK_SECRET");
    if (!stripeSignatureValid(raw, request.headers.get("stripe-signature"), secret)) throw new HttpError(401, "Invalid Stripe webhook signature.");
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { throw new HttpError(400, "Invalid webhook JSON."); }
    const event = z.object({ type: z.string(), data: z.object({ object: z.unknown() }) }).safeParse(payload);
    if (!event.success) throw new HttpError(400, "Invalid Stripe event.");
    if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.data.type))
      return NextResponse.json({ ignored: true });
    const pending = z.object({ payment_status: z.string() }).safeParse(event.data.data.object);
    if (event.data.type === "checkout.session.completed" && pending.success && pending.data.payment_status === "unpaid")
      return NextResponse.json({ pending: true });
    const session = sessionSchema.safeParse(event.data.data.object);
    if (!session.success || session.data.client_reference_id !== session.data.metadata.invoice_id)
      throw new HttpError(400, "Invalid paid Stripe Checkout session.");
    const value = session.data;
    const admin = getSupabaseAdminClient();
    const { data: recorded, error } = await admin.rpc("operational_record_stripe_payment", {
      p_invoice_id: value.client_reference_id, p_session_id: value.id, p_payment_id: value.payment_intent,
      p_amount_cents: value.amount_total, p_currency: value.currency, p_payload: payload,
    });
    databaseError(error);
    await sendPaymentReceipt(admin, value.client_reference_id);
    return NextResponse.json({ recorded: Boolean(recorded) });
  } catch (error) { return jsonError(error); }
}
