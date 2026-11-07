import type { SupabaseClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError, isEmail } from "@/lib/server/auth";
import { databaseError, integrationRequirements } from "@/lib/server/operational";
import { decryptIntegrationValues, encryptIntegrationValues, integrationStatus } from "@/lib/server/integration-settings";
import { createInvoicePaymentLink, createPublicStatusToken } from "@/lib/server/razorpay";
import { buildInvoicePdf, type InvoicePdfRecord } from "@/lib/server/invoice-pdf";
import { escapeHtml, sendMail } from "@/lib/server/mailer";
import { appUrl } from "@/lib/server/env";
import { ensureInvoiceCheckout } from "@/lib/server/invoice-checkout";
import { invoiceDeadline, invoiceProviderUrlValid, invoiceWindowExpired } from "@/lib/invoice-policy";
import { invoiceBranding } from "@/lib/invoice-branding";
import { legacyCompany } from "@/lib/billing";
import { buildInvoiceHtml } from "@/lib/invoice-document";

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
  owner_email?: string | null;
  stripe_session_id?: string | null;
  stripe_checkout_url?: string | null;
  status_token_encrypted?: string | null;
  payment_expires_at?: string | null;
  tax_review_required?: boolean;
  payment_revision?: number;
  scheduled_for?: string | null;
  parent_invoice_id?: string | null;
};
type LeadRow = { id: string; name: string; email: string | null };

function invoiceEmail(document: string, name: string, message: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:24px 12px;background:#edf1f7;font-family:Arial,sans-serif"><div style="max-width:820px;margin:0 auto"><p style="color:#34465e;font-size:14px">Hello ${escapeHtml(name)},<br>${escapeHtml(message)}</p>${document}<p style="color:#637187;font-size:12px">A copy is sent to your lead owner and invoice creator. Keep this invoice for your records.</p></div></body></html>`;
}

export async function deliverInvoice(admin: SupabaseClient, invoice: InvoiceRow, lead: LeadRow, creatorEmail?: string | null) {
  try {
    return await sendInvoice(admin, invoice, lead, creatorEmail);
  } catch (deliveryError) {
    const message = deliveryError instanceof Error ? deliveryError.message : "Invoice delivery failed.";
    console.error("INVOICE_DELIVERY", { invoiceId: invoice.id });
    const { error } = await admin.from("invoices").update({ delivery_error: message.slice(0, 2000) }).eq("id", invoice.id);
    if (error) throw new Error(`${message} The delivery error could not be saved; refresh and reconcile this invoice.`);
    throw deliveryError;
  }
}

