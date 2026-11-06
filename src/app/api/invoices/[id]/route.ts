import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { databaseError, parseInput, uuid } from "@/lib/server/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { checkOrigin } from "@/lib/server/login";
import { deliverInvoice, sendPaymentReceipt } from "@/lib/server/invoice-delivery";
import { verifyInvoicePaymentUrl, verifySavedInvoicePayment } from "@/lib/server/invoice-payment-verification";
import { cancelInvoicePaymentLinks } from "@/lib/server/invoice-link-cancellation";
import { invoiceWindowExpired } from "@/lib/invoice-policy";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["approve", "reject"]), comment: z.string().trim().max(2000).default("") }),
  z.object({ action: z.literal("email") }),
  z.object({ action: z.literal("verify_payment_url"), url: z.string().trim().url().max(2000) }),
  z.object({ action: z.literal("sync_payment") }),
  z.object({ action: z.literal("review_tax") }),
  z.object({ action: z.literal("close_expired") }),
  z.object({ action: z.literal("external_payment"), reference: z.string().trim().min(1).max(200), evidence: z.string().trim().min(1).max(2000) }),
]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const input = parseInput(actionSchema, await readJson(request));
    const adminAction = ["approve", "reject", "external_payment", "review_tax", "close_expired"].includes(input.action);
    const { supabase, user } = await requireUser(adminAction ? "invoices.approve" : "invoices.create");
    if (adminAction && !["admin", "super_admin"].includes(user.profile.role)) throw new HttpError(403, "Admin or Super Admin approval is required.");
    const id = parseInput(uuid, (await context.params).id);
    const { data: invoice, error } = await supabase.from("invoices").select("*").eq("id", id).maybeSingle();
    databaseError(error);
    if (!invoice) throw new HttpError(404, "Invoice not found or inaccessible.");
    const admin = getSupabaseAdminClient();

    if (input.action === "review_tax" || input.action === "close_expired") {
      if (!["sent", "pending_approval"].includes(invoice.status)) throw new HttpError(409, "Only unpaid invoices can be reviewed or closed.");
      if (input.action === "review_tax" && !invoice.tax_review_required) throw new HttpError(409, "This invoice does not need tax review.");
      if (input.action === "close_expired" && !invoiceWindowExpired(invoice)) throw new HttpError(409, "The invoice payment window has not expired.");
      if (input.action === "close_expired" && invoice.stripe_expires_at && new Date(invoice.stripe_expires_at).getTime() > Date.now())
        throw new HttpError(409, "Wait until the final Stripe checkout grace period ends before closing this invoice.");
      await cancelInvoicePaymentLinks(admin, invoice);
      if (input.action === "review_tax") {
        const { error: reviewError } = await supabase.rpc("operational_review_invoice_tax", { p_id: id });
        if (reviewError?.code === "P0001") throw new HttpError(409, reviewError.message);
        databaseError(reviewError);
        return NextResponse.json({ message: "Tax recalculated. Review the revised totals and approve before delivery; old payment links have been cancelled." });
      }
      const { data: closed, error: closeError } = await admin.from("invoices").update({ status: "cancelled", tax_review_required: false })
        .eq("id", id).in("status", ["sent", "pending_approval"]).select("id").maybeSingle();
      databaseError(closeError);
      if (!closed) throw new HttpError(409, "Invoice changed while closing. Refresh to check payment status.");
      return NextResponse.json({ message: "Expired invoice closed and provider links cancelled. You may now create a replacement installment." });
    }

    if (input.action === "verify_payment_url" || input.action === "sync_payment") {
      if (invoice.created_by !== user.id && !["admin", "super_admin"].includes(user.profile.role))
        throw new HttpError(403, "Only the invoice creator or an administrator can reconcile payment.");
      if (!["sent", "paid"].includes(invoice.status) || !["one_shot", "installments"].includes(invoice.payment_type))
        throw new HttpError(409, "Only issued online-payment invoices can be reconciled.");
      const payment = input.action === "verify_payment_url"
        ? await verifyInvoicePaymentUrl(invoice, input.url) : await verifySavedInvoicePayment(invoice);
      const { data: recorded, error: paymentError } = await admin.rpc("operational_record_verified_url", {
        p_invoice_id: id, p_provider: payment.provider, p_payment_id: payment.paymentId, p_link_id: payment.linkId,
        p_amount_cents: payment.amount, p_currency: payment.currency, p_url: payment.url, p_payload: payment,
      });
      if (paymentError?.code === "23505") throw new HttpError(409, "This payment is already recorded against another invoice.");
      if (paymentError?.code === "P0001") throw new HttpError(409, paymentError.message);
      databaseError(paymentError);
      try {
        await sendPaymentReceipt(admin, id);
        return NextResponse.json({ recorded, message: "Payment verified with the company provider. Invoice is paid; receipt accepted by SMTP." });
      } catch (receiptError) {
        return NextResponse.json({ recorded, message: `Payment verified and invoice is paid, but receipt delivery failed: ${receiptError instanceof Error ? receiptError.message : "delivery error"}` });
      }
    }

    if (input.action === "approve" || input.action === "reject") {
      if (invoice.status !== "pending_approval") throw new HttpError(409, "This invoice approval request has already been decided.");
      const { error: decisionError } = await supabase.rpc("operational_decide_invoice", {
        p_id: id, p_decision: input.action === "approve" ? "approved" : "rejected", p_comment: input.comment,
      });
      if (decisionError?.code === "P0001") throw new HttpError(409, decisionError.message);
      databaseError(decisionError);
      if (input.action === "reject") return NextResponse.json({ message: "Invoice approval request rejected." });
      const { data: issued, error: issuedError } = await admin.from("invoices").select("*").eq("id", id).maybeSingle();
      databaseError(issuedError);
      const { data: lead, error: leadError } = await admin.from("leads").select("id,name,email").eq("id", invoice.lead_id).maybeSingle();
      databaseError(leadError);
      if (!issued || !lead) throw new HttpError(500, "Approved invoice could not be loaded for delivery.");
      try {
        const result = await deliverInvoice(admin, issued, lead, issued.creator_email);
        return NextResponse.json({ message: "Invoice approved; invoice email accepted by SMTP.", messageId: result.messageId });
      } catch (deliveryError) {
        return NextResponse.json({ message: `Invoice approved, but automatic delivery failed: ${deliveryError instanceof Error ? deliveryError.message : "Delivery failed."}` });
      }
    }

    if (input.action === "external_payment") {
      const { data: recorded, error: recordError } = await supabase.rpc("operational_confirm_external_payment", {
        p_invoice_id: id, p_reference: input.reference, p_evidence: input.evidence,
      });
      if (recordError?.code === "P0001") throw new HttpError(409, recordError.message);
      databaseError(recordError);
      try {
        await sendPaymentReceipt(admin, id);
        return NextResponse.json({ recorded: recorded ?? true, message: "External payment verified and receipt accepted by SMTP." });
      } catch (receiptError) {
        return NextResponse.json({ recorded: recorded ?? true, message: `Payment verified, but receipt delivery failed: ${receiptError instanceof Error ? receiptError.message : "delivery error"}` });
      }
    }

    if (invoice.status !== "sent") throw new HttpError(409, "Only issued invoices can be emailed.");
    if (invoice.created_by !== user.id && !user.permissions.includes("invoices.approve"))
      throw new HttpError(403, "Only the invoice creator or an approver can send it.");
    const { data: lead, error: leadError } = await admin.from("leads").select("id,name,email").eq("id", invoice.lead_id).maybeSingle();
    databaseError(leadError);
    if (!lead) throw new HttpError(404, "Lead no longer exists.");
    const result = await deliverInvoice(admin, invoice, lead, invoice.creator_email);
    return NextResponse.json({ message: "Invoice accepted by the SMTP server. Delivery is not guaranteed.", messageId: result.messageId });
  } catch (error) { return jsonError(error); }
}
