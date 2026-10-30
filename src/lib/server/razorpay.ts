import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { requireEnv } from "@/lib/server/env";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";

async function authHeader() {
  const config = await getIntegrationConfig("razorpay");
  return `Basic ${Buffer.from(`${requireIntegrationValue(config, "RAZORPAY_KEY_ID")}:${requireIntegrationValue(config, "RAZORPAY_KEY_SECRET")}`).toString("base64")}`;
}

export type RazorpayPaymentLink = { id: string; short_url: string; status: string };

export function createPublicStatusToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
}

/** Creates a fixed-amount Razorpay Payment Link. */
export async function createInvoicePaymentLink(input: {
  invoiceId: string; invoiceNo: string; leadId: string; leadName: string; leadEmail: string;
  amount: number; currency: string;
}) {
  const amountPaise = Math.round(input.amount * 100);
  if (amountPaise < 100) throw new Error("Invoice total must be at least ₹1 to create a Razorpay Payment Link.");
  const response = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    redirect: "error",
    headers: { Authorization: await authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amountPaise,
      currency: input.currency,
      reference_id: input.invoiceId,
      description: `Invoice ${input.invoiceNo}`.slice(0, 255),
      customer: { name: input.leadName.slice(0, 100), email: input.leadEmail },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { invoice_id: input.invoiceId, lead_id: input.leadId, invoice_no: input.invoiceNo },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json() as RazorpayPaymentLink & { error?: { description?: string } };
  if (!response.ok || !payload.id || !payload.short_url)
    throw new Error(`Razorpay Payment Link creation failed: ${payload.error?.description ?? response.status}`);
  return payload;
}

export function razorpaySignatureValid(rawBody: string, signature: string | null, secret = requireEnv("RAZORPAY_WEBHOOK_SECRET")) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function statusTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
