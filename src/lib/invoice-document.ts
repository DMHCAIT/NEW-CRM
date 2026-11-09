import type { BillingCompany, InvoiceDocumentDetails } from "@/lib/billing";
import { escapeHtml } from "@/lib/html";
import { installmentLabel } from "@/lib/invoice-schedule";
import { invoicePresentation } from "@/lib/invoice-presentation";
import type { InstallmentPaymentSummary } from "@/lib/invoice-payment-summary";

export type InvoiceDocumentRecord = {
  invoice_no: string; status: string; lead_id: string; created_at: string; invoice_date?: string | null; due_date: string | null;
  invoice_items?: { description: string; quantity: number | string; unit_price: number | string; amount: number | string }[];
  subtotal: number | string; currency: string; discount_amount: number | string; discount_reason: string | null;
  tax_amount: number | string; total: number | string; notes: string | null; payment_type?: string;
  course_total?: number | string | null; installment_number?: number | null; payment_expires_at?: string | null;
  paid_at?: string | null; tax_review_required?: boolean; company_snapshot?: BillingCompany | null; company_code?: string | null;
  billing_name?: string | null; billing_email?: string | null; billing_address?: string | null;
  document_details?: Partial<InvoiceDocumentDetails>;
  payment_summary?: InstallmentPaymentSummary;
};

