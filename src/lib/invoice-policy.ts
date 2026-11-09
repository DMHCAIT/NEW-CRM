export const INVOICE_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
export const invoiceTaxPercent = (currency: string) => currency === "INR" ? 18 : 0;
export const invoiceDeadline = (createdAt: string) => new Date(new Date(createdAt).getTime() + INVOICE_WINDOW_MS).toISOString();
export const invoicePaymentReference = (id: string, revision = 1) => revision > 1 ? `${id.slice(0, 28)}-v${revision}` : id;
export const invoiceStatusShouldRefresh = (status: string) =>
  ["sent", "pending_approval", "pending_review", "scheduled", "expired"].includes(status);
export function invoiceProviderUrlValid(value: string, currency: string) {
  try {
    const url = new URL(value);
    const hosts = ["INR", "USD"].includes(currency) ? ["rzp.io", "rzp.in", "razorpay.com", "pages.razorpay.com", "payments.razorpay.com"] : [];
    return url.protocol === "https:" && !url.username && !url.password && !url.port && hosts.includes(url.hostname);
  } catch { return false; }
}
export function invoiceWindowExpired(invoice: { payment_expires_at?: string | null; created_at?: string }, now = Date.now()) {
  const deadline = invoice.payment_expires_at ?? (invoice.created_at ? invoiceDeadline(invoice.created_at) : null);
  return deadline !== null && new Date(deadline).getTime() <= now;
}
