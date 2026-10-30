import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/auth";
import { requireEnv } from "@/lib/server/env";
import { encryptSession } from "@/lib/server/login-crypto";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { databaseError } from "@/lib/server/operational";
import { canConnectMailbox, crmSessionId, gmailCallback, gmailCookie, gmailCryptoKey, gmailScopes, oauthParameters, oauthStateHash } from "@/lib/server/operational-gmail";
import { checkOrigin } from "@/lib/server/login";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const { supabase, user } = await requireUser();
    canConnectMailbox(user.permissions);
    const config = await getIntegrationConfig("gmail");
    const clientId = requireIntegrationValue(config, "GOOGLE_CLIENT_ID");
    requireIntegrationValue(config, "GOOGLE_CLIENT_SECRET"); requireEnv("NEXT_PUBLIC_APP_URL");
    const redirectUri = gmailCallback(config);
    const key = gmailCryptoKey();
    const { state, verifier, challenge } = oauthParameters();
    const sessionId = await crmSessionId(supabase);
    const admin = getSupabaseAdminClient();
    const { error } = await admin.from("gmail_oauth_states").insert({ state_hash: oauthStateHash(state), user_id: user.id, session_id: sessionId, encrypted_verifier: encryptSession(verifier, key), expires_at: new Date(Date.now() + 600000).toISOString() });
    databaseError(error);
    await admin.from("gmail_oauth_states").delete().lt("expires_at", new Date().toISOString());
    const store = await cookies();
    store.set(gmailCookie, state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/auth/gmail", maxAge: 600 });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code",
      scope: gmailScopes.join(" "), access_type: "offline", prompt: "consent", login_hint: user.email,
      state, code_challenge: challenge, code_challenge_method: "S256" }).toString();
    return NextResponse.json({ url: url.toString() });
  } catch (error) { return jsonError(error); }
}
