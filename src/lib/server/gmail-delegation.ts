import { createHash, createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";

export const delegatedGmailScopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
export const oauthMailboxDomain = "dmhca.in";
export function oauthMailboxEligible(loginEmail: string) {
  return workspaceMailboxEligible({ GOOGLE_WORKSPACE_DOMAIN: oauthMailboxDomain }, loginEmail);
}
const tokenEndpoint = "https://oauth2.googleapis.com/token";
const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.string().email().endsWith(".iam.gserviceaccount.com"),
  client_id: z.string().regex(/^\d+$/),
  private_key: z.string().min(1),
});

export function workspaceManaged(config: Record<string, string>) {
  const mode = config.GOOGLE_MAILBOX_MODE || "oauth";
  if (!["oauth", "workspace"].includes(mode)) throw new HttpError(503, "Unknown Gmail authorization mode. Ask your administrator to check Integrations.");
  return mode === "workspace";
}

export function workspaceCredentials(config: Record<string, string>) {
  const domain = config.GOOGLE_WORKSPACE_DOMAIN ?? "";
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain) || domain.length > 253)
    throw new HttpError(400, "Enter a valid Google Workspace domain, for example dmhca.in.");
  let parsed: unknown;
  try { parsed = JSON.parse(config.GOOGLE_SERVICE_ACCOUNT_JSON ?? ""); }
  catch { throw new HttpError(400, "Enter the complete service account JSON key downloaded from Google Cloud."); }
  const account = serviceAccountSchema.safeParse(parsed);
  if (!account.success) throw new HttpError(400, "Service account JSON must include type, client_email, numeric client_id and private_key.");
  try {
    if (createPrivateKey(account.data.private_key).asymmetricKeyType !== "rsa") throw new Error("Not RSA");
  } catch { throw new HttpError(400, "The service account JSON must contain a valid RSA private key."); }
  return { domain: domain.toLowerCase(), account: account.data };
}

export function workspaceMailboxEligible(config: Record<string, string>, loginEmail: string) {
  const email = z.string().email().safeParse(loginEmail);
  return email.success && email.data.split("@")[1].toLowerCase() === config.GOOGLE_WORKSPACE_DOMAIN?.toLowerCase();
}

export function workspaceMailbox(config: Record<string, string>, loginEmail: string) {
  if (!workspaceMailboxEligible(config, loginEmail))
    throw new HttpError(403, "Managed Gmail is available only for CRM login mailboxes in the configured Workspace domain.");
  return loginEmail.toLowerCase();
}

export async function delegatedGmailToken(config: Record<string, string>, loginEmail: string) {
  const { account } = workspaceCredentials(config);
  const subject = workspaceMailbox(config, loginEmail);
  const key = createHash("sha256").update(JSON.stringify([account, subject, delegatedGmailScopes])).digest("hex");
  for (const [id, entry] of delegatedTokens) {
    if (entry.expiresAt <= Date.now()) delegatedTokens.delete(id);
  }
  const saved = delegatedTokens.get(key);
  if (saved) return (await saved.promise).accessToken;
  if (delegatedTokens.size >= 100) delegatedTokens.delete(delegatedTokens.keys().next().value!);
  const entry: DelegatedToken = { promise: requestDelegatedGmailToken(account, subject), expiresAt: Date.now() + 5 * 60_000 };
  delegatedTokens.set(key, entry);
  try {
    const result = await entry.promise;
    entry.expiresAt = Math.min(entry.expiresAt, result.expiresAt);
    entry.accessToken = result.accessToken;
    return result.accessToken;
  } catch (error) {
    if (delegatedTokens.get(key) === entry) delegatedTokens.delete(key);
    throw error;
  }
}

type DelegatedToken = {
  promise: Promise<{ accessToken: string; expiresAt: number }>;
  expiresAt: number;
  accessToken?: string;
};
const delegatedTokens = new Map<string, DelegatedToken>();

export function invalidateDelegatedGmailToken(accessToken: string) {
  for (const [key, entry] of delegatedTokens) {
    if (entry.accessToken === accessToken) delegatedTokens.delete(key);
  }
}

async function requestDelegatedGmailToken(account: ReturnType<typeof workspaceCredentials>["account"], subject: string) {
  const requestedAt = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: account.client_email, sub: subject, scope: delegatedGmailScopes.join(" "),
    aud: tokenEndpoint, iat: now, exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), account.private_key).toString("base64url")}`;
  const response = await fetch(tokenEndpoint, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new HttpError(502, "Workspace Gmail authorization failed. Check domain-wide delegation, both Gmail scopes, the service account key and whether this login has an enabled Gmail mailbox.");
  const result = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() }).safeParse(await response.json());
  if (!result.success) throw new HttpError(502, "Google returned an invalid Workspace access token response.");
  const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${result.data.access_token}` },
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!profileResponse.ok) throw new HttpError(502, "Workspace mailbox access failed. Check Gmail API enablement, delegation scopes and the user's Gmail license.");
  const profile = z.object({ emailAddress: z.string().email() }).safeParse(await profileResponse.json());
  if (!profile.success || profile.data.emailAddress.toLowerCase() !== subject)
    throw new HttpError(409, "Use your primary Google Workspace mailbox address as your CRM login; the delegated mailbox does not match.");
  return { accessToken: result.data.access_token, expiresAt: requestedAt + Math.max(0, result.data.expires_in - 60) * 1000 };
}
