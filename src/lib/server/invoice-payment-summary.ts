import type { SupabaseClient } from "@supabase/supabase-js";
import { installmentPaymentSummary } from "@/lib/invoice-payment-summary";
import { databaseError } from "@/lib/server/operational";
import { invoiceWindowExpired } from "@/lib/invoice-policy";

export async function loadInvoicePaymentSummary(client: SupabaseClient, invoice: {
  id: string; payment_type?: string; parent_invoice_id?: string | null; course_total?: number | string | null;
  total: number | string; status: string;
}) {
  if (invoice.payment_type !== "installments") return undefined;
  const rootId = invoice.parent_invoice_id ?? invoice.id;
  const { data: root, error: rootError } = await client.from("invoices").select("course_total").eq("id", rootId).maybeSingle();
  databaseError(rootError);
  if (root?.course_total == null) throw new Error("The installment enrollment total could not be loaded.");
  const query = () => client.from("invoices")
    .select("id,total,status,installment_number,due_date,created_at,payment_expires_at,tax_review_required")
    .or(`id.eq.${rootId},parent_invoice_id.eq.${rootId}`).order("id");
  const { data, error } = await query().range(0, 199);
  databaseError(error);
  const family = data ?? [];
  let batchSize = family.length;
  while (batchSize === 200) {
    const { data: batch, error: batchError } = await query().range(family.length, family.length + 199);
    databaseError(batchError);
    batchSize = batch?.length ?? 0;
    family.push(...(batch ?? []));
  }
  if (!family.some(row => row.id === invoice.id)) throw new Error("The installment payment history could not be loaded.");
  return installmentPaymentSummary(root.course_total, invoice, family.map(row => ({
    ...row, status: row.status === "paid" ? "paid" : row.tax_review_required ? "pending_review"
      : ["sent", "pending_approval"].includes(row.status) && invoiceWindowExpired(row) ? "expired" : row.status,
  })));
}
