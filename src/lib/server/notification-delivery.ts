import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { dbError } from "@/lib/live-leads";
import { appUrl } from "@/lib/server/env";
import { emailLayout, escapeHtml, sendMail } from "@/lib/server/mailer";

const queuedEmail = z.object({
  id: z.string(), claim_token: z.string(), recipient: z.string().nullable(), message: z.string(), lead_id: z.string(),
});

export async function deliverLeadNotifications(admin: SupabaseClient) {
  const due = await admin.rpc("release_due_call_notifications");
  dbError(due.error);
  const reminders = z.number().int().nonnegative().parse(due.data);
  const claimed = await admin.rpc("claim_notification_emails");
  dbError(claimed.error);
  const emails = z.array(queuedEmail).parse(claimed.data);
  const results: { id: string; sent: boolean }[] = [];
  for (const row of emails) {
    const lease = await admin.from("notification_email_queue").update({ claimed_at: new Date().toISOString() })
      .eq("id", row.id).eq("claim_token", row.claim_token).eq("status", "sending").select("id").maybeSingle();
    dbError(lease.error);
    if (!lease.data) throw new Error("Notification delivery lease was reassigned before sending.");
    let deliveryError: string | null = null;
    try {
      if (!row.recipient) throw new Error("The notification owner has no active email address.");
      const link = `${appUrl("notification")}/leads/${row.lead_id}`;
      await sendMail({
        to: row.recipient,
        subject: "CRM lead notification",
        html: emailLayout("Lead notification", `<p>${escapeHtml(row.message)}</p><p><a href="${escapeHtml(link)}">View lead</a></p>`),
        text: `${row.message}\n\nView lead: ${link}`,
      });
    } catch (failure) {
      deliveryError = failure instanceof Error ? failure.message : "Notification email delivery failed.";
      console.error("Notification email delivery failed", { queueId: row.id });
    }
    // Persist SMTP acceptance separately: a database failure must not be reported as a send failure.
    const saved = await admin.from("notification_email_queue").update({
      status: deliveryError ? "failed" : "sent",
      sent_at: deliveryError ? null : new Date().toISOString(),
      last_error: deliveryError?.slice(0, 2000) ?? null,
      retry_at: new Date(Date.now() + 60000).toISOString(),
    }).eq("id", row.id).eq("claim_token", row.claim_token).select("id").maybeSingle();
    dbError(saved.error);
    if (!saved.data) throw new Error("Notification delivery lease expired before its result could be recorded.");
    results.push({ id: row.id, sent: !deliveryError });
  }
  return { reminders, processed: results.length, failed: results.filter(row => !row.sent).length };
}
