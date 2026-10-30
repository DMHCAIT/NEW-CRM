import { randomBytes, randomInt } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { z } from "zod";
import { getSupabaseAdminClient, getSupabaseServerClient } from "@/lib/supabase/server";
import { HttpError } from "@/lib/server/auth";
import { ConfigurationError, requireEnv } from "@/lib/server/env";
import { sendMail, emailLayout } from "@/lib/server/mailer";
import { decryptSession, encryptSession, encryptionKey, loginHash } from "@/lib/server/login-crypto";
import { deviceLabel } from "@/lib/device";

const challengeCookie = "crm-login-challenge";
const deviceCookie = "crm-device";
const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/", maxAge: 600 };
const sessionSchema = z.object({ access_token: z.string(), refresh_token: z.string() });

function secretKey() {
  try { return encryptionKey(requireEnv("AUTH_ENCRYPTION_KEY")); }
  catch (error) { throw new ConfigurationError(error instanceof Error ? error.message : "Invalid authentication configuration."); }
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  let expected: string;
  const configured = requireEnv("NEXT_PUBLIC_APP_URL");
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid origin");
    expected = url.origin;
  } catch {
    throw new ConfigurationError("NEXT_PUBLIC_APP_URL must be a valid HTTP(S) origin, without a path, query or credentials.");
  }
  if (!origin || origin !== expected) throw new HttpError(403, "Request origin is not allowed.");
}

export async function startLogin(request: Request, email: string, password: string) {
  const key = secretKey();
  const admin = getSupabaseAdminClient();
  const limits = [{ value: `email:${email.toLowerCase()}`, max: 8 }];
  for (const limit of limits) {
    const { data, error } = await admin.rpc("allow_login_attempt", { rate_key: loginHash(limit.value, key), max_attempts: limit.max });
    if (error) throw error;
    if (!data) throw new HttpError(429, "Too many sign-in attempts. Please wait 15 minutes and try again.");
  }
  const isolated = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await isolated.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user.email) throw new HttpError(401, "Invalid email or password, or account unavailable.");
  const { data: profile, error: profileError } = await admin.from("profiles").select("status,deleted_at").eq("id", data.user.id).maybeSingle();
  if (profileError) throw profileError;
  if (!profile || profile.status !== "active" || profile.deleted_at) throw new HttpError(401, "Invalid email or password, or account unavailable.");
  const id = randomBytes(32).toString("hex");
  const code = randomInt(100000, 1000000).toString();
  const store = await cookies();
  const previousDevice = store.get(deviceCookie)?.value;
  const deviceId = previousDevice && /^[a-f0-9]{64}$/.test(previousDevice) ? previousDevice : randomBytes(32).toString("hex");
  const { error: insertError } = await admin.from("login_challenges").insert({
    id: loginHash(id, key), user_id: data.user.id, code_hash: loginHash(`${id}:${code}`, key),
    encrypted_session: encryptSession(JSON.stringify({ access_token: data.session.access_token, refresh_token: data.session.refresh_token }), key),
    device: deviceLabel(request.headers.get("user-agent")),
    device_id: loginHash(`device:${deviceId}`, key),
  });
  if (insertError) throw insertError;
  try {
    await sendMail({
      to: data.user.email, subject: "Your DMHCA CRM verification code",
      html: emailLayout("Verify your sign-in", `<p>Your verification code is:</p><p style="font-size:30px;letter-spacing:6px"><strong>${code}</strong></p><p>It expires in 10 minutes. Never share this code. If you did not request it, change your password and contact your administrator.</p>`),
    });
  } catch (error) {
    console.error("Verification email delivery failed", error);
    const { error: cleanupError } = await admin.from("login_challenges").delete().eq("id", loginHash(id, key));
    if (cleanupError) console.error("Could not remove undelivered login challenge", cleanupError);
    throw new HttpError(503, "Verification email could not be sent. Contact your administrator to check SMTP settings.");
  }
  const previous = store.get(challengeCookie)?.value;
  if (previous) {
    const { error: cleanupError } = await admin.from("login_challenges").delete().eq("id", loginHash(previous, key));
    if (cleanupError) throw cleanupError;
  }
  store.set(challengeCookie, id, cookieOptions);
  store.set(deviceCookie, deviceId, { ...cookieOptions, maxAge: 365 * 24 * 60 * 60 });
}

export async function verifyLogin(code: string) {
  const store = await cookies();
  const id = store.get(challengeCookie)?.value;
  if (!id || !/^[a-f0-9]{64}$/.test(id)) throw new HttpError(401, "Your sign-in request expired. Enter your email and password again.");
  const key = secretKey();
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("consume_login_challenge", { challenge_id: loginHash(id, key), supplied_hash: loginHash(`${id}:${code}`, key) });
  if (error) throw error;
  const challenge = data?.[0];
  if (!challenge) throw new HttpError(401, "Invalid or expired code. After five incorrect codes, start sign-in again.");
  const deviceId = store.get(deviceCookie)?.value;
  if (!deviceId || !/^[a-f0-9]{64}$/.test(deviceId) || challenge.device_id !== loginHash(`device:${deviceId}`, key)) {
    throw new HttpError(401, "Your sign-in device changed. Enter your email and password again.");
  }
  const tokens = sessionSchema.parse(JSON.parse(decryptSession(challenge.encrypted_session, key)));
  const isolated = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authenticated, error: authError } = await isolated.auth.setSession(tokens);
  if (authError || !authenticated.session || !authenticated.user || authenticated.user.id !== challenge.user_id) throw new HttpError(401, "Sign-in expired. Please start again.");
  const { data: profile, error: profileError } = await admin.from("profiles").select("status,deleted_at").eq("id", authenticated.user.id).single();
  if (profileError) throw profileError;
  if (profile.status !== "active" || profile.deleted_at) throw new HttpError(403, "Your account is inactive. Contact your administrator.");
  // The token was verified with Supabase above; bind verification to this exact Auth session.
  const claims = z.object({ session_id: z.string().uuid() }).parse(JSON.parse(Buffer.from(authenticated.session.access_token.split(".")[1], "base64url").toString()));
  const { error: auditError } = await admin.from("login_sessions").insert({
    session_id: claims.session_id, user_id: authenticated.user.id, email: authenticated.user.email,
    device: challenge.device,
    device_id: challenge.device_id,
  });
  if (auditError) throw auditError;
  const supabase = await getSupabaseServerClient();
  const { error: sessionError } = await supabase.auth.setSession({
    access_token: authenticated.session.access_token, refresh_token: authenticated.session.refresh_token,
  });
  if (sessionError) throw sessionError;
  store.delete(challengeCookie);
}
