import { NextResponse } from "next/server";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { canConnectMailbox, canSyncMailbox } from "@/lib/server/operational-gmail";
import { checkOrigin } from "@/lib/server/login";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError } from "@/lib/server/operational";
import { getIntegrationConfig } from "@/lib/server/integration-settings";
import { workspaceMailboxEligible, workspaceManaged } from "@/lib/server/gmail-delegation";

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    canSyncMailbox(user.permissions);
    const admin = getSupabaseAdminClient();
    const config = await getIntegrationConfig("gmail");
    const managed = workspaceManaged(config);
    const eligible = !managed || workspaceMailboxEligible(config, user.email);
    const [{ data: connection, error }, { data: messages, error: messageError }] = await Promise.all([
      admin.from("gmail_connections").select("email,auth_mode,history_id,sync_state,last_synced_at,last_error,sync_lock_at").eq("user_id", user.id).maybeSingle(),
      supabase.from("gmail_messages").select("id,gmail_message_id,lead_id,from_email,to_email,subject,body,received_at").eq("user_id", user.id).eq("in_inbox", true).eq("is_deleted", false).order("received_at", { ascending: false }).limit(50),
    ]);
    databaseError(error); databaseError(messageError);
    const usable = eligible && connection && (managed || connection.auth_mode !== "workspace") && connection.email.toLowerCase() === user.email.toLowerCase() ? connection : null;
    return NextResponse.json({ managed, unavailableReason: eligible ? null : "Your CRM login is outside the configured Workspace domain. Managed Gmail is unavailable for this account.", connection: usable ? { email: usable.email, last_synced_at: usable.last_synced_at, last_error: usable.last_error,
      initialSync: usable.sync_state?.mode === "bootstrap", hasPendingPage: Boolean(usable.sync_state?.queue?.length || usable.sync_state?.pageToken), syncInProgress: usable.sync_lock_at ? Date.now() - new Date(usable.sync_lock_at).getTime() < 15 * 60_000 : false } : managed && eligible ? { email: user.email, last_synced_at: null, last_error: null, initialSync: true, hasPendingPage: false, syncInProgress: false } : null,
      messages: usable ? messages ?? [] : [], canSync: true, canConnect: !managed && (user.permissions.includes("leads.edit") || user.permissions.includes("integrations.manage")) });
  } catch (error) { return jsonError(error); }
}
export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser();
    canConnectMailbox(user.permissions);
    if (workspaceManaged(await getIntegrationConfig("gmail"))) throw new HttpError(409, "Workspace mailbox access is administrator-managed. Ask your administrator to change the organization's Gmail settings.");
    const admin = getSupabaseAdminClient();
    const { error } = await admin.rpc("integration_set_gmail", { p_user_id: user.id, p_action: "disconnect" });
    databaseError(error);
    return NextResponse.json({ message: "Local Gmail credentials and inbox copy deleted. Previously linked CRM email history is retained. Revoke this app separately in your Google account to revoke the remote grant." });
  } catch (error) { return jsonError(error); }
}
