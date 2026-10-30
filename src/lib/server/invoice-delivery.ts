import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError, isEmail } from "@/lib/server/auth";
import { databaseError, integrationRequirements } from "@/lib/server/operational";
import { integrationStatus } from "@/lib/server/integration-settings";
import { createInvoicePaymentLink, createPublicStatusToken } from "@/lib/server/razorpay";
import { buildInvoicePdf, type InvoicePdfRecord } from "@/lib/server/invoice-pdf";
import { emailLayout, escapeHtml, sendMail } from "@/lib/server/mailer";
import { appUrl } from "@/lib/server/env";

type InvoiceRow = InvoicePdfRecord & {
  id: string;
  lead_id: string;
  created_by: string;
  payment_type: string;
  total: number | string;
  currency: string;
  email_message_id?: string | null;
  razorpay_payment_link_id?: string | null;
  razorpay_short_url?: string | null;
  creator_email?: string | null;
};
type LeadRow = { id: string; name: string; email: string | null };

export async function deliverInvoice(admin: SupabaseClient, invoice: InvoiceRow, lead: LeadRow, creatorEmail?: string | null) {
  if (invoice.status !== "sent") throw new HttpError(409, "Only issued invoices can be delivered.");
  if (!lead.email || !isEmail(lead.email)) throw new HttpError(400, "Set a valid email address on the lead first.");
  const smtp = await integrationStatus("smtp", integrationRequirements.smtp);
  if (invoice.email_message_id) throw new HttpError(409, "Invoice email was already accepted by SMTP.");
  const emailLock = new Date().toISOString();
  const { data: emailClaim, error: emailClaimError } = await admin.from("invoices").update({ email_lock_at: emailLock })
    .eq("id", invoice.id).eq("status", "sent").is("email_lock_at", null).select("id").maybeSingle();
  databaseError(emailClaimError);
  if (!emailClaim) throw new HttpError(409, "Invoice email delivery is in progress or requires reconciliation.");

  let shortUrl = invoice.razorpay_short_url as string | null;
  let statusUrl = "";
  try {
    if (invoice.payment_type === "one_shot" || invoice.payment_type === "installments") {
      const razorpay = await integrationStatus("razorpay", integrationRequirements.razorpay);
      if (!razorpay.configured) throw new HttpError(503, `Payment setup missing: ${razorpay.missing.join(", ")}.`);
      const publicToken = createPublicStatusToken();
      if (!shortUrl) {
        const lockAt = new Date().toISOString();
        const { data: claim, error: claimError } = await admin.from("invoices")
          .update({ payment_link_lock_at: lockAt })
          .eq("id", invoice.id).eq("status", "sent").is("razorpay_payment_link_id", null)
          .is("payment_link_lock_at", null).select("id").maybeSingle();
        databaseError(claimError);
        if (!claim) throw new HttpError(409, "Payment Link creation is in progress or requires Razorpay reconciliation.");
        try {
          const link = await createInvoicePaymentLink({
            invoiceId: invoice.id, invoiceNo: invoice.invoice_no, leadId: lead.id, leadName: lead.name,
            leadEmail: lead.email, amount: Number(invoice.total), currency: invoice.currency,
          });
          const { data: saved, error: saveError } = await admin.from("invoices").update({
            razorpay_payment_link_id: link.id, razorpay_short_url: link.short_url,
            status_token_hash: publicToken.hash, payment_link_lock_at: null,
          }).eq("id", invoice.id).eq("payment_link_lock_at", lockAt).eq("status", "sent").select("id").maybeSingle();
          if (saveError || !saved) throw new Error(`Razorpay link ${link.id} exists but persistence failed. Reconcile it before retrying. ${saveError?.message ?? ""}`);
          shortUrl = link.short_url;
        } catch (error) {
          throw new Error(`Payment Link creation did not complete: ${error instanceof Error ? error.message : "provider error"}. The payment lock is retained; verify Razorpay before retrying.`);
        }
      } else {
        const { error: tokenError } = await admin.from("invoices").update({ status_token_hash: publicToken.hash })
          .eq("id", invoice.id).eq("status", "sent");
        databaseError(tokenError);
      }
      statusUrl = `${appUrl()}/invoice-status/${encodeURIComponent(publicToken.token)}`;
    }
    if (!smtp.configured) throw new HttpError(503, `Email setup missing: ${smtp.missing.join(", ")}.`);
  } catch (error) {
    await admin.from("invoices").update({ email_lock_at: null }).eq("id", invoice.id).eq("email_lock_at", emailLock);
    throw error;
  }

  const { data: fullInvoice, error: invoiceError } = await admin.from("invoices")
    .select("*,invoice_items(*)").eq("id", invoice.id).maybeSingle();
  databaseError(invoiceError);
  const paymentHtml = shortUrl
    ? `<p>Pay securely: <a href="${escapeHtml(shortUrl)}">${escapeHtml(shortUrl)}</a></p><p><a href="${escapeHtml(statusUrl)}">View secure payment status</a></p>`
    : `<p>Payment arrangement: ${escapeHtml(invoice.payment_type.toUpperCase())}. Contact your counselor for financing confirmation.</p>`;
  const pdf = await buildInvoicePdf(fullInvoice ?? invoice, lead);
  const cc = creatorEmail && isEmail(creatorEmail) && creatorEmail.toLowerCase() !== lead.email.toLowerCase() ? creatorEmail : undefined;
  const messageId = await sendMail({
    to: lead.email, cc, subject: `Invoice ${invoice.invoice_no}`,
    html: emailLayout("Invoice", `<p>Hello ${escapeHtml(lead.name)},</p><p>Invoice <strong>${escapeHtml(invoice.invoice_no)}</strong><br>Total due: ${Number(invoice.total).toFixed(2)} ${escapeHtml(invoice.currency)}</p>${paymentHtml}<p>Invoice attached as PDF.</p>`),
    attachments: [{ filename: `${invoice.invoice_no}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
  const { error: saveError } = await admin.from("invoices").update({ sent_at: new Date().toISOString(), email_message_id: messageId, email_lock_at: null })
    .eq("id", invoice.id).eq("email_lock_at", emailLock);
  if (saveError) throw new Error(`SMTP accepted this email (${messageId}) but saving the receipt failed. Do not resend without reconciliation.`);
  return { messageId, shortUrl };
}

export async function sendPaymentReceipt(admin: SupabaseClient, invoiceId: string) {
  const { data: invoice, error } = await admin.from("invoices").select("*,invoice_items(*)").eq("id", invoiceId).maybeSingle();
  databaseError(error);
  if (!invoice) throw new Error("Paid invoice is unavailable for receipt delivery.");
  const { data: lead, error: leadError } = await admin.from("leads").select("id,name,email").eq("id", invoice.lead_id).maybeSingle();
  databaseError(leadError);
  if (!lead?.email || !isEmail(lead.email)) throw new Error("Payment recorded, but receipt email could not be sent: lead email is missing or invalid.");
  const smtp = await integrationStatus("smtp", integrationRequirements.smtp);
  if (!smtp.configured) throw new Error(`Payment recorded, but receipt email setup is missing: ${smtp.missing.join(", ")}.`);
  const pdf = await buildInvoicePdf(invoice, lead);
  const receiptLock = new Date().toISOString();
  const { data: receiptClaim, error: receiptClaimError } = await admin.from("invoices")
    .update({ receipt_email_lock_at: receiptLock }).eq("id", invoiceId).eq("status", "paid")
    .is("receipt_email_message_id", null).is("receipt_email_lock_at", null).select("id").maybeSingle();
  databaseError(receiptClaimError);
  if (!receiptClaim) {
    const { data: current, error: currentError } = await admin.from("invoices").select("receipt_email_message_id")
      .eq("id", invoiceId).maybeSingle();
    databaseError(currentError);
    if (current?.receipt_email_message_id) return current.receipt_email_message_id;
    throw new Error("Receipt delivery is in progress or requires reconciliation.");
  }
  const messageId = await sendMail({
    to: lead.email,
    cc: invoice.creator_email && isEmail(invoice.creator_email) && invoice.creator_email.toLowerCase() !== lead.email.toLowerCase() ? invoice.creator_email : undefined,
    subject: `Payment receipt · Invoice ${invoice.invoice_no}`,
    html: emailLayout("Payment received", `<p>Hello ${escapeHtml(lead.name)},</p><p>Payment for invoice <strong>${escapeHtml(invoice.invoice_no)}</strong> has been verified.</p><p>Received: ${Number(invoice.total).toFixed(2)} ${escapeHtml(invoice.currency)}<br>Invoice status: Paid</p><p>Your paid invoice/receipt is attached.</p>`),
    attachments: [{ filename: `${invoice.invoice_no}-receipt.pdf`, content: pdf, contentType: "application/pdf" }],
  });
  const { error: saveError } = await admin.from("invoices").update({ receipt_email_message_id: messageId, receipt_email_lock_at: null })
    .eq("id", invoiceId).eq("receipt_email_lock_at", receiptLock);
  databaseError(saveError);
  return messageId;
}
