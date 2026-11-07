import { legacyCompany, type BillingCompany } from "@/lib/billing";
import { escapeHtml } from "@/lib/html";
import { invoiceBranding } from "@/lib/invoice-branding";
import { invoiceWindowExpired } from "@/lib/invoice-policy";

export type InvoiceDocumentRecord = {
  invoice_no: string;
  status: string;
  lead_id: string;
  created_at: string;
  invoice_date?: string | null;
  due_date: string | null;
  invoice_items?: { description: string; quantity: number | string; unit_price: number | string; amount: number | string }[];
  subtotal: number | string;
  currency: string;
  discount_amount: number | string;
  discount_reason: string | null;
  tax_amount: number | string;
  total: number | string;
  notes: string | null;
  payment_type?: string;
  course_total?: number | string | null;
  installment_number?: number | null;
  payment_expires_at?: string | null;
  paid_at?: string | null;
  tax_review_required?: boolean;
  company_snapshot?: BillingCompany | null;
  company_code?: string | null;
  billing_name?: string | null;
  billing_email?: string | null;
  billing_address?: string | null;
};

export function buildInvoiceHtml(invoice: InvoiceDocumentRecord, options: {
  leadName?: string | null;
  leadEmail?: string | null;
  logoBaseUrl?: string;
  logoUrl?: string;
  paymentUrl?: string | null;
  viewUrl?: string;
  remainingBalance?: number;
} = {}) {
  const brand = invoiceBranding(invoice.company_snapshot ?? {
    ...legacyCompany, code: invoice.company_code === "IBMP" ? "IBMP" : "DMHCA",
    legal_name: invoice.company_code ?? legacyCompany.legal_name,
  });
  const money = (value: number | string) => escapeHtml(new Intl.NumberFormat("en-IN", {
    style: "currency", currency: invoice.currency,
  }).format(Number(value)));
  const date = (value: string | null) => value
    ? escapeHtml(new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)))
    : "On receipt";
  const status = invoice.tax_review_required && invoice.status !== "paid" ? "pending_review"
    : ["sent", "pending_approval"].includes(invoice.status) && invoiceWindowExpired(invoice) ? "expired" : invoice.status;
  const label = ({ sent: "Awaiting payment", paid: "Paid", scheduled: "Scheduled", expired: "Expired", cancelled: "Cancelled", rejected: "Rejected",
    pending_approval: "Pending approval", pending_review: "Pending finance review" } as Record<string, string>)[status] ?? status.replaceAll("_", " ");
  const statusColors = status === "paid" ? { background: "#e7f5ee", color: "#176443" }
    : ["expired", "cancelled", "rejected"].includes(status) ? { background: "#fcebec", color: "#a12836" }
    : { background: "#fff4dd", color: "#805b13" };
  const heading = (value: string) => `<h2 style="margin:0 0 12px;font-size:11px;letter-spacing:1px;color:${brand.primary_color}">${value}</h2>`;
  const row = (label: string, value: string, total = false) => `<tr style="${total ? `background:${brand.accent_color};color:#fff;font-weight:700` : ""}"><td style="padding:9px 12px;border-bottom:1px solid #e7ecf2">${label}</td><td align="right" style="padding:9px 12px;border-bottom:1px solid #e7ecf2;white-space:nowrap">${value}</td></tr>`;
  const cell = "padding:11px 8px;border-bottom:1px solid #e7ecf2;vertical-align:top";
  const online = ["one_shot", "installments"].includes(invoice.payment_type ?? "");
  const paymentUrl = options.paymentUrl && (/^https:\/\/[^\s]+$/i.test(options.paymentUrl)
    || /^\/api\/invoice-status\/[A-Za-z0-9_-]{40,60}\/pay$/.test(options.paymentUrl)) && online && status === "sent"
    ? options.paymentUrl : null;
  const viewUrl = options.viewUrl && /^https:\/\//i.test(options.viewUrl) ? options.viewUrl : null;
  const deadline = invoice.payment_expires_at ? escapeHtml(new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
  }).format(new Date(invoice.payment_expires_at))) + " IST" : null;
  const paymentType = invoice.payment_type === "installments" ? `Installment ${invoice.installment_number ?? 1}`
    : ["loan", "emi"].includes(invoice.payment_type ?? "") ? `${invoice.payment_type?.toUpperCase()} financing` : "Full payment";
  const paymentNote = status === "paid" ? "Payment has been verified. No further payment is required for this invoice."
    : status === "expired" ? "The payment window has expired. Contact your lead owner to reconcile this invoice."
    : ["cancelled", "rejected"].includes(status) ? "This invoice is closed. No payment should be made against it."
    : status === "pending_review" ? "Finance review is required before payment is available."
    : status === "pending_approval" ? "Discount approval is required. The invoice and payment link will be emailed automatically after approval."
    : status === "scheduled" ? "The invoice and payment link will be emailed on the scheduled invoice date after approval."
    : online ? `Pay securely with ${invoice.currency === "USD" ? "Stripe" : "Razorpay"}. Payment is marked paid only after verified confirmation.`
    : "Contact your counselor for financing confirmation. Finance verifies the disbursement before marking the invoice paid.";

  return `<table class="invoice-document" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:820px;margin:0 auto;background:#fff;color:#26364b;font:13px/1.6 Arial,sans-serif;border:1px solid #e1e7ef;border-collapse:collapse">
<tbody><tr><td style="padding:0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody><tr>
<td style="padding:22px;background:${brand.primary_color};color:#fff;width:64%"><table role="presentation" cellpadding="0" cellspacing="0"><tbody><tr><td style="padding-right:14px"><img src="${escapeHtml(options.logoUrl ?? (options.logoBaseUrl ?? "") + brand.logo)}" alt="${brand.code} logo" width="68" style="display:block;width:68px;height:68px;object-fit:contain;background:#fff;border-radius:6px;padding:4px"></td><td style="color:#fff;font-family:Arial,Helvetica,sans-serif;font-size:28px;line-height:1.2;font-weight:800;letter-spacing:1px;vertical-align:middle;overflow-wrap:anywhere">${escapeHtml(brand.legal_name)}</td></tr></tbody></table></td>
<td align="right" style="padding:22px 22px 22px 38px;background:${brand.accent_color};background-image:linear-gradient(125deg,${brand.primary_color} 0%,${brand.primary_color} 13%,#fff 13%,#fff 15%,${brand.accent_color} 15%);color:#fff;vertical-align:middle"><strong style="font-size:24px;letter-spacing:2px">INVOICE</strong></td>
</tr></tbody></table></td></tr>
<tr><td style="padding:24px">
<table class="invoice-parties" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed"><tbody><tr>
<td width="48%" style="vertical-align:top;padding-right:16px;overflow-wrap:anywhere"><div style="padding:20px;border:1px solid #e1e7ef;border-top:3px solid ${brand.accent_color};border-radius:6px;background:#fff">${heading("BILL TO")}<strong style="display:block;margin-bottom:10px;font-size:19px;line-height:1.35;color:${brand.primary_color}">${escapeHtml(invoice.billing_name || options.leadName || "Customer")}</strong><div style="white-space:pre-line;color:#526277;line-height:1.8">${escapeHtml(invoice.billing_address ?? "")}</div><div style="margin-top:6px;color:#526277;line-height:1.8;overflow-wrap:anywhere">${escapeHtml(invoice.billing_email || options.leadEmail || "")}</div></div></td>
<td width="52%" style="vertical-align:top;overflow-wrap:anywhere"><div style="padding:20px;border:1px solid #e1e7ef;border-top:3px solid ${brand.primary_color};border-radius:6px;background:#f6f8fb">${heading("INVOICE DETAILS")}<strong style="display:block;margin-bottom:14px;font-size:15px;line-height:1.4;color:${brand.primary_color};overflow-wrap:anywhere">${escapeHtml(invoice.invoice_no)}</strong><div style="padding:10px 0;border-top:1px solid #e1e7ef;border-bottom:1px solid #e1e7ef;color:#526277;line-height:1.9">Invoice date: ${date(invoice.invoice_date ?? invoice.created_at)}<br>Due date: ${date(invoice.due_date)}</div><div style="margin-top:14px"><span style="display:inline-block;padding:5px 10px;border-radius:4px;background:${statusColors.background};color:${statusColors.color};font-size:12px;line-height:1.5">Status: <strong>${escapeHtml(label)}</strong></span></div>${status === "paid" && invoice.paid_at ? `<div style="margin-top:10px;color:#526277">Paid on: ${date(invoice.paid_at)}</div>` : ""}${brand.tax_id ? `<div style="margin-top:10px;color:#526277">Tax ID: ${escapeHtml(brand.tax_id)}</div>` : ""}</div></td>
</tr></tbody></table>
<table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;border-collapse:collapse;font-size:12px"><thead><tr style="background:${brand.accent_color};color:#fff">${["No.", "Course / Description", "Qty", "Price", "Amount"].map((label, index) => `<th align="${index > 1 ? "right" : "left"}" style="padding:10px 8px;font-size:11px">${label}</th>`).join("")}</tr></thead>
<tbody>${(invoice.invoice_items ?? []).map((item, index) => `<tr style="background:${index % 2 ? "#fff" : "#f6f8fb"}"><td style="${cell}">${index + 1}</td><td style="${cell};white-space:pre-line;overflow-wrap:anywhere">${escapeHtml(item.description)}</td><td align="right" style="${cell}">${escapeHtml(String(item.quantity))}</td><td align="right" style="${cell}">${money(item.unit_price)}</td><td align="right" style="${cell}">${money(item.amount)}</td></tr>`).join("")}</tbody></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody><tr>
<td width="48%" style="vertical-align:top;padding-right:20px">${heading("PAYMENT SCHEDULE")}<strong>${escapeHtml(paymentType)}</strong><table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-collapse:collapse;font-size:12px"><thead><tr style="background:${brand.primary_color};color:#fff"><th align="left" style="padding:8px">Due date</th><th align="right" style="padding:8px">Amount</th></tr></thead><tbody><tr><td style="${cell}">${date(invoice.due_date)}</td><td align="right" style="${cell}">${money(invoice.total)}</td></tr></tbody></table>
${paymentUrl ? `<p style="margin:18px 0"><a href="${escapeHtml(paymentUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:${brand.accent_color};color:#fff;border-radius:4px;padding:11px 18px;text-decoration:none;font-weight:bold">Pay Now ${money(invoice.total)}</a></p>` : viewUrl ? `<p><a href="${escapeHtml(viewUrl)}" style="color:${brand.primary_color}">View complete invoice</a></p>` : ""}
${invoice.payment_type === "installments" && invoice.course_total != null ? `<p style="color:#637187;font-size:12px">Full course total: ${money(invoice.course_total)}</p>` : ""}</td>
<td width="52%" style="vertical-align:top"><table class="invoice-document-totals" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px"><tbody>
${row("Subtotal", money(invoice.subtotal))}${row("Discount", money(Number(invoice.discount_amount) > 0 ? -Number(invoice.discount_amount) : 0))}${row("Taxable value", money(Number(invoice.subtotal) - Number(invoice.discount_amount)))}${row(invoice.currency === "INR" ? "GST" : "Tax", money(invoice.tax_amount))}${row(status === "paid" ? "Amount paid" : "Current payment due", money(invoice.total), true)}
${options.remainingBalance != null ? row("Remaining course balance", money(options.remainingBalance)) : ""}</tbody></table></td>
</tr></tbody></table>
<div style="margin-top:24px;padding-top:18px;border-top:1px solid #e7ecf2">${heading("PAYMENT DETAILS")}<p style="margin:0">${escapeHtml(paymentNote)}</p>
${deadline && status !== "paid" ? `<p style="margin:8px 0 0;font-size:12px;color:#637187">Payment deadline: ${deadline}${invoice.currency === "USD" ? ". A final Stripe session may run up to 30 minutes beyond this deadline." : ""}</p>` : ""}
${invoice.discount_reason ? `<p style="margin:8px 0 0">Discount reason: ${escapeHtml(invoice.discount_reason)}</p>` : ""}
${invoice.notes ? `<p style="white-space:pre-line;margin:8px 0 0">${escapeHtml(invoice.notes)}</p>` : ""}</div>
</td></tr><tr><td style="padding:20px 24px;background:${brand.accent_color};color:#fff"><strong style="font-size:16px">${escapeHtml(brand.legal_name)}</strong><div style="white-space:pre-line;font-size:12px">${escapeHtml(brand.address)}</div>${brand.tax_id ? `<div style="font-size:11px">Tax ID: ${escapeHtml(brand.tax_id)}</div>` : ""}</td></tr></tbody></table>`;
}
