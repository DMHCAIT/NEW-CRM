import { invoiceProviderUrlValid, invoiceWindowExpired } from "@/lib/invoice-policy";
import { HttpError } from "@/lib/server/auth";
import { appUrl } from "@/lib/server/env";
import { decryptIntegrationValues } from "@/lib/server/integration-settings";

function invoiceStatusToken(encrypted: string) {
  const { token } = decryptIntegrationValues(encrypted);
  if (!token) throw new HttpError(503, "Invoice payment token is invalid. Reconcile this invoice before opening payment.");
  return encodeURIComponent(token);
}

export function invoiceViewUrl(invoice: { status_token_encrypted?: string | null }) {
  return invoice.status_token_encrypted
    ? `${appUrl("invoice")}/invoice-status/${invoiceStatusToken(invoice.status_token_encrypted)}`
    : undefined;
}

export function issuedInvoicePaymentUrl(invoice: {
  status: string; payment_type: string; currency: string; tax_review_required?: boolean;
  created_at?: string; payment_expires_at?: string | null; razorpay_short_url?: string | null;
}) {
  if (invoice.status !== "sent" || invoice.tax_review_required || !["one_shot", "installments"].includes(invoice.payment_type))
    throw new HttpError(409, invoice.status === "paid" ? "This invoice is already paid. No further payment is required." : "This invoice is not available for online payment.");
  if (invoiceWindowExpired(invoice)) throw new HttpError(410, "The payment window has expired. Contact your lead owner.");
  if (!["INR", "USD"].includes(invoice.currency)) throw new HttpError(409, "This invoice currency is not supported for online payment.");
  if (!invoice.razorpay_short_url) throw new HttpError(409, "The Razorpay payment link has not been issued. Contact finance.");
  if (!invoiceProviderUrlValid(invoice.razorpay_short_url, invoice.currency))
    throw new HttpError(502, "The Razorpay payment URL is invalid. Contact finance.");
  return invoice.razorpay_short_url;
}

export function invoicePaymentUrl(invoice: {
  status: string;
  payment_type: string;
  currency: string;
  tax_review_required?: boolean;
  created_at?: string;
  payment_expires_at?: string | null;
  status_token_encrypted?: string | null;
  razorpay_short_url?: string | null;
}) {
  if (invoice.status !== "sent" || invoice.tax_review_required || invoiceWindowExpired(invoice)
    || !["one_shot", "installments"].includes(invoice.payment_type) || !["INR", "USD"].includes(invoice.currency)) return null;
  if (invoice.razorpay_short_url) {
    if (!invoiceProviderUrlValid(invoice.razorpay_short_url, invoice.currency))
      throw new HttpError(502, "The Razorpay payment URL is invalid. Contact finance.");
    return invoice.razorpay_short_url;
  }
  return null;
}
