import { PDFDocument, StandardFonts } from "pdf-lib";

export type InvoicePdfRecord = {
  invoice_no: string;
  status: string;
  lead_id: string;
  created_at: string;
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
};

export async function buildInvoicePdf(invoice: InvoicePdfRecord, lead: { name?: string | null; email?: string | null } | null) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage();
  let y = 780;
  const line = (value: string) => {
    const text = value.replace(/[^\x20-\x7e]/g, "?");
    for (let offset = 0; offset < text.length || offset === 0; offset += 90) {
      if (y < 45) { page = pdf.addPage(); y = 780; }
      page.drawText(text.slice(offset, offset + 90), { x: 45, y, size: 11, font });
      y -= 20;
    }
  };
  line(`Invoice ${invoice.invoice_no}`);
  line(`Status: ${invoice.status === "sent" ? "Awaiting payment" : invoice.status}`);
  line(`Bill to: ${lead?.name ?? invoice.lead_id}`);
  line(`Email: ${lead?.email ?? "-"}`);
  line(`Created: ${invoice.created_at.slice(0, 10)}   Due: ${invoice.due_date ?? "-"}`);
  line("");
  for (const item of invoice.invoice_items ?? [])
    line(`${item.description} | ${item.quantity} x ${Number(item.unit_price).toFixed(2)} = ${Number(item.amount).toFixed(2)}`);
  line(`Subtotal: ${Number(invoice.subtotal).toFixed(2)} ${invoice.currency}`);
  line(`Discount: ${Number(invoice.discount_amount).toFixed(2)} | ${invoice.discount_reason ?? ""}`);
  line(`Tax: ${Number(invoice.tax_amount).toFixed(2)}`);
  line(`TOTAL: ${Number(invoice.total).toFixed(2)} ${invoice.currency}`);
  if (invoice.payment_type) line(`Payment type: ${invoice.payment_type}`);
  if (invoice.payment_type === "installments" && invoice.course_total != null)
    line(`Course total: ${Number(invoice.course_total).toFixed(2)} ${invoice.currency}`);
  line(`Notes: ${invoice.notes ?? "-"}`);
  return Buffer.from(await pdf.save());
}