async function sendInvoice(admin: SupabaseClient, invoice: InvoiceRow, lead: LeadRow, creatorEmail?: string | null) {
  lead = { ...lead, name: invoice.billing_name || lead.name, email: invoice.billing_email || lead.email };
  if (invoice.status !== "sent") throw new HttpError(409, "Only issued invoices can be delivered.");
  if (invoice.scheduled_for) {
    if (new Date(invoice.scheduled_for).getTime() > Date.now()) throw new HttpError(409, "This installment is not due for delivery yet.");
    if (invoice.parent_invoice_id) {
      const { data: enrollment, error: enrollmentError } = await admin.from("invoices")
        .select("status,approved_at,discount_percent,tax_review_required,pricing_review_note").eq("id", invoice.parent_invoice_id).maybeSingle();
      databaseError(enrollmentError);
      if (!enrollment || ["pending_approval", "rejected"].includes(enrollment.status) || enrollment.tax_review_required
        || ((Number(enrollment.discount_percent) > 0 || enrollment.pricing_review_note) && !enrollment.approved_at))
        throw new HttpError(409, "The enrollment must be approved before installment delivery.");
    }
  }
  if (invoice.tax_review_required) throw new HttpError(409, "Admin tax review is required before delivery.");
  if (invoiceWindowExpired(invoice)) throw new HttpError(410, "The four-day payment window expired. Issue a new invoice.");
  const deadline = invoice.payment_expires_at ?? invoiceDeadline(invoice.created_at);
  if (!lead.email || !isEmail(lead.email)) throw new HttpError(400, "Set a valid email address on the lead first.");
  const smtp = await integrationStatus("smtp", integrationRequirements.smtp);
  if (invoice.email_message_id) throw new HttpError(409, "Invoice email was already accepted by SMTP.");
  const cc = await deliveryRecipients(admin, invoice, lead.email, creatorEmail);
  const emailLock = new Date().toISOString();
  const { data: emailClaim, error: emailClaimError } = await admin.from("invoices").update({ email_lock_at: emailLock })
    .eq("id", invoice.id).eq("status", "sent").is("email_lock_at", null).select("id").maybeSingle();
  databaseError(emailClaimError);
  if (!emailClaim) throw new HttpError(409, "Invoice email delivery is in progress or requires reconciliation.");

  let shortUrl = ["one_shot", "installments"].includes(invoice.payment_type)
    ? invoice.currency === "USD" ? invoice.stripe_checkout_url ?? null : invoice.razorpay_short_url ?? null
    : null;
  let statusUrl = "";
  let paymentUrl = "";
  try {
    const publicToken = invoice.status_token_encrypted
      ? { token: decryptIntegrationValues(invoice.status_token_encrypted).token, hash: "" }
      : createPublicStatusToken();
    if (!publicToken.token) throw new HttpError(503, "Invoice status token is invalid. Reconcile this invoice before retrying.");
    if (!invoice.status_token_encrypted) {
      const { error: tokenError } = await admin.from("invoices").update({
        status_token_hash: publicToken.hash, status_token_encrypted: encryptIntegrationValues({ token: publicToken.token }),
      }).eq("id", invoice.id).eq("email_lock_at", emailLock);
      databaseError(tokenError);
    }
    statusUrl = `${appUrl("invoice")}/invoice-status/${encodeURIComponent(publicToken.token)}`;
    paymentUrl = `${appUrl("invoice")}/api/invoice-status/${encodeURIComponent(publicToken.token)}/pay`;
    if (invoice.payment_type === "one_shot" || invoice.payment_type === "installments") {
      if (!["INR", "USD"].includes(invoice.currency)) throw new HttpError(400, "Only INR and USD online payments are supported.");
      const provider = invoice.currency === "USD" ? "stripe" : "razorpay";
      const configuration = await integrationStatus(provider, integrationRequirements[provider]);
      if (!configuration.configured) throw new HttpError(503, `Payment setup missing: ${configuration.missing.join(", ")}.`);
      if (provider === "stripe") {
        await ensureInvoiceCheckout(admin, { ...invoice, payment_expires_at: deadline, billing_email: lead.email }, publicToken.token);
        shortUrl = statusUrl;
      } else if (!shortUrl) {
        const lockAt = new Date().toISOString();
        const { data: claim, error: claimError } = await admin.from("invoices")
          .update({ payment_link_lock_at: lockAt })
          .eq("id", invoice.id).eq("status", "sent").is("razorpay_payment_link_id", null)
          .is("payment_link_lock_at", null).select("id").maybeSingle();
        databaseError(claimError);
        if (!claim) throw new HttpError(409, "Payment creation is in progress or requires provider reconciliation.");
        try {
          const link = await createInvoicePaymentLink({
            invoiceId: invoice.id, invoiceNo: invoice.invoice_no, leadId: lead.id, leadName: lead.name,
            leadEmail: lead.email, amount: Number(invoice.total), currency: invoice.currency,
            expiresAt: Math.floor(new Date(deadline).getTime() / 1000),
            callbackUrl: statusUrl,
            revision: invoice.payment_revision,
          });
          const linkId = link.id;
          const linkUrl = link.short_url;
          if (!linkId || !linkUrl) throw new HttpError(502, "Payment provider returned no payment URL.");
          const { data: saved, error: saveError } = await admin.from("invoices").update({
            razorpay_payment_link_id: linkId, razorpay_short_url: linkUrl,
            payment_link_lock_at: null,
          }).eq("id", invoice.id).eq("payment_link_lock_at", lockAt).eq("status", "sent").select("id").maybeSingle();
          if (saveError || !saved) throw new Error(`${provider} payment ${linkId} exists but persistence failed. Reconcile it before retrying.`);
          shortUrl = linkUrl;
        } catch (error) {
          throw new Error(`Payment creation did not complete: ${error instanceof Error ? error.message : "provider error"}. The payment lock is retained; verify the provider before retrying.`);
        }
      }
    }
    if (invoice.currency === "INR" && shortUrl) {
      if (!invoiceProviderUrlValid(shortUrl, "INR")) throw new HttpError(502, "The Razorpay payment URL is invalid. Contact finance.");
      paymentUrl = shortUrl;
    }
    if (!smtp.configured) throw new HttpError(503, `Email setup missing: ${smtp.missing.join(", ")}.`);
  } catch (error) {
    const { error: cleanupError } = await admin.from("invoices").update({ email_lock_at: null }).eq("id", invoice.id).eq("email_lock_at", emailLock);
    if (cleanupError) console.error("Could not release invoice email lease", cleanupError);
    throw error;
  }

  let mail: Parameters<typeof sendMail>[0];
  try {
    const { data: fullInvoice, error: invoiceError } = await admin.from("invoices")
      .select("*,invoice_items(*)").eq("id", invoice.id).maybeSingle();
    databaseError(invoiceError);
    if (!fullInvoice) throw new HttpError(500, "The saved invoice could not be loaded for its email and PDF.");
    const branding = invoiceBranding(fullInvoice.company_snapshot ?? { ...legacyCompany, code: invoice.company_code === "IBMP" ? "IBMP" : "DMHCA", legal_name: invoice.company_code ?? legacyCompany.legal_name });
    const document = buildInvoiceHtml(fullInvoice, {
      leadName: lead.name, leadEmail: lead.email, logoUrl: "cid:invoice-logo",
      paymentUrl: shortUrl ? paymentUrl : null, viewUrl: shortUrl ? undefined : statusUrl,
    });
    const [pdf, logo] = await Promise.all([
      buildInvoicePdf(fullInvoice, lead, shortUrl ? paymentUrl : null),
      readFile(join(process.cwd(), "public", branding.code === "IBMP" ? "IBMP-logo.png" : "DMHCA-invoice-logo.png")),
    ]);
    mail = {
      to: lead.email, cc, subject: `Invoice ${invoice.invoice_no}`, fromName: branding.legal_name,
      html: invoiceEmail(document, lead.name, "Please find your invoice below and attached as a PDF."),
      attachments: [
        { filename: `${invoice.invoice_no}.pdf`, content: pdf, contentType: "application/pdf" },
        { filename: `${branding.code}-logo.png`, content: logo, contentType: "image/png", cid: "invoice-logo" },
      ],
    };
  } catch (error) {
    const { error: cleanupError } = await admin.from("invoices").update({ email_lock_at: null }).eq("id", invoice.id).eq("email_lock_at", emailLock);
    if (cleanupError) console.error("Could not release invoice email lease", cleanupError);
    throw error;
  }
  const messageId = await sendMail(mail);
  const { data: saved, error: saveError } = await admin.from("invoices").update({ sent_at: new Date().toISOString(), email_message_id: messageId, email_lock_at: null, delivery_error: null })
    .eq("id", invoice.id).eq("email_lock_at", emailLock).select("id").maybeSingle();
  if (saveError || !saved) throw new Error(`SMTP accepted this email (${messageId}) but saving the receipt failed. Do not resend without reconciliation.`);
  return { messageId, shortUrl };
}

