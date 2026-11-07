import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, PDFString, StandardFonts, rgb } from "pdf-lib";
import { legacyCompany } from "@/lib/billing";
import { invoiceWindowExpired } from "@/lib/invoice-policy";
import { invoiceBranding } from "@/lib/invoice-branding";
import type { InvoiceDocumentRecord } from "@/lib/invoice-document";

export type InvoicePdfRecord = InvoiceDocumentRecord;

export async function buildInvoicePdf(invoice: InvoicePdfRecord, lead: { name?: string | null; email?: string | null } | null, paymentUrl?: string | null) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const company = invoiceBranding(invoice.company_snapshot ?? { ...legacyCompany, code: invoice.company_code === "IBMP" ? "IBMP" : "DMHCA", legal_name: invoice.company_code ?? legacyCompany.legal_name });
  const logo = await pdf.embedPng(await readFile(join(process.cwd(), "public", company.code === "IBMP" ? "IBMP-logo.png" : "DMHCA-invoice-logo.png")));
  pdf.setTitle(`Invoice ${invoice.invoice_no}`);
  pdf.setAuthor(company.legal_name);
  const color = (value: string) => {
    const hex = value.slice(1);
    return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
  };
  const primary = color(company.primary_color), accent = color(company.accent_color);
  const ink = color("#243247"), muted = color("#64748b"), pale = color("#edf1f5"), white = rgb(1, 1, 1);
  const width = 595.28, height = 841.89, margin = 32, bodyWidth = width - margin * 2;
  const clean = (value: string) => value.replace(/[^\x20-\x7e\n]/g, "?");
  const text = (value: string, x: number, y: number, size = 9, strong = false, fill = ink) =>
    page.drawText(clean(value), { x, y, size, font: strong ? bold : font, color: fill });
  const wrap = (value: string, maxWidth: number, size = 9, strong = false) => {
    const lines: string[] = [];
    for (const paragraph of clean(value).split(/\r?\n/)) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        for (const character of (line ? " " : "") + word) {
          if ((strong ? bold : font).widthOfTextAtSize(line + character, size) > maxWidth) {
            lines.push(line.trimEnd()); line = "";
          }
          line += character;
        }
      }
      lines.push(line.trim());
    }
    return lines;
  };
  const money = (value: number | string) => `${invoice.currency} ${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const date = (value: string | null) => value ? new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "-";
  let page = pdf.addPage([width, height]), y = 0;
  const decorate = () => {
    page.drawRectangle({ x: 0, y: 0, width, height, color: white });
    page.drawRectangle({ x: 0, y: height - 108, width, height: 108, color: primary });
    page.drawSvgPath(`M 0 0 L 235 0 L 170 108 L 0 108 Z`, { x: width - 235, y: height, color: accent });
    page.drawRectangle({ x: margin, y: height - 93, width: 76, height: 78, color: white });
    const scaled = logo.scale(Math.min(66 / logo.width, 68 / logo.height));
    page.drawImage(logo, { x: margin + (76 - scaled.width) / 2, y: height - 93 + (78 - scaled.height) / 2, ...scaled });
    const nameSize = wrap(company.legal_name, 228, 22, true).length > 3 ? 13 : 22;
    const nameLines = wrap(company.legal_name, 228, nameSize, true).slice(0, 4);
    const nameTop = height - 61 + (nameLines.length - 1) * nameSize * 0.6;
    nameLines.forEach((line, i) => text(line, 121, nameTop - i * nameSize * 1.2, nameSize, true, white));
    text("INVOICE", width - 148, height - 65, 24, true, white);
    page.drawRectangle({ x: 0, y: 0, width, height: 78, color: accent });
    text(company.legal_name, margin, 56, Math.min(11, (bodyWidth - 60) / bold.widthOfTextAtSize(company.legal_name, 1)), true, white);
    wrap([company.address, company.tax_id ? `Tax ID: ${company.tax_id}` : ""].filter(Boolean).join(" | "), bodyWidth - 60, 8)
      .slice(0, 3).forEach((line, i) => text(line, margin, 40 - i * 11, 8, false, white));
    y = height - 136;
  };
  const ensure = (space: number) => {
    if (y - space < 100) { page = pdf.addPage([width, height]); decorate(); }
  };
  const paragraph = (value: string, size = 9) => {
    for (const line of wrap(value, bodyWidth, size)) {
      ensure(14); text(line, margin, y, size); y -= 14;
    }
  };
  const section = (label: string) => {
    ensure(38); text(label, margin, y, 9, true, primary); y -= 18;
  };
  decorate();
  const billTo = [invoice.billing_name || lead?.name || invoice.lead_id, invoice.billing_address || "", invoice.billing_email || lead?.email || ""]
    .filter(Boolean).flatMap(value => wrap(value, 248));
  const status = invoice.tax_review_required && invoice.status !== "paid" ? "Pending finance review"
    : ["sent", "pending_approval"].includes(invoice.status) && invoiceWindowExpired(invoice) ? "Expired"
    : ({ sent: "Awaiting payment", paid: "Paid", scheduled: "Scheduled", pending_approval: "Pending approval",
      cancelled: "Cancelled", rejected: "Rejected", expired: "Expired" } as Record<string, string>)[invoice.status] ?? invoice.status;
  const details = [
    `Invoice No: ${invoice.invoice_no}`, `Invoice Date: ${date(invoice.invoice_date ?? invoice.created_at)}`,
    `Due Date: ${date(invoice.due_date)}`, `Status: ${status.replaceAll("_", " ")}`,
    ...(invoice.status === "paid" && invoice.paid_at ? [`Paid on: ${date(invoice.paid_at)}`] : []),
    ...(company.tax_id ? [`Tax ID: ${company.tax_id}`] : []),
  ].flatMap(value => wrap(value, 248));
  text("BILL TO", margin, y, 9, true, primary);
  text("INVOICE DETAILS", 310, y, 9, true, primary); y -= 19;
  for (let i = 0; i < Math.max(billTo.length, details.length); i++) {
    ensure(14);
    if (billTo[i]) text(billTo[i], margin, y, 9, i === 0);
    if (details[i]) text(details[i], 310, y);
    y -= 14;
  }
  y -= 18;
  const columns = [margin + 8, margin + 33, margin + 277, margin + 320, margin + 424];
  const tableHeader = () => {
    ensure(46);
    page.drawRectangle({ x: margin, y: y - 6, width: bodyWidth, height: 22, color: accent });
    ["No.", "Course / Description", "Qty", "Price", "Amount"].forEach((label, i) => text(label, columns[i], y + 2, 8, true, white));
    y -= 24;
  };
  tableHeader();
  for (const [index, item] of (invoice.invoice_items ?? []).entries()) {
    const lines = wrap(item.description, 235);
    for (let offset = 0; offset < lines.length; offset += 28) {
      const chunk = lines.slice(offset, offset + 28);
      const rowHeight = Math.max(28, chunk.length * 13 + 13);
      if (y - rowHeight < 100) { page = pdf.addPage([width, height]); decorate(); tableHeader(); }
      page.drawRectangle({ x: margin, y: y - rowHeight + 10, width: bodyWidth, height: rowHeight, color: index % 2 ? white : pale });
      chunk.forEach((line, i) => text(line, columns[1], y - i * 13));
      if (offset === 0) {
        text(String(index + 1), columns[0], y, 8);
        text(String(item.quantity), columns[2], y, 8);
        text(Number(item.unit_price).toFixed(2), columns[3], y, 8);
        text(Number(item.amount).toFixed(2), columns[4], y, 8);
      }
      y -= rowHeight;
    }
  }
  y -= 20;
  ensure(205);
  const blockTop = y;
  text("PAYMENT SCHEDULE", margin, y, 9, true, primary);
  y -= 25;
  text(invoice.payment_type === "installments" ? `Installment ${invoice.installment_number ?? 1}`
    : ["loan", "emi"].includes(invoice.payment_type ?? "") ? `${invoice.payment_type?.toUpperCase()} financing` : "Full payment", margin, y, 10, true);
  y -= 24;
  page.drawRectangle({ x: margin, y: y - 6, width: 267, height: 22, color: primary });
  text("Due date", margin + 8, y + 2, 8, true, white);
  text("Amount", margin + 206, y + 2, 8, true, white);
  y -= 24;
  text(date(invoice.due_date), margin + 8, y);
  const scheduledAmount = money(invoice.total);
  text(scheduledAmount, margin + 259 - font.widthOfTextAtSize(scheduledAmount, 9), y);
  if (invoice.payment_type === "installments" && invoice.course_total != null) {
    y -= 19; text(`Full course value: ${money(invoice.course_total)}`, margin, y, 8);
  }
  const canPay = invoice.status === "sent" && !invoice.tax_review_required && !invoiceWindowExpired(invoice)
    && ["one_shot", "installments"].includes(invoice.payment_type ?? "");
  if (paymentUrl && !/^https:\/\/[^\s]+$/i.test(paymentUrl)) throw new Error("Invoice payment URL must be a secure HTTPS URL.");
  if (canPay && paymentUrl) {
    y -= 38;
    page.drawRectangle({ x: margin, y: y - 9, width: 130, height: 30, color: accent });
    text("Pay Now", margin + 38, y + 1, 12, true, white);
    const link = pdf.context.obj({
      Type: "Annot", Subtype: "Link", Rect: [margin, y - 9, margin + 130, y + 21], Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(paymentUrl) },
    });
    page.node.addAnnot(pdf.context.register(link));
  }
  const totals = [["Subtotal", invoice.subtotal], ["Discount", -Number(invoice.discount_amount)],
    ["Taxable value", Number(invoice.subtotal) - Number(invoice.discount_amount)],
    [invoice.currency === "INR" ? "GST" : "Tax", invoice.tax_amount],
    [invoice.status === "paid" ? "Amount paid" : "Current payment due", invoice.total]] as const;
  totals.forEach(([label, amount], index) => {
    const rowY = blockTop - index * 27;
    const last = index === totals.length - 1;
    page.drawRectangle({ x: 332, y: rowY - 9, width: width - margin - 332, height: 26, color: last ? accent : white });
    text(label, 340, rowY, 8, last, last ? white : ink);
    const formatted = money(amount);
    text(formatted, width - margin - 8 - font.widthOfTextAtSize(formatted, 9), rowY, 9, false, last ? white : ink);
  });
  y = Math.min(y - 30, blockTop - 162);
  section("PAYMENT DETAILS");
  if (invoice.status === "paid") paragraph("Payment has been verified. No further payment is required for this invoice.");
  else if (invoice.tax_review_required) paragraph("Finance review is required before payment is available.");
  else if (["loan", "emi"].includes(invoice.payment_type ?? "")) paragraph("Financing is handled by the company finance team. Contact your lead owner for confirmation.");
  else if (canPay && paymentUrl) paragraph(`Pay securely with ${invoice.currency === "USD" ? "Stripe" : "Razorpay"} using the Pay Now button above.`);
  else paragraph(status === "Expired" || invoice.status === "expired" ? "Payment window expired. Contact your lead owner for a new invoice." : "Payment is unavailable until approval and a secure payment link have been issued.");
  if (invoice.payment_expires_at && invoice.status !== "paid") paragraph(`Payment deadline: ${new Date(invoice.payment_expires_at).toUTCString()}`, 8);
  if (invoice.currency === "USD" && canPay) paragraph("A Stripe session opened near the deadline may remain available for up to 30 additional minutes.", 8);
  if (invoice.discount_reason) { y -= 10; paragraph(`Discount reason: ${invoice.discount_reason}`, 8); }
  if (invoice.notes) { y -= 14; paragraph(invoice.notes); }
  for (const [index, invoicePage] of pdf.getPages().entries()) {
    invoicePage.drawText(`${index + 1} / ${pdf.getPageCount()}`, { x: width - 55, y: 16, size: 8, font, color: white });
  }
  return Buffer.from(await pdf.save());
}
