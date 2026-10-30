import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { appUrl, requireEnv } from "@/lib/server/env";
import { decryptSession, encryptSession, encryptionKey } from "@/lib/server/login-crypto";
import { databaseError, parseInput } from "@/lib/server/operational";
import { getIntegrationConfig, requireIntegrationValue } from "@/lib/server/integration-settings";

export const gmailRequirements = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "AUTH_ENCRYPTION_KEY", "NEXT_PUBLIC_APP_URL", "SUPABASE_SERVICE_ROLE_KEY"];
export function gmailCallback(config?: Record<string, string>) {
  const configured = config ? requireIntegrationValue(config, "GOOGLE_REDIRECT_URI") : requireEnv("GOOGLE_REDIRECT_URI");
  if (configured !== `${appUrl()}/api/auth/gmail/callback`) throw new HttpError(503, "GOOGLE_REDIRECT_URI must equal NEXT_PUBLIC_APP_URL + /api/auth/gmail/callback.");
  return configured;
}
export const gmailCookie = "crm_gmail_oauth";
export function gmailCryptoKey() { return encryptionKey(requireEnv("AUTH_ENCRYPTION_KEY")); }
export const oauthStateHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function oauthParameters() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  return { state, verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
export async function crmSessionId(supabase: SupabaseClient) {
  // Caller has already used requireUser/getUser + is_verified_session; do not trust unverified cookies.
  const { data, error } = await supabase.auth.getSession();
  databaseError(error);
  const token = data.session?.access_token;
  if (!token) throw new HttpError(401, "Verified session required.");
  try {
    return parseInput(z.object({ session_id: z.string().uuid() }), JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))).session_id;
  } catch { throw new HttpError(401, "Session identifier unavailable."); }
}
type Tokens = { access_token: string; refresh_token: string; expires_at: number };
export const gmailScopes = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"];
export function canConnectMailbox(permissions: string[]) {
  if (!permissions.includes("leads.edit") && !permissions.includes("integrations.manage")) throw new HttpError(403, "Lead editing or integration management permission is required to connect your mailbox.");
}
export function requireLoginMailbox(mailboxEmail: string, loginEmail: string) {
  const email = parseInput(z.string().email(), mailboxEmail);
  if (!loginEmail || email.toLowerCase() !== loginEmail.toLowerCase()) throw new HttpError(409, `Connect the Google Workspace mailbox for your CRM login (${loginEmail}). A different email account cannot send as you.`);
  return email;
}
export async function prepareGmailSend(admin: SupabaseClient, userId: string, loginEmail: string) {
  const { data: connection, error } = await admin.from("gmail_connections").select("user_id,email,encrypted_tokens").eq("user_id", userId).maybeSingle();
  databaseError(error);
  if (!connection) throw new HttpError(409, "Connect your Gmail mailbox in Integrations before sending email. Shared SMTP is not used for lead email.");
  const email = requireLoginMailbox(connection.email, loginEmail);
  const stored = z.object({ scope: z.string() }).safeParse(JSON.parse(decryptSession(connection.encrypted_tokens, gmailCryptoKey())));
  if (!stored.success || !stored.data.scope.split(" ").includes(gmailScopes[1])) throw new HttpError(409, "Reconnect Gmail and grant email sending permission.");
  return { email, accessToken: await validGmailToken(admin, connection) };
}
export function gmailRawMessage(from: string, to: string, subject: string, text: string) {
  const email = z.string().email().refine(value => !/[\r\n]/.test(value));
  if (!email.safeParse(from).success || !email.safeParse(to).success || /[\r\n]/.test(subject)) throw new HttpError(400, "Invalid email headers.");
  const characters = Array.from(subject);
  const words: string[] = [];
  for (let index = 0; index < characters.length; index += 10) words.push(`=?UTF-8?B?${Buffer.from(characters.slice(index, index + 10).join("")).toString("base64")}?=`);
  const encodedSubject = words.join("\r\n ");
  const body = Buffer.from(text).toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  return Buffer.from([`From: ${from}`, `To: ${to}`, `Subject: ${encodedSubject}`, "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", body].join("\r\n")).toString("base64url");
}
export async function sendGmailMessage(mailbox: { email: string; accessToken: string }, to: string, subject: string, text: string) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { Authorization: `Bearer ${mailbox.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: gmailRawMessage(mailbox.email, to, subject, text) }),
    cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, response.status === 403 || response.status === 401
    ? "Gmail authorization failed. Reconnect your mailbox and grant sending permission."
    : "Gmail did not accept the email. Check your Sent folder before retrying.");
  return parseInput(z.object({ id: z.string().min(1) }), await response.json());
}
export async function googleTokenRequest(parameters: Record<string, string>) {
  const config = await getIntegrationConfig("gmail");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...parameters, client_id: requireIntegrationValue(config, "GOOGLE_CLIENT_ID"), client_secret: requireIntegrationValue(config, "GOOGLE_CLIENT_SECRET") }),
    cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new HttpError(502, "Google OAuth failed. Check the client credentials, redirect URL or reconnect the mailbox.");
  return parseInput(z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive(), scope: z.string().optional() }), await response.json());
}
export async function gmailRequest<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store", signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404) throw new HttpError(404, "Gmail history or message no longer exists.");
  if (!response.ok) throw new HttpError(response.status === 429 ? 429 : 502, "Gmail request failed. Check mailbox consent, API access and Google quota.");
  return await response.json() as T;
}
export async function validGmailToken(admin: SupabaseClient, connection: { user_id: string; encrypted_tokens: string }) {
  const key = gmailCryptoKey();
  const tokens = parseInput(z.object({ access_token: z.string(), refresh_token: z.string(), expires_at: z.number(), scope: z.string().optional() }), JSON.parse(decryptSession(connection.encrypted_tokens, key)));
  if (tokens.expires_at > Date.now() + 60000) return tokens.access_token;
  const fresh = await googleTokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  const updated: Tokens & { scope?: string } = { access_token: fresh.access_token, refresh_token: fresh.refresh_token ?? tokens.refresh_token, expires_at: Date.now() + fresh.expires_in * 1000, scope: fresh.scope ?? tokens.scope };
  const { error } = await admin.from("gmail_connections").update({ encrypted_tokens: encryptSession(JSON.stringify(updated), key), updated_at: new Date().toISOString() }).eq("user_id", connection.user_id);
  databaseError(error);
  return updated.access_token;
}

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
export type GmailMessage = {
  id: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
};
export function mailboxAddress(value: string) {
  const match = /(?:<\s*)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,})(?:\s*>)?/i.exec(value);
  return match?.[1]?.toLowerCase() ?? "";
}
export function gmailBody(part: GmailPart | undefined): string {
  const texts: { mime: string; text: string }[] = [];
  function walk(node: GmailPart | undefined, depth: number) {
    if (!node || depth > 15 || texts.length >= 50) return;
    if (node.body?.data && ["text/plain", "text/html"].includes(node.mimeType ?? "")) {
      texts.push({ mime: node.mimeType!, text: Buffer.from(node.body.data.slice(0, 150000), "base64url").toString("utf8") });
    }
    for (const child of node.parts ?? []) walk(child, depth + 1);
  }
  walk(part, 0);
  const plain = texts.filter((text) => text.mime === "text/plain").map((text) => text.text).join("\n");
  const html = texts.filter((text) => text.mime === "text/html").map((text) => text.text).join("\n");
  return (plain || html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")).slice(0, 50000);
}
export function messageRecord(message: GmailMessage) {
  const header = (name: string) => message.payload?.headers?.find((item) => item.name.toLowerCase() === name)?.value ?? "";
  const milliseconds = Number(message.internalDate);
  return {
    gmail_message_id: message.id, thread_id: message.threadId ?? null,
    from_email: mailboxAddress(header("from")), to_email: header("to").slice(0, 2000),
    subject: header("subject").slice(0, 1000), body: gmailBody(message.payload) || (message.snippet ?? "").slice(0, 50000),
    received_at: Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : null,
    in_inbox: message.labelIds?.includes("INBOX") ?? false, is_deleted: false,
  };
}

export type GmailSyncState = {
  mode: "bootstrap" | "history";
  baseline?: string;
  pageToken?: string;
  queue?: string[];
  nextPageToken?: string;
  pendingHistoryId?: string;
};
type HistoryPage = { historyId: string; nextPageToken?: string; history?: { messages?: { id: string }[]; messagesAdded?: { message: { id: string } }[]; messagesDeleted?: { message: { id: string } }[]; labelsAdded?: { message: { id: string } }[]; labelsRemoved?: { message: { id: string } }[] }[] };
export function historyMessageIds(page: HistoryPage) {
  const ids = new Set<string>();
  for (const item of page.history ?? []) {
    for (const message of item.messages ?? []) ids.add(message.id);
    for (const collection of [item.messagesAdded, item.messagesDeleted, item.labelsAdded, item.labelsRemoved]) {
      for (const change of collection ?? []) ids.add(change.message.id);
    }
  }
  return [...ids];
}
export async function gmailSyncPage(accessToken: string, initial: GmailSyncState, historyId: string | null) {
  let state = { ...initial };
  if (!state.queue) {
    if (state.mode === "bootstrap") {
      if (!state.baseline) state.baseline = (await gmailRequest<{ historyId: string }>(accessToken, "profile")).historyId;
      const query = new URLSearchParams({ labelIds: "INBOX", maxResults: "50" });
      if (state.pageToken) query.set("pageToken", state.pageToken);
      const page = await gmailRequest<{ messages?: { id: string }[]; nextPageToken?: string }>(accessToken, `messages?${query}`);
      state = { ...state, queue: (page.messages ?? []).map((message) => message.id), nextPageToken: page.nextPageToken };
    } else {
      if (!historyId) throw new HttpError(409, "Missing Gmail history cursor. Reset synchronization.");
      const query = new URLSearchParams({ startHistoryId: historyId, maxResults: "25" });
      if (state.pageToken) query.set("pageToken", state.pageToken);
      const page = await gmailRequest<HistoryPage>(accessToken, `history?${query}`);
      state = { ...state, queue: historyMessageIds(page), nextPageToken: page.nextPageToken, pendingHistoryId: page.historyId };
    }
  }
  // A durable queue caps each request without dropping large Gmail history pages.
  const ids = state.queue!.slice(0, 25);
  async function fetchMessage(id: string) {
    try { return messageRecord(await gmailRequest<GmailMessage>(accessToken, `messages/${encodeURIComponent(id)}?format=full`)); }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) return { gmail_message_id: id, in_inbox: false, is_deleted: true };
      else throw error;
    }
  }
  const messages = [];
  for (let offset = 0; offset < ids.length; offset += 5)
    messages.push(...await Promise.all(ids.slice(offset, offset + 5).map(fetchMessage)));
  const remaining = state.queue!.slice(ids.length);
  let nextHistoryId = historyId;
  let more = true;
  if (remaining.length) state = { ...state, queue: remaining };
  else if (state.nextPageToken) state = { mode: state.mode, baseline: state.baseline, pageToken: state.nextPageToken, pendingHistoryId: state.pendingHistoryId };
  else {
    nextHistoryId = state.mode === "bootstrap" ? state.baseline! : state.pendingHistoryId!;
    state = { mode: "history" };
    more = false;
  }
  return { messages, state, historyId: nextHistoryId, more };
}