export async function sendPaymentReceipt(admin: SupabaseClient, invoiceId: string) {
  const { data: invoice, error } = await admin.from("invoices").select("*,invoice_items(*)").eq("id", invoiceId).maybeSingle();
  databaseError(error);
  if (!invoice) throw new Error("Paid invoice is unavailable for receipt delivery.");
  const { data: lead, error: leadError } = await admin.from("leads").select("id,name,email").eq("id", invoice.lead_id).maybeSingle();
  databaseError(leadError);
  if (lead) {
    lead.name = invoice.billing_name || lead.name;
    lead.email = invoice.billing_email || lead.email;
  }
  if (!lead?.email || !isEmail(lead.email)) throw new Error("Payment recorded, but receipt email could not be sent: lead email is missing or invalid.");
  const smtp = await integrationStatus("smtp", integrationRequirements.smtp);
  if (!smtp.configured) throw new Error(`Payment recorded, but receipt email setup is missing: ${smtp.missing.join(", ")}.`);
  const cc = await deliveryRecipients(admin, invoice, lead.email);
  const branding = invoiceBranding(invoice.company_snapshot ?? { ...legacyCompany, code: invoice.company_code === "IBMP" ? "IBMP" : "DMHCA", legal_name: invoice.company_code ?? legacyCompany.legal_name });
  const [pdf, logo] = await Promise.all([
    buildInvoicePdf(invoice, lead),
    readFile(join(process.cwd(), "public", branding.code === "IBMP" ? "IBMP-logo.png" : "DMHCA-invoice-logo.png")),
  ]);
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
    cc,
    subject: `Payment receipt · Invoice ${invoice.invoice_no}`,
    fromName: branding.legal_name,
    html: invoiceEmail(
      buildInvoiceHtml(invoice, { leadName: lead.name, leadEmail: lead.email, logoUrl: "cid:invoice-logo" }),
      lead.name, "Your payment has been verified. The same invoice is now Paid, shown below and attached as a PDF.",
    ),
    attachments: [
      { filename: `${invoice.invoice_no}-receipt.pdf`, content: pdf, contentType: "application/pdf" },
      { filename: `${branding.code}-logo.png`, content: logo, contentType: "image/png", cid: "invoice-logo" },
    ],
  });
  const { error: saveError } = await admin.from("invoices").update({ receipt_email_message_id: messageId, receipt_email_lock_at: null })
    .eq("id", invoiceId).eq("receipt_email_lock_at", receiptLock);
  databaseError(saveError);
  return messageId;
}

async function deliveryRecipients(admin: SupabaseClient, invoice: InvoiceRow, to: string, creatorEmail?: string | null) {
  const { data: lead, error: leadError } = await admin.from("leads").select("assignee_id").eq("id", invoice.lead_id).maybeSingle();
  databaseError(leadError);
  if (!lead?.assignee_id) throw new HttpError(400, "Assign a lead owner before sending the invoice.");
  const { data: owner, error: ownerError } = await admin.from("profiles").select("email").eq("id", lead.assignee_id).maybeSingle();
  databaseError(ownerError);
  if (!owner?.email || !isEmail(owner.email)) throw new HttpError(400, "Set a valid email address for the lead owner before sending the invoice.");
  return invoiceRecipients(to, invoice.creator_email || creatorEmail, owner.email);
}

export function invoiceRecipients(to: string, ...addresses: (string | null | undefined)[]) {
  return [...new Set(addresses.filter((value): value is string => Boolean(value && isEmail(value)))
    .map(value => value.toLowerCase()).filter(value => value !== to.toLowerCase()))].join(", ") || undefined;
}
