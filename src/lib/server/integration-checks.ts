import { createHmac } from "node:crypto";
import { HttpError } from "@/lib/server/auth";
import type { IntegrationProvider } from "@/lib/integration-definitions";
import { smtpTransport } from "@/lib/server/smtp-transport";
import { requireIntegrationValue } from "@/lib/server/integration-settings";

async function checkedJson(url: string, init: RequestInit, message: string) {
  const response = await fetch(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new HttpError(502, `${message} (HTTP ${response.status}). Check credentials, provider permissions and account activation.`);
  return response.json() as Promise<Record<string, unknown>>;
}
export async function checkIntegration(provider: IntegrationProvider, config: Record<string, string>, recipient?: string) {
  const value = (key: string) => requireIntegrationValue(config, key);
  if (provider === "zoom") {
    const credentials = Buffer.from(`${value("ZOOM_CLIENT_ID")}:${value("ZOOM_CLIENT_SECRET")}`).toString("base64");
    const token = await checkedJson(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(value("ZOOM_ACCOUNT_ID"))}`, { method: "POST", headers: { Authorization: `Basic ${credentials}` } }, "Zoom authentication failed");
    if (typeof token.access_token !== "string") throw new HttpError(502, "Zoom returned no access token.");
    await checkedJson(`https://api.zoom.us/v2/users/${encodeURIComponent(config.ZOOM_HOST_USER || "me")}`, { headers: { Authorization: `Bearer ${token.access_token}` } }, "Zoom host lookup failed");
    return "Zoom authenticated and the configured host is accessible. Meeting creation permissions and webhook delivery still need an end-to-end test.";
  }
  if (provider === "razorpay") {
    await checkedJson("https://api.razorpay.com/v1/payment_links?count=1", { headers: { Authorization: `Basic ${Buffer.from(`${value("RAZORPAY_KEY_ID")}:${value("RAZORPAY_KEY_SECRET")}`).toString("base64")}` } }, "Razorpay Payment Links API check failed");
    return "Razorpay authenticated and Payment Links are readable. No link was created or payment collected. Verify signed webhook delivery separately.";
  }
  if (provider === "smtp") {
    const transport = await smtpTransport(config);
    try {
      await transport.verify();
      if (recipient) {
        const result = await transport.sendMail({ from: value("SMTP_FROM"), to: recipient, subject: "CRM SMTP connection test", text: "Your CRM SMTP configuration was accepted by the mail server. This test does not guarantee future delivery." });
        if (result.rejected?.length) throw new HttpError(502, "SMTP rejected the test recipient.");
        return "SMTP authenticated and accepted the test email. Check the recipient inbox and spam folder; acceptance does not guarantee delivery.";
      }
      return "SMTP connection and authentication passed. Sender acceptance and inbox delivery are checked only when sending a test email.";
    } finally { transport.close(); }
  }
  if (provider === "gmail") {
    for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]) value(key);
    return "OAuth settings are complete (local check only). Google has not authenticated these credentials. Use Connect Gmail below to verify the client, redirect registration, user consent and Gmail API access.";
  }
  if (provider === "facebook") {
    const url = new URL(`https://graph.facebook.com/${value("FACEBOOK_GRAPH_VERSION")}/${value("FACEBOOK_APP_ID")}`);
    url.searchParams.set("fields", "id,name");
    const result = await checkedJson(url.toString(), { headers: { Authorization: `Bearer ${value("FACEBOOK_APP_ID")}|${value("FACEBOOK_APP_SECRET")}` } }, "Meta app authentication failed");
    if (result.id !== value("FACEBOOK_APP_ID")) throw new HttpError(502, "Meta returned a different app ID.");
    return "Meta app authentication passed. Add each Page token below and check forms and subscriptions. App authentication alone does not prove lead retrieval access.";
  }
  const signature = createHmac("sha256", value("LEAD_INTAKE_SIGNING_KEY")).update("crm-intake-configuration-check").digest("hex");
  if (signature.length !== 64) throw new HttpError(500, "Signing key verification failed.");
  return "Local HMAC signing check passed. No external website was contacted and no lead was created. Connect a source and send a signed test submission from its backend.";
}
