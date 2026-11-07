import { NextResponse } from "next/server";
import { jsonError, readJson, requireUser } from "@/lib/server/auth";
import { accessibleLead, databaseError, integrationRequirements, leadOptions, parseInput, uuid } from "@/lib/server/operational";
import { integrationStatus } from "@/lib/server/integration-settings";
import { invoiceInput } from "@/lib/server/operational-validation";
import { checkOrigin } from "@/lib/server/login";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { deliverInvoice } from "@/lib/server/invoice-delivery";
import { HttpError } from "@/lib/server/auth";
import { invoiceWindowExpired } from "@/lib/invoice-policy";
import { deliverScheduledInvoices, invoiceDeliveryMessage } from "@/lib/server/invoice-scheduler";
import { invoicePaymentUrl } from "@/lib/server/invoice-payment-url";

export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const { supabase, user } = await requireUser("invoices.view");
    const leadId = new URL(request.url).searchParams.get("leadId");
    const lead = leadId !== null ? await accessibleLead(supabase, parseInput(uuid, leadId)) : null;
    let query = supabase.from("invoices").select("*,invoice_items(*),invoice_approvals(*),lead:leads(assignee_id)");
    if (lead) query = query.eq("lead_id", lead.id);
    const [{ data, error }, { data: profiles, error: profilesError }, leads, razorpay, smtp, stripe] = await Promise.all([
      query.order("created_at", { ascending: false }).order("id").limit(200),
      supabase.from("profiles").select("id,full_name"),
      lead ? Promise.resolve([{ id: lead.id, name: lead.name }]) : leadOptions(supabase),
      integrationStatus("razorpay", integrationRequirements.razorpay),
      integrationStatus("smtp", integrationRequirements.smtp),
      integrationStatus("stripe", integrationRequirements.stripe),
    ]);
    databaseError(error); databaseError(profilesError);
    const invoiceRows = data ?? [];
    let batchSize = invoiceRows.length;
    while (batchSize === 200) {
      let next = supabase.from("invoices").select("*,invoice_items(*),invoice_approvals(*),lead:leads(assignee_id)");
      if (lead) next = next.eq("lead_id", lead.id);
      const { data: batch, error: batchError } = await next.order("created_at", { ascending: false }).order("id")
        .range(invoiceRows.length, invoiceRows.length + 199);
      databaseError(batchError);
      batchSize = batch?.length ?? 0;
      invoiceRows.push(...(batch ?? []));
    }
    const leadIds = [...new Set(invoiceRows.map((invoice: { lead_id: string }) => invoice.lead_id))];
    const courseBalances: Record<string, number> = {};
    const installmentParents = [];
    if (leadIds.length) {
      const visibleRows = invoiceRows;
      const families = new Map<string, typeof visibleRows>();
      for (const row of visibleRows) {
        if (row.payment_type !== "installments") continue;
        const rootId = row.parent_invoice_id ?? row.id;
        families.set(rootId, [...(families.get(rootId) ?? []), row]);
      }
      for (const [rootId, rows] of families) {
        const root = rows.find(row => row.id === rootId);
        const total = Number(root?.course_total ?? root?.total ?? 0);
        const paid = rows.filter(row => row.status === "paid").reduce((sum, row) => sum + Number(row.total), 0);
        const reserved = rows.filter(row => !["cancelled", "rejected"].includes(row.status)).reduce((sum, row) => sum + Number(row.total), 0);
        for (const row of rows) courseBalances[row.id] = Math.max(0, Math.round((total - paid + Number.EPSILON) * 100) / 100);
        if (root && root.status !== "rejected" && !(root.status === "cancelled" && (Number(root.discount_percent) > 0 || root.pricing_review_note) && !root.approved_at)) {
          installmentParents.push({
            id: root.id, invoice_no: root.invoice_no, course_total: total, currency: root.currency,
            balance: Math.max(0, Math.round((total - paid + Number.EPSILON) * 100) / 100),
            available_balance: Math.max(0, Math.round((total - reserved + Number.EPSILON) * 100) / 100),
            already_paid: paid,
            lead_id: root.lead_id, course_id: root.course_id, company_code: root.company_code,
            enrollment_subtotal: Number(root.enrollment_subtotal ?? total),
            enrollment_discount: Number(root.enrollment_discount ?? 0),
            enrollment_tax: Number(root.enrollment_tax ?? 0),
            tax_percent: Number(root.enrollment_tax_percent ?? 0),
            discount_percent: root.enrollment_subtotal == null ? 0 : Number(root.discount_percent),
            next_installment: Math.max(rows.length, ...rows.map(row => Number(row.installment_number) || 0)) + 1,
            pending: rows.some(row => row.status === "sent" || row.status === "pending_approval"),
            approval_pending: root.status === "pending_approval",
            tax_review_required: root.tax_review_required,
            course_name: root.invoice_items?.[0]?.description ?? "Historical course",
            installments: [...rows].sort((a, b) => Number(a.installment_number ?? 0) - Number(b.installment_number ?? 0) || a.created_at?.localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id))
              .map((row, index) => ({
                id: row.id, invoice_no: row.invoice_no, number: row.installment_number ?? index + 1,
                amount: Number(row.total), invoice_date: row.invoice_date ?? row.created_at?.slice(0, 10),
                due_date: row.due_date, status: ["sent", "pending_approval"].includes(row.status) && invoiceWindowExpired(row) ? "expired" : row.status,
              })),
          });
        }
      }
    }
    return NextResponse.json({ invoices: invoiceRows.map(invoice => ({
      ...invoice,
      payment_url: invoicePaymentUrl(invoice),
      can_reconcile_payment: user.permissions.includes("invoices.create") && (invoice.created_by === user.id
        || invoice.lead?.assignee_id === user.id || ["admin", "super_admin"].includes(user.profile.role)),
      status: ["sent", "pending_approval"].includes(invoice.status) && invoiceWindowExpired(invoice) ? "expired" : invoice.status,
    })), courseBalances, installmentParents, leads, profiles: profiles ?? [], userId: user.id,
      canCreate: user.permissions.includes("invoices.create"), canApprove: ["admin", "super_admin"].includes(user.profile.role) && user.permissions.includes("invoices.approve"),
      razorpay, smtp, stripe }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("invoices.create");
    const input = parseInput(invoiceInput, await readJson(request));
    await accessibleLead(supabase, input.lead_id);
    if (input.payment_type === "installments") {
      const { data: ids, error: planError } = await supabase.rpc("operational_create_installment_plan", { p_input: input });
      if (planError?.code === "P0001") throw new HttpError(400, planError.message);
      databaseError(planError);
      if (!Array.isArray(ids) || !ids.length) throw new HttpError(500, "The installment plan did not return invoice IDs.");
      try {
        const deliveries = await deliverScheduledInvoices(getSupabaseAdminClient(), ids);
        const message = `${ids.length} installment invoice(s) saved. ${invoiceDeliveryMessage(deliveries)}`;
        return NextResponse.json({ ids, deliveries, message, warning: deliveries.some(row => !row.sent) ? message : undefined }, { status: 201 });
      } catch (deliveryError) {
        const message = `Installments saved, but automatic delivery failed: ${deliveryError instanceof Error ? deliveryError.message : "Delivery failed."}`;
        return NextResponse.json({ ids, message, warning: message }, { status: 201 });
      }
    }
    const { data, error } = await supabase.rpc("operational_create_invoice", { p_input: input });
    if (error?.code === "P0001") throw new HttpError(400, error.message);
    databaseError(error);
    const admin = getSupabaseAdminClient();
    const { data: invoice, error: invoiceError } = await admin.from("invoices").select("*,invoice_items(*)").eq("id", data).maybeSingle();
    databaseError(invoiceError);
    if (!invoice) throw new HttpError(500, "Invoice was created but could not be loaded for delivery.");
    let delivery: { sent: boolean; messageId?: string; error?: string } = { sent: false };
    if (invoice.status === "sent") {
      const { data: lead, error: leadError } = await admin.from("leads").select("id,name,email").eq("id", invoice.lead_id).maybeSingle();
      databaseError(leadError);
      if (lead) {
        try {
          const result = await deliverInvoice(admin, invoice, lead, user.email);
          delivery = { sent: true, messageId: result.messageId };
        } catch (deliveryError) {
          delivery = { sent: false, error: deliveryError instanceof Error ? deliveryError.message : "Invoice delivery failed." };
        }
      } else delivery = { sent: false, error: "The invoice lead is unavailable." };
    }
    const message = invoice.status === "pending_approval"
      ? "Discount request submitted for admin approval."
      : delivery.sent
        ? "Invoice saved in CRM; email accepted by SMTP for the lead, with the current lead owner and creator copied."
        : `Invoice issued, but automatic delivery failed: ${delivery.error ?? "check configuration and reconcile."}`;
    return NextResponse.json({ id: data, status: invoice.status, delivery, message, warning: delivery.error ? message : undefined }, { status: 201 });
  } catch (error) { return jsonError(error); }
}
