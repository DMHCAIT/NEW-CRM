import { legacyCompany } from "@/lib/billing";
import { invoiceBranding } from "@/lib/invoice-branding";
import { invoiceWindowExpired } from "@/lib/invoice-policy";
import type { InvoiceDocumentRecord } from "@/lib/invoice-document";

export function invoicePresentation(invoice: InvoiceDocumentRecord) {
  const company = invoiceBranding(invoice.company_snapshot ?? {
    ...legacyCompany, code: invoice.company_code === "IBMP" ? "IBMP" : "DMHCA",
    legal_name: invoice.company_code ?? legacyCompany.legal_name,
  });
  const status = invoice.tax_review_required && invoice.status !== "paid" ? "pending_review"
    : ["sent", "pending_approval"].includes(invoice.status) && invoiceWindowExpired(invoice) ? "expired" : invoice.status;
  const label = ({ sent: "Awaiting payment", paid: "Paid", scheduled: "Scheduled", expired: "Expired", cancelled: "Cancelled",
    rejected: "Rejected", pending_approval: "Pending approval", pending_review: "Pending finance review" } as Record<string, string>)[status] ?? status.replaceAll("_", " ");
  const profile = company.invoice_profile;
  const terms = company.code === "DMHCA" ? [
    "Fees once paid are subject to the DMHCA Refund Policy (dmhca.in/refund-returns-policy).",
    "This invoice is issued against enrolment in the program named above.",
    "Billing queries: info@dmhca.in, quoting the invoice number.",
  ] : [
    `Fees once paid are subject to the ${company.code} refund policy${profile?.refund_policy_url ? ` (${profile.refund_policy_url})` : "."}`,
    "This invoice is issued against enrollment in the course named above.",
    `For billing queries${profile?.billing_email ? `, contact ${profile.billing_email}` : ", contact your admissions team"}, quoting the invoice number.`,
  ];
  const subtotalCents = Math.round(Number(invoice.subtotal) * 100);
  const discountCents = Math.round(Number(invoice.discount_amount) * 100);
  const taxCents = Math.round(Number(invoice.tax_amount) * 100);
  const cgstCents = Math.round(taxCents / 2);
  const taxes = invoice.currency === "INR"
    ? [{ label: "CGST (9%)", amount: cgstCents / 100 }, { label: "SGST (9%)", amount: (taxCents - cgstCents) / 100 }]
    : [{ label: "Tax", amount: taxCents / 100 }];
  let allocatedBase = 0, allocatedDiscount = 0, allocatedTax = 0;
  const items = (invoice.invoice_items ?? []).map((item, index, rows) => {
    allocatedBase += Math.round(Number(item.amount) * 100);
    const discount = (index === rows.length - 1 ? discountCents : subtotalCents > 0 ? Math.round(discountCents * allocatedBase / subtotalCents) : 0) - allocatedDiscount;
    const tax = (index === rows.length - 1 ? taxCents : subtotalCents > 0 ? Math.round(taxCents * allocatedBase / subtotalCents) : 0) - allocatedTax;
    allocatedDiscount += discount; allocatedTax += tax;
    const cgst = Math.round(allocatedTax / 2) - Math.round((allocatedTax - tax) / 2);
    return { ...item, discount: discount / 100, tax: tax / 100, taxes: invoice.currency === "INR" ? [cgst / 100, (tax - cgst) / 100] : [tax / 100],
      total: (Math.round(Number(item.amount) * 100) - discount + tax) / 100 };
  });
  const footerName = company.code === "DMHCA" ? "NEWDELHI MEDICAL HEALTH CARE PVT. LTD." : company.legal_name;
  const gstNumber = company.code === "DMHCA" ? "07AAICN9985A1Z3" : null;
  return { company, footerName, gstNumber, status, label, terms, items, taxes, canPay: status === "sent" && ["one_shot", "installments"].includes(invoice.payment_type ?? "") };
}
