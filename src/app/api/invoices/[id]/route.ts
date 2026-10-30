import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, jsonError, readJson, requireUser } from "@/lib/server/auth";
import { databaseError, parseInput, uuid } from "@/lib/server/operational";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { checkOrigin } from "@/lib/server/login";
import { deliverInvoice, sendPaymentReceipt } from "@/lib/server/invoice-delivery";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["approve", "reject"]), comment: z.string().trim().max(2000).default("") }),
  z.object({ action: z.literal("email") }),
  z.object({ action: z.literal("external_payment"), reference: z.string().trim().min(1).max(200), evidence: z.string().trim().min(1).max(2000) }),
]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    checkOrigin(request);
    const input = parseInput(actionSchema, await readJson(request));
    const { supabase, user } = await requireUser(input.action === "email" ? "invoices.create" : "invoices.approve");
    const id = parseInput(uuid, (await context.params).id);
    const { data: invoice, error } = await supabase.from("invoices").select("*").eq("id", id).maybeSingle();
    databaseError(error);
    if (!invoice) throw new HttpError(404, "Invoice not found or inaccessible.");
    const admin = getSupabaseAdminClient();

    if (input.action === "approve" || input.action === "reject") {
      if (invoice.status !== "pending_approval") throw new HttpError(409, "This discount request has already been decided.");
      const { error: decisionError } = await supabase.rpc("operational_decide_invoice", {
        p_id: id, p_decision: input.action === "approve" ? "approved" : "rejected", p_comment: input.comment,
      });
      databaseError(decisionError);
      if (input.action === "reject") return NextResponse.json({ message: "Discount request rejected." });
      const { data: issued, error: issuedError } = await admin.from("invoices").select("*").eq("id", id).maybeSingle();
      databaseError(issuedError);
      const { data: lead, error: leadError } = await admin.from("leads").select("id,name,email").eq("id", invoice.lead_id).maybeSingle();
      databaseError(leadError);
      if (!issued || !lead) throw new HttpError(500, "Approved invoice could not be loaded for delivery.");
      try {
        const result = await deliverInvoice(admin, issued, lead, issued.creator_email);
        return NextResponse.json({ message: "Discount approved; invoice delivered.", messageId: result.messageId });
      } catch (deliveryError) {
        return NextResponse.json({ message: `Discount approved, but automatic delivery failed: ${deliveryError instanceof Error ? deliveryError.message : "Delivery failed."}` });
      }
    }

    if (input.action === "external_payment") {
      const { data: recorded, error: recordError } = await supabase.rpc("operational_confirm_external_payment", {
        p_invoice_id: id, p_reference: input.reference, p_evidence: input.evidence,
      });
      databaseError(recordError);
      try {
        await sendPaymentReceipt(admin, id);
        return NextResponse.json({ recorded: recorded ?? true, message: "External financing payment verified and receipt accepted by SMTP." });
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
