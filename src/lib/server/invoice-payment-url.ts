import { invoiceProviderUrlValid, invoiceWindowExpired } from "@/lib/invoice-policy";
import { HttpError } from "@/lib/server/auth";
import { appUrl } from "@/lib/server/env";
import { decryptIntegrationValues } from "@/lib/server/integration-settings";

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
  if (invoice.currency === "INR" && invoice.razorpay_short_url) {
    if (!invoiceProviderUrlValid(invoice.razorpay_short_url, "INR"))
      throw new HttpError(502, "The Razorpay payment URL is invalid. Contact finance.");
    return invoice.razorpay_short_url;
  }
  if (!invoice.status_token_encrypted) return null;
  const { token } = decryptIntegrationValues(invoice.status_token_encrypted);
  if (!token) throw new HttpError(503, "Invoice payment token is invalid. Reconcile this invoice before opening payment.");
  return `${appUrl("invoice")}/api/invoice-status/${encodeURIComponent(token)}/pay`;
}
