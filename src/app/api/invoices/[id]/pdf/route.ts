import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { databaseError, parseInput, uuid } from "@/lib/server/operational";
import { buildInvoicePdf } from "@/lib/server/invoice-pdf";
import { decryptIntegrationValues } from "@/lib/server/integration-settings";
import { appUrl } from "@/lib/server/env";
import { invoiceWindowExpired } from "@/lib/invoice-policy";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireUser("invoices.view");
    const id = parseInput(uuid, (await context.params).id);
    const { data: invoice, error } = await supabase.from("invoices").select("*,invoice_items(*)").eq("id", id).maybeSingle();
    databaseError(error);
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    const { data: lead, error: leadError } = await supabase.from("leads").select("name,email").eq("id", invoice.lead_id).maybeSingle();
    databaseError(leadError);
    let paymentUrl: string | null = null;
    if (invoice.status === "sent" && !invoice.tax_review_required && !invoiceWindowExpired(invoice)
      && ["one_shot", "installments"].includes(invoice.payment_type) && invoice.status_token_encrypted) {
      const { token } = decryptIntegrationValues(invoice.status_token_encrypted);
      if (!token) throw new HttpError(503, "Invoice payment token is invalid. Reconcile this invoice before downloading.");
      paymentUrl = `${appUrl()}/invoice-status/${encodeURIComponent(token)}`;
    }
    const pdf = await buildInvoicePdf(invoice, lead, paymentUrl);
    return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${invoice.invoice_no}.pdf"`, "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}
