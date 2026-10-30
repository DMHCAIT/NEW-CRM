import { NextResponse } from "next/server";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError } from "@/lib/server/operational";
import { gmailSyncPage, validGmailToken, type GmailSyncState } from "@/lib/server/operational-gmail";
import { integrationStatus } from "@/lib/server/integration-settings";
import { checkOrigin } from "@/lib/server/login";

export const maxDuration = 180;

export async function POST(request: Request) {
  let cleanup: (() => Promise<void>) | undefined;
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser("integrations.manage");
    const configuration = await integrationStatus("gmail");
    if (!configuration.configured) throw new HttpError(503, `Gmail setup missing: ${configuration.missing.join(", ")}.`);
    const admin = getSupabaseAdminClient();
    const lock = new Date().toISOString();
    const stale = new Date(Date.now() - 15 * 60000).toISOString();
    const { data: connection, error } = await admin.from("gmail_connections").update({ sync_lock_at: lock }).eq("user_id", user.id).or(`sync_lock_at.is.null,sync_lock_at.lt.${stale}`).select("*").maybeSingle();
    databaseError(error);
    if (!connection) throw new HttpError(409, "Connect Gmail first, or wait for the current sync to finish. Interrupted sync leases expire after 15 minutes.");
    cleanup = async () => {
      await admin.from("gmail_connections").update({ sync_lock_at: null, last_error: "Synchronization stopped. Retry; if Gmail history expired, reset synchronization." }).eq("user_id", user.id).eq("sync_lock_at", lock);
    };
    const token = await validGmailToken(admin, connection);
    const result = await gmailSyncPage(token, connection.sync_state as GmailSyncState, connection.history_id);
    const records = [];
    for (const message of result.messages) {
      const sender = "from_email" in message ? message.from_email : "";
      let leadId: string | null = null;
      if (sender) {
        const { data: lead, error: leadError } = await supabase.from("leads").select("id").eq("normalized_email", sender).eq("is_archived", false).is("merged_into_id", null).order("created_at").limit(1).maybeSingle();
        databaseError(leadError);
        leadId = lead?.id ?? null;
      }
      records.push({ ...message, lead_id: leadId, log_email: Boolean(leadId && user.permissions.includes("leads.edit")) });
    }
    const { error: saveError } = await admin.rpc("integration_commit_gmail", { p_user_id: user.id, p_lock_at: lock, p_messages: records, p_state: result.state, p_history_id: result.historyId });
    databaseError(saveError);
    cleanup = undefined;
    return NextResponse.json({ message: `Synchronized ${records.length} message changes. ${result.more ? "More pages remain; click Continue sync." : "Caught up to the stored Gmail history cursor."}`, more: result.more, processed: records.length });
  } catch (error) { if (cleanup) await cleanup(); return jsonError(error); }
}

export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser("integrations.manage");
    const admin = getSupabaseAdminClient();
    // Reset is explicit: expired history cursors require a fresh, paginated inbox import.
    const { error } = await admin.rpc("integration_set_gmail", { p_user_id: user.id, p_action: "reset" });
    databaseError(error);
    return NextResponse.json({ message: "History cursor reset. Run sync to re-import the inbox, continuing until all pages finish." });
  } catch (error) { return jsonError(error); }
}
