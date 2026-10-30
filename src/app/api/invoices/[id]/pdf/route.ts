import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { databaseError, parseInput, uuid } from "@/lib/server/operational";
import { buildInvoicePdf } from "@/lib/server/invoice-pdf";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireUser("invoices.view");
    const id = parseInput(uuid, (await context.params).id);
    const { data: invoice, error } = await supabase.from("invoices").select("*,invoice_items(*)").eq("id", id).maybeSingle();
    databaseError(error);
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    const { data: lead, error: leadError } = await supabase.from("leads").select("name,email").eq("id", invoice.lead_id).maybeSingle();
    databaseError(leadError);
    const pdf = await buildInvoicePdf(invoice, lead);
    return new Response(pdf, { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${invoice.invoice_no}.pdf"`, "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}
