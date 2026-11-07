import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { appUrl } from "@/lib/server/env";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";

export async function stripeRequest(path: string, body?: URLSearchParams, idempotencyKey?: string) {
  const config = await getIntegrationConfig("stripe");
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${requireIntegrationValue(config, "STRIPE_SECRET_KEY")}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new HttpError(502, `Stripe request failed (HTTP ${response.status}). Check the saved key, account permissions and payment mode.`);
  return response.json() as Promise<unknown>;
}

export async function createStripeCheckout(input: {
  invoiceId: string; invoiceNo: string; amount: number; email: string; statusToken: string;
  expiresAt?: number; previousSessionId?: string | null;
  revision?: number;
}) {
  const amount = Math.round(input.amount * 100);
  if (!Number.isSafeInteger(amount) || amount < 100) throw new HttpError(400, "USD payments require at least $1.");
  const statusUrl = `${appUrl("invoice")}/invoice-status/${encodeURIComponent(input.statusToken)}`;
  const body = new URLSearchParams({
    mode: "payment", client_reference_id: input.invoiceId, customer_email: input.email,
    success_url: statusUrl, cancel_url: statusUrl,
    "metadata[invoice_id]": input.invoiceId,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][price_data][product_data][name]": `Invoice ${input.invoiceNo}`,
    "line_items[0][quantity]": "1",
  });
  if (input.expiresAt !== undefined) body.set("expires_at", String(input.expiresAt));
  const result = z.object({
    id: z.string().startsWith("cs_"), url: z.string().url().refine(value => new URL(value).hostname === "checkout.stripe.com"),
  }).safeParse(await stripeRequest("checkout/sessions", body, `invoice-${input.invoiceId}${(input.revision ?? 1) > 1 ? `-v${input.revision}` : ""}${input.previousSessionId ? `-after-${input.previousSessionId}` : ""}`));
  if (!result.success) throw new HttpError(502, "Stripe returned an invalid Checkout session. Reconcile this invoice before retrying.");
  return result.data;
}

export function stripeSignatureValid(raw: string, header: string | null, secret: string, now = Date.now()) {
  if (!header) return false;
  const parts = header.split(",").map(value => value.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1] ?? "";
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest();
  return parts.filter(([key]) => key === "v1").some(([, signature]) => {
    if (!/^[a-f0-9]{64}$/i.test(signature ?? "")) return false;
    return timingSafeEqual(expected, Buffer.from(signature, "hex"));
  });
}
