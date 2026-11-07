import type { SupabaseClient } from "@supabase/supabase-js";
import { databaseError } from "@/lib/server/operational";
import { deliverInvoice } from "@/lib/server/invoice-delivery";

export async function deliverScheduledInvoices(admin: SupabaseClient, invoiceIds?: string[]) {
  const { data, error } = invoiceIds
    ? await admin.rpc("operational_release_due_invoices", { p_ids: invoiceIds })
    : await admin.rpc("operational_release_due_invoices");
  databaseError(error);
  const results: { id: string; sent: boolean; error?: string }[] = [];
  for (const invoice of data ?? []) {
    try {
      const { data: lead, error: leadError } = await admin.from("leads").select("id,name,email").eq("id", invoice.lead_id).maybeSingle();
      databaseError(leadError);
      if (!lead) throw new Error("The scheduled invoice lead is unavailable.");
      await deliverInvoice(admin, invoice, lead, invoice.creator_email);
      const { error: savedError } = await admin.from("invoices").update({ delivery_error: null }).eq("id", invoice.id);
      databaseError(savedError);
      results.push({ id: invoice.id, sent: true });
    } catch (deliveryError) {
      const message = deliveryError instanceof Error ? deliveryError.message : "Scheduled invoice delivery failed.";
      console.error("Scheduled invoice delivery failed", { invoiceId: invoice.id });
      const { error: savedError } = await admin.from("invoices").update({ delivery_error: message.slice(0, 2000) }).eq("id", invoice.id);
      databaseError(savedError);
      results.push({ id: invoice.id, sent: false, error: message });
    }
  }
  return results;
}

export function invoiceDeliveryMessage(results: Awaited<ReturnType<typeof deliverScheduledInvoices>>) {
  const sent = results.filter(result => result.sent).length;
  const failures = results.filter(result => !result.sent);
  return `${sent} invoice email(s) accepted by SMTP for the lead, with the lead owner and creator copied.`
    + (failures.length ? ` ${failures.length} delivery attempt(s) failed: ${failures.map(result => result.error).join("; ")}` : "")
    + " Future-dated invoices remain scheduled; pending discounts require approval. Already sent or payment-locked invoices are not resent.";
}