export function buildInvoiceHtml(invoice: InvoiceDocumentRecord, options: {
  leadName?: string | null; leadEmail?: string | null; logoBaseUrl?: string; logoUrl?: string;
  paymentUrl?: string | null; viewUrl?: string; remainingBalance?: number;
} = {}) {
  const { company: brand, footerName, gstNumber, status, label, terms, items, taxes, canPay } = invoicePresentation(invoice);
  const dmhca = brand.code === "DMHCA";
  const details = invoice.document_details ?? {};
  const summary = invoice.payment_summary;
  const money = (value: number | string) => escapeHtml(new Intl.NumberFormat("en-IN", {
    style: "currency", currency: invoice.currency,
  }).format(Number(value)));
  const date = (value: string | null) => value
    ? escapeHtml(new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)))
    : "On receipt";
  const paymentUrl = options.paymentUrl && (/^https:\/\/[^\s]+$/i.test(options.paymentUrl)
    || /^\/api\/invoice-status\/[A-Za-z0-9_-]{40,60}\/pay$/.test(options.paymentUrl)) && canPay ? options.paymentUrl : null;
  const heading = (value: string) => `<h2 style="margin:0 0 10px;font-size:12px;letter-spacing:.6px;color:${brand.primary_color}">${value}</h2>`;
  const cell = "padding:9px 8px;border-bottom:1px solid #e1e7ef;vertical-align:top";
  const row = (name: string, value: string, total = false) => `<tr style="background:${total ? brand.accent_color : dmhca ? "#f7f8fa" : "#f4f6f9"};color:${total ? "#fff" : "#26364b"}"><td style="${cell};font-weight:${total ? 700 : 400}">${name}</td><td align="right" style="${cell};white-space:nowrap">${value}</td></tr>`;
  const field = (name: string, value: string | undefined | null) => value ? `<div style="padding:3px 0;line-height:1.6"><strong>${name}:</strong> ${escapeHtml(value)}</div>` : "";
  const banks = brand.invoice_profile?.bank_accounts ?? [];
  const paymentType = invoice.payment_type === "installments" ? installmentLabel(invoice.installment_number ?? 1)
    : ["loan", "emi"].includes(invoice.payment_type ?? "") ? `${invoice.payment_type?.toUpperCase()} financing` : "Full payment";
  const paymentNote = status === "paid" ? "Payment has been verified. No further payment is required for this invoice."
    : status === "expired" ? "The payment window has expired. Contact your lead owner to reconcile this invoice."
    : ["cancelled", "rejected"].includes(status) ? "This invoice is closed. No payment should be made against it."
    : status === "pending_review" ? "Finance review is required before payment is available."
    : status === "pending_approval" ? "Discount approval is required before the invoice and payment link are emailed."
    : status === "scheduled" ? "The invoice and payment link will be emailed on the scheduled invoice date after approval."
    : ["loan", "emi"].includes(invoice.payment_type ?? "") ? "Contact the finance team for financing confirmation. Finance verifies the disbursement before marking the invoice paid."
    : "Pay securely with Razorpay. Only verified payments are marked paid.";
  const schedule = summary?.schedule ?? [{ number: invoice.installment_number ?? 1, amount: Number(invoice.total), dueDate: invoice.due_date, status, current: true }];
  const badgeColor = status === "paid" ? "#167844" : brand.accent_color;
  const paymentButton = status === "paid"
    ? `<span role="status" style="display:inline-block;background:#167844;color:#fff;padding:11px 18px;font-weight:bold;border-radius:4px">Paid ${money(invoice.total)}</span>`
    : paymentUrl ? `<a class="invoice-pay-button" href="${escapeHtml(paymentUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;width:auto;background:${brand.primary_color};color:#fff;padding:11px 22px;text-decoration:none;font-size:15px;line-height:1.4;font-weight:bold;border:1px solid ${brand.primary_color};border-bottom:3px solid ${brand.accent_color};border-radius:8px;box-shadow:0 3px 6px #00000026;cursor:pointer">Pay Now</a><span style="display:block;margin-top:8px;font-size:11px;color:#637187">Click Pay Now to make a secure payment.</span>`
    : "";
  return `<style>.invoice-document-footer,.invoice-document-footer *{color:#fff!important}.invoice-document-footer a{text-decoration:none!important}</style><table class="invoice-document" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:820px;min-width:560px;margin:0 auto;background:#fff;color:#26364b;font:13px/1.5 Arial,sans-serif;border:1px solid #e1e7ef;border-collapse:collapse"><tbody>
<tr><td><table class="invoice-document-header" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${dmhca ? "border-bottom:1px solid #cbd5e1" : ""}"><tbody><tr>
<td width="58%" style="padding:${dmhca ? "22px 28px;background:#fff" : `20px 24px;background:${brand.primary_color}`}"><img src="${escapeHtml(options.logoUrl ?? (options.logoBaseUrl ?? "") + brand.logo)}" alt="${brand.code} logo" width="${dmhca ? 160 : 145}" style="${dmhca ? "display:block;width:160px;height:auto;border:0" : "display:block;width:145px;max-height:65px;object-fit:contain;background:#fff;border-radius:5px;padding:4px"}"></td>
<td align="right" style="padding:20px 24px;background:${brand.accent_color};background-image:linear-gradient(125deg,${dmhca ? `#fff 0%,#fff 9%,${brand.primary_color} 9%,${brand.primary_color} 23%,${brand.accent_color} 23%` : `${brand.primary_color} 0%,${brand.primary_color} 12%,#fff 12%,#fff 14%,${brand.accent_color} 14%`});color:#fff"><strong style="font-size:25px;letter-spacing:2px">INVOICE</strong></td>
</tr></tbody></table></td></tr>
<tr><td style="padding:${dmhca ? "28px 28px" : "22px 24px"}">
<table class="invoice-parties" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed"><tbody><tr>
<td width="50%" style="vertical-align:top;padding-right:20px;overflow-wrap:anywhere">${heading("BILL TO")}
<strong style="display:block;padding:3px 0;font-size:15px;line-height:1.6">${escapeHtml(invoice.billing_name || options.leadName || "Customer")}</strong>
<div style="padding:3px 0;line-height:1.6;white-space:pre-line">${escapeHtml(invoice.billing_address ?? "")}</div>
${field("Email", invoice.billing_email || options.leadEmail)}${field("Phone", details.billing_phone)}${field("Student ID", details.student_id)}${field("Place of supply", details.place_of_supply)}</td>
<td class="invoice-document-details" width="50%" style="vertical-align:top;overflow-wrap:anywhere">${heading("INVOICE DETAILS")}
${field("Invoice No", invoice.invoice_no)}${field("Invoice date", date(invoice.invoice_date ?? invoice.created_at))}${field("Due date", date(invoice.due_date))}
${dmhca ? field("GST", gstNumber) : field("Payment type", paymentType) + field("Issued by", brand.legal_name) + field("Tax ID", brand.tax_id)}
${dmhca ? "" : `<div style="margin-top:8px"><span style="display:inline-block;border-radius:4px;padding:4px 10px;background:${badgeColor};color:#fff">Status: <strong>${escapeHtml(label)}</strong></span></div>`}
${status === "paid" && invoice.paid_at ? field("Paid on", date(invoice.paid_at)) : ""}</td>
</tr></tbody></table>
<table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;border-collapse:collapse;font-size:12px"><thead><tr style="background:${brand.accent_color};color:#fff">${["No.", "Course / Description", "Qty", "Price", "Discount", ...taxes.map(tax => tax.label), "Total"].map((name, index) => `<th align="${index > 1 ? "right" : "left"}" style="padding:10px 8px">${name}</th>`).join("")}</tr></thead><tbody>
${items.map((item, index) => `<tr style="background:${index % 2 ? "#fff" : dmhca ? "#f7f8fa" : "#f4f6f9"}"><td style="${cell}">${index + 1}</td><td style="${cell};overflow-wrap:anywhere"><strong>${escapeHtml(item.description)}</strong>${details.course_details ? `<div>${escapeHtml(details.course_details)}</div>` : ""}${details.sac_code ? `<small>SAC: ${escapeHtml(details.sac_code)}</small>` : ""}</td><td align="right" style="${cell}">${escapeHtml(String(item.quantity))}</td><td align="right" style="${cell}">${money(item.unit_price)}</td><td align="right" style="${cell}">${money(item.discount)}</td>${item.taxes.map(amount => `<td align="right" style="${cell}">${money(amount)}</td>`).join("")}<td align="right" style="${cell}">${money(item.total)}</td></tr>`).join("")}
</tbody></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tbody><tr>
<td width="52%" style="vertical-align:top;padding-right:20px">${heading("PAYMENT SCHEDULE")}
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px"><thead><tr style="background:${brand.primary_color};color:#fff">${["Installment", "Due date", "Amount", "Status"].map(name => `<th style="padding:8px">${name}</th>`).join("")}</tr></thead><tbody>
${schedule.map(entry => `<tr style="${entry.current ? "font-weight:bold;" : ""}"><td style="${cell}">${invoice.payment_type === "installments" ? escapeHtml(installmentLabel(entry.number)) : escapeHtml(paymentType)}</td><td style="${cell}">${date(entry.dueDate)}</td><td align="right" style="${cell}">${money(entry.amount)}</td><td style="${cell};color:${entry.status === "paid" ? "#167844" : "#637187"}">${escapeHtml(entry.current ? label : entry.status.replaceAll("_", " "))}</td></tr>`).join("")}</tbody></table>
<p style="margin:14px 0">${paymentButton}</p>${banks.length ? status === "sent" && !["loan", "emi"].includes(invoice.payment_type ?? "") ? "" : `<p style="font-size:10px;color:#637187">${escapeHtml(paymentNote)}</p>` : heading("PAYMENT DETAILS") + `<p style="font-size:10px;color:#637187">${escapeHtml(paymentNote)}</p>`}
</td><td width="48%" style="vertical-align:top"><table class="invoice-document-totals" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tbody>
${row("Subtotal", money(invoice.subtotal))}${row("Discount", money(-Number(invoice.discount_amount)))}${row("Taxable value", money(Number(invoice.subtotal) - Number(invoice.discount_amount)))}${taxes.map(tax => row(tax.label, money(tax.amount))).join("")}${row(status === "paid" ? "Amount paid" : "Current payment due", money(invoice.total), true)}
${invoice.payment_type === "installments" && invoice.course_total != null ? row("Full course total", money(summary?.courseTotal ?? invoice.course_total)) : ""}
${summary ? row("Verified payments received", money(summary.paidToDate)) + row("Balance still unpaid", money(summary.outstanding)) + (status !== "paid" && !["cancelled", "rejected"].includes(status) ? row("Balance after this installment is paid", money(summary.balanceAfterPayment)) : "") : options.remainingBalance != null ? row("Remaining course balance", money(options.remainingBalance)) : ""}
</tbody></table></td></tr></tbody></table>
${banks.length ? `<div class="invoice-bank-details" style="margin-top:18px">${heading("BANK DETAILS")}<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed;font-size:12px;line-height:1.5;border:1px solid #cbd5e1;border-top:2px solid ${brand.accent_color}"><colgroup><col style="width:${banks.length === 1 ? "22%" : "18%"}">${banks.map(() => "<col>").join("")}</colgroup><tbody>${([["Bank", "bank_name"], ["Account name", "account_name"], ["A/c No.", "account_number"], ["IFSC", "ifsc"], ["SWIFT / BIC", "swift"], ["Branch", "branch"]] as const).filter(([, key]) => banks.some(bank => bank[key])).map(([name, key]) => `<tr><th scope="row" align="left" style="padding:10px 12px;border:1px solid #cbd5e1;background:#f4f6f9;vertical-align:top;color:#637187;font-weight:400">${name}</th>${banks.map(bank => `<td style="padding:10px 12px;border:1px solid #cbd5e1;background:#fff;vertical-align:top;overflow-wrap:anywhere;font-weight:${key === "bank_name" ? 700 : 400}">${escapeHtml(bank[key] || "-")}</td>`).join("")}</tr>`).join("")}</tbody></table><p style="margin:8px 0 0;font-size:11px;line-height:1.5;color:#637187">For bank transfers, quote ${escapeHtml(invoice.invoice_no)}; receipt verification is required. Online payments update automatically after provider confirmation.</p></div>` : ""}
<div class="invoice-terms" style="margin-top:18px">${heading("TERMS &amp; CONDITIONS")}<ol style="padding-left:17px;margin:0;color:#637187;font-size:12px;line-height:1.5">${terms.map(term => `<li>${escapeHtml(term)}</li>`).join("")}</ol></div>
${!dmhca && invoice.discount_reason ? `<p>Discount reason: ${escapeHtml(invoice.discount_reason)}</p>` : ""}${invoice.notes ? `<p style="white-space:pre-line">${escapeHtml(invoice.notes)}</p>` : ""}
${dmhca ? "" : `<p style="margin:12px 0 0;text-align:center;font-size:10px"><strong>Thank you for choosing ${brand.code}.</strong> This is a computer-generated invoice and does not require a signature.</p>`}
</td></tr><tr><td class="invoice-document-footer" style="padding:16px 28px 8px;background:${brand.accent_color};color:#fff"><strong style="display:block;font-size:20px;line-height:1.35">${escapeHtml(footerName)}</strong>${brand.address ? `<div style="margin-top:6px;white-space:pre-line;font-size:12px">${escapeHtml(brand.address)}</div>` : ""}${brand.tax_id ? `<div style="font-size:11px">Tax ID: ${escapeHtml(brand.tax_id)}</div>` : ""}${[brand.invoice_profile?.phone, brand.invoice_profile?.billing_email, brand.invoice_profile?.website].some(Boolean) ? `<div style="margin-top:6px;font-size:12px">${[brand.invoice_profile?.phone, brand.invoice_profile?.billing_email, brand.invoice_profile?.website].filter(Boolean).map(value => escapeHtml(value!)).join(" | ")}</div>` : ""}</td></tr></tbody></table>`;
}
