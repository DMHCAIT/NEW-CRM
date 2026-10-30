import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { HttpError, jsonError, requireUser } from "@/lib/server/auth";
import { decryptSession, encryptSession } from "@/lib/server/login-crypto";
import { appUrl } from "@/lib/server/env";
import { getIntegrationConfig } from "@/lib/server/integration-settings";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError } from "@/lib/server/operational";
import { secureEqual } from "@/lib/server/operational-intake";
import { canConnectMailbox, crmSessionId, gmailCallback, gmailCookie, gmailCryptoKey, gmailRequest, gmailScopes, googleTokenRequest, oauthStateHash, requireLoginMailbox } from "@/lib/server/operational-gmail";

export async function GET(request: Request) {
  try {
    const { supabase, user } = await requireUser();
    canConnectMailbox(user.permissions);
    const query = new URL(request.url).searchParams;
    const state = query.get("state") ?? "";
    const store = await cookies();
    const cookie = store.get(gmailCookie)?.value ?? "";
    if (!/^[\w-]{43}$/.test(state) || !cookie || !secureEqual(cookie, state)) throw new HttpError(403, "Gmail OAuth state does not match this browser.");
    const sessionId = await crmSessionId(supabase);
    const admin = getSupabaseAdminClient();
    // Atomic consume prevents code/state replay; binding includes the verified CRM auth session.
    const { data: pending, error } = await admin.from("gmail_oauth_states").delete().eq("state_hash", oauthStateHash(state)).eq("user_id", user.id).eq("session_id", sessionId).gt("expires_at", new Date().toISOString()).select("encrypted_verifier").maybeSingle();
    databaseError(error);
    store.set(gmailCookie, "", { path: "/api/auth/gmail", maxAge: 0 });
    if (!pending) throw new HttpError(403, "OAuth state expired or already used. Reconnect Gmail.");
    if (query.has("error")) throw new HttpError(400, "Google consent was declined. Return to Integrations and reconnect.");
    const code = query.get("code");
    if (!code || code.length > 4000) throw new HttpError(400, "Missing OAuth authorization code.");
    const key = gmailCryptoKey();
    const tokens = await googleTokenRequest({ grant_type: "authorization_code", code, redirect_uri: gmailCallback(await getIntegrationConfig("gmail")), code_verifier: decryptSession(pending.encrypted_verifier, key) });
    if (!tokens.refresh_token) throw new HttpError(400, "Google did not issue an offline refresh token. Remove this app's grant in Google and reconnect with consent.");
    const grantedScopes = tokens.scope?.split(" ") ?? [];
    if (!gmailScopes.every(scope => grantedScopes.includes(scope))) throw new HttpError(403, "Gmail read and send consent are both required.");
    const profile = await gmailRequest<{ emailAddress: string; historyId: string }>(tokens.access_token, "profile");
    if (!profile.emailAddress || !profile.historyId) throw new HttpError(502, "Google returned an invalid mailbox profile.");
    requireLoginMailbox(profile.emailAddress, user.email);
    const { error: saveError } = await admin.rpc("integration_set_gmail", {
      p_user_id: user.id, p_action: "connect", p_email: profile.emailAddress,
      p_encrypted_tokens: encryptSession(JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000, scope: tokens.scope }), key),
      p_baseline: profile.historyId,
    });
    databaseError(saveError);
    return NextResponse.redirect(`${appUrl()}${user.permissions.includes("integrations.view") ? "/integrations" : "/leads"}?gmail=connected`);
  } catch (error) { return jsonError(error); }
}
