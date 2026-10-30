import { z } from "zod";
import { integrationDefinitions, type IntegrationProvider } from "@/lib/integration-definitions";
import { getSupabaseAdminClient } from "@/lib/supabase/server";
import { ConfigurationError, requireEnv } from "@/lib/server/env";
import { decryptSession, encryptSession, encryptionKey } from "@/lib/server/login-crypto";
import { HttpError } from "@/lib/server/auth";
import type { CurrentUser } from "@/lib/types";

export function assertIntegrationAdmin(user: CurrentUser) {
  if (!["admin", "super_admin"].includes(user.profile.role) || !user.permissions.includes("integrations.manage"))
    throw new HttpError(403, "Only an Admin or Super Admin with integration management access can change organization credentials.");
}
export function encryptIntegrationValues(values: Record<string, string>) {
  return encryptSession(JSON.stringify(values), encryptionKey(requireEnv("AUTH_ENCRYPTION_KEY")));
}
export function decryptIntegrationValues(value: string): Record<string, string> {
  return z.record(z.string()).parse(JSON.parse(decryptSession(value, encryptionKey(requireEnv("AUTH_ENCRYPTION_KEY")))));
}
export async function integrationRecord(provider: IntegrationProvider) {
  const { data, error } = await getSupabaseAdminClient().from("integration_credentials").select("*").eq("provider", provider).maybeSingle();
  if (error) throw new ConfigurationError("Integration settings could not be loaded. Apply the integration credentials migration and check database access.");
  return data as { provider: IntegrationProvider; encrypted_values: string; revision: string; updated_at: string; tested_at: string | null; test_status: string | null; test_message: string | null } | null;
}
export async function getIntegrationConfig(provider: IntegrationProvider): Promise<Record<string, string>> {
  const definition = integrationDefinitions.find(item => item.id === provider)!;
  const row = await integrationRecord(provider);
  if (row) return decryptIntegrationValues(row.encrypted_values);
  const keys = [...definition.fields.map(field => field.key), ...(provider === "facebook" ? ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"] : [])];
  return Object.fromEntries(keys.map(key => [key, process.env[key] ?? ""]));
}
export function requireIntegrationValue(values: Record<string, string>, key: string) {
  if (!values[key]?.trim()) throw new ConfigurationError(`${key} is not configured. Open Integrations in CRM to complete setup.`);
  return values[key];
}
export async function integrationStatus(provider: IntegrationProvider, required?: string[]) {
  const config = await getIntegrationConfig(provider);
  const fields = required ?? integrationDefinitions.find(item => item.id === provider)!.fields.filter(field => field.required).map(field => field.key);
  const missing = fields.filter(key => !config[key]?.trim());
  return { configured: !missing.length, required: fields, missing };
}
export function validateIntegrationConfig(provider: IntegrationProvider, values: Record<string, string>) {
  const definition = integrationDefinitions.find(item => item.id === provider)!;
  for (const field of definition.fields) {
    const value = values[field.key] ?? "";
    if (value.length > 8192 || /[\r\n\0]/.test(value)) throw new HttpError(400, `${field.label} contains invalid characters or is too long.`);
    if (field.required && !value.trim()) throw new HttpError(400, `${field.label} is required.`);
  }
  if (provider === "smtp") {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(values.SMTP_HOST) || values.SMTP_HOST.length > 253) throw new HttpError(400, "Use a public SMTP hostname, not an IP address or URL.");
    if (!["465", "587", "2525"].includes(values.SMTP_PORT)) throw new HttpError(400, "SMTP port must be 465, 587 or 2525.");
    const sender = /<([^<>]+)>$/.exec(values.SMTP_FROM)?.[1] ?? values.SMTP_FROM;
    if (!z.string().email().safeParse(sender).success) throw new HttpError(400, "Enter a valid SMTP sender email address.");
    if (values.SMTP_SECURE && !["true", "false"].includes(values.SMTP_SECURE)) throw new HttpError(400, "SMTP TLS mode must be true or false.");
    if (values.SMTP_PORT === "465" && values.SMTP_SECURE === "false") throw new HttpError(400, "Port 465 requires TLS mode true.");
  }
  if (provider === "zoom" && values.ZOOM_USE_CRM_HOST_EMAIL && !["true", "false"].includes(values.ZOOM_USE_CRM_HOST_EMAIL)) throw new HttpError(400, "Use CRM host email must be true or false.");
  if (provider === "gmail") {
    const expected = `${requireEnv("NEXT_PUBLIC_APP_URL").replace(/\/+$/, "")}/api/auth/gmail/callback`;
    if (values.GOOGLE_REDIRECT_URI !== expected) throw new HttpError(400, `The Google callback URL must exactly match ${expected}.`);
  }
  if (provider === "facebook") {
    if (!/^\d{1,40}$/.test(values.FACEBOOK_APP_ID)) throw new HttpError(400, "Enter a numeric Meta app ID.");
    if (!/^v\d+\.\d+$/.test(values.FACEBOOK_GRAPH_VERSION)) throw new HttpError(400, "Graph version must look like v25.0.");
  }
  if (provider === "intake" && values.LEAD_INTAKE_SIGNING_KEY.length < 32) throw new HttpError(400, "Use a signing key of at least 32 characters.");
  return values;
}
