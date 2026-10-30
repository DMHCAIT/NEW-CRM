import { NextResponse } from "next/server";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { canConnectMailbox } from "@/lib/server/operational-gmail";
import { checkOrigin } from "@/lib/server/login";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError } from "@/lib/server/operational";

export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    if (!user.permissions.includes("integrations.view") && !user.permissions.includes("leads.edit")) throw new HttpError(403, "Mailbox access is not permitted.");
    const admin = getSupabaseAdminClient();
    const [{ data: connection, error }, { data: messages, error: messageError }] = await Promise.all([
      admin.from("gmail_connections").select("email,history_id,sync_state,last_synced_at,last_error,sync_lock_at").eq("user_id", user.id).maybeSingle(),
      supabase.from("gmail_messages").select("id,gmail_message_id,lead_id,from_email,to_email,subject,body,received_at").eq("user_id", user.id).eq("in_inbox", true).eq("is_deleted", false).order("received_at", { ascending: false }).limit(50),
    ]);
    databaseError(error); databaseError(messageError);
    return NextResponse.json({ connection: connection ? { email: connection.email, last_synced_at: connection.last_synced_at, last_error: connection.last_error,
      initialSync: connection.sync_state?.mode === "bootstrap", hasPendingPage: Boolean(connection.sync_state?.queue?.length || connection.sync_state?.pageToken), syncInProgress: Boolean(connection.sync_lock_at) } : null,
      messages: messages ?? [], canManage: user.permissions.includes("integrations.manage"), canConnect: user.permissions.includes("leads.edit") || user.permissions.includes("integrations.manage") });
  } catch (error) { return jsonError(error); }
}
export async function DELETE(request: Request) {
  try {
    checkOrigin(request);
    const { user } = await requireUser();
    canConnectMailbox(user.permissions);
    const admin = getSupabaseAdminClient();
    const { error } = await admin.rpc("integration_set_gmail", { p_user_id: user.id, p_action: "disconnect" });
    databaseError(error);
    return NextResponse.json({ message: "Local Gmail credentials and inbox copy deleted. Previously linked CRM email history is retained. Revoke this app separately in your Google account to revoke the remote grant." });
  } catch (error) { return jsonError(error); }
}
