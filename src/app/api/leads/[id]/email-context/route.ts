import { NextResponse } from "next/server";
import { fetchLead } from "@/lib/crm-data";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { dbError, uuid } from "@/lib/live-leads";
import { sanitizeSignature } from "@/lib/server/email-signature";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, user } = await requireUser("leads.edit");
    const lead = await fetchLead(supabase, uuid((await context.params).id));
    if (!lead || lead.isArchived) throw new HttpError(404, "Lead not found.");
    const [{ data: profile, error }, invoiceResult] = await Promise.all([
      supabase.from("profiles").select("full_name,phone,email_signature_html").eq("id", user.id).single(),
      user.permissions.includes("invoices.view")
        ? supabase.from("invoices").select("id,invoice_no,total,currency,due_date,status,invoice_items(description)").eq("lead_id", lead.id).eq("status", "sent").order("created_at", { ascending: false }).limit(200)
        : Promise.resolve({ data: [], error: null }),
    ]);
    dbError(error); dbError(invoiceResult.error);
    if (!profile) throw new HttpError(404, "Your email signature profile could not be found.");
    return NextResponse.json({
      sender: { name: profile.full_name, phone: profile.phone ?? "", signatureHtml: sanitizeSignature(profile.email_signature_html) },
      invoices: (invoiceResult.data ?? []).map(row => ({
        id: row.id, invoiceNo: row.invoice_no, course: row.invoice_items?.[0]?.description ?? lead.course,
        amount: Number(row.total), currency: row.currency, dueDate: row.due_date, status: row.status,
      })),
      canViewInvoices: user.permissions.includes("invoices.view"),
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}
