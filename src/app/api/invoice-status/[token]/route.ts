import { NextResponse } from "next/server";
import { statusTokenHash } from "@/lib/server/razorpay";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { HttpError, jsonError } from "@/lib/server/auth";
import { checkOrigin } from "@/lib/server/login";
import { databaseError } from "@/lib/server/operational";
import { invoiceProviderUrlValid, invoiceWindowExpired } from "@/lib/invoice-policy";
import { issuedInvoicePaymentUrl } from "@/lib/server/invoice-payment-url";
import { invoiceBranding } from "@/lib/invoice-branding";
import { legacyCompany } from "@/lib/billing";
import { loadInvoicePaymentSummary } from "@/lib/server/invoice-payment-summary";

export async function GET(_request: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token))
    return NextResponse.json({ error: "Invoice status is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase.from("invoices")
    .select("invoice_no,created_at,invoice_date,due_date,billing_name,billing_email,billing_address,subtotal,discount_amount,discount_reason,tax_amount,total,currency,status,paid_at,notes,invoice_items(description,quantity,unit_price,amount),company_code,company_snapshot,razorpay_short_url,payment_type,installment_number,course_total,payment_expires_at,tax_review_required,id,parent_invoice_id,document_details")
    .eq("status_token_hash", statusTokenHash(token)).maybeSingle();
  if (error) {
    console.error("INVOICE_PUBLIC_STATUS", { code: error.code });
    return NextResponse.json({ error: "Invoice status could not be loaded. Please try again." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  if (!data)
    return NextResponse.json({ error: "Invoice status is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const status = data.status === "sent" && invoiceWindowExpired(data) ? "expired"
    : data.tax_review_required && data.status !== "paid" ? "pending_review" : data.status;
  if (status === "sent" && data.razorpay_short_url && !invoiceProviderUrlValid(data.razorpay_short_url, data.currency)) {
    console.error("INVOICE_PUBLIC_PAYMENT_URL_INVALID");
    return NextResponse.json({ error: "The Razorpay payment URL is invalid. Contact finance." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  const branding = invoiceBranding({
    ...legacyCompany, ...data.company_snapshot,
    code: data.company_snapshot?.code ?? data.company_code ?? "DMHCA",
    legal_name: data.company_snapshot?.legal_name ?? data.company_code ?? "DMHCA",
  });
  let paymentSummary;
  try { paymentSummary = await loadInvoicePaymentSummary(supabase, data); }
  catch (error) {
    console.error("INVOICE_PUBLIC_PAYMENT_SUMMARY", error);
    return NextResponse.json({ error: "Installment balances could not be loaded. Please try again." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({
    invoiceNo: data.invoice_no,
    issueDate: data.invoice_date ?? data.created_at,
    dueDate: data.due_date,
    billingName: data.billing_name,
    billingEmail: data.billing_email,
    billingAddress: data.billing_address,
    items: Array.isArray(data.invoice_items) ? data.invoice_items.map((item: {
      description: string; quantity: number | string; unit_price: number | string; amount: number | string;
    }) => ({
      description: item.description,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      amount: Number(item.amount),
    })) : [],
    subtotal: Number(data.subtotal),
    discountAmount: Number(data.discount_amount),
    discountReason: data.discount_reason,
    taxAmount: Number(data.tax_amount),
    total: Number(data.total),
    currency: data.currency,
    status,
    paidAt: data.paid_at,
    courseTotal: data.course_total == null ? null : Number(data.course_total),
    installmentNumber: data.installment_number,
    paymentType: data.payment_type,
    notes: data.notes ?? null,
    documentDetails: data.document_details ?? {},
    paymentSummary,
    company: {
      name: branding.legal_name,
      address: data.company_snapshot?.address ?? "",
      taxId: data.company_snapshot?.tax_id ?? "",
      code: branding.code,
      invoiceProfile: data.company_snapshot?.invoice_profile,
    },
    primaryColor: branding.primary_color,
    accentColor: branding.accent_color,
    paymentUrl: status === "sent" && ["one_shot", "installments"].includes(data.payment_type) && ["USD", "INR"].includes(data.currency)
      ? data.razorpay_short_url ?? null : null,
    expiresAt: data.payment_expires_at ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }) {
  try {
    checkOrigin(request);
    const { token } = await context.params;
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new HttpError(404, "Invoice status is unavailable.");
    const admin = getSupabaseAdminClient();
    const { data: invoice, error } = await admin.from("invoices").select("*")
      .eq("status_token_hash", statusTokenHash(token)).maybeSingle();
    databaseError(error);
    if (!invoice) throw new HttpError(404, "Invoice status is unavailable.");
    if (!["one_shot", "installments"].includes(invoice.payment_type)) throw new HttpError(409, "This invoice uses an external financing arrangement.");
    const url = issuedInvoicePaymentUrl(invoice);
    return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
