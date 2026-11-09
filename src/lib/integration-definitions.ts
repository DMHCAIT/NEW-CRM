export type IntegrationProvider = "zoom" | "razorpay" | "stripe" | "smtp" | "gmail" | "intake" | "facebook";
export type IntegrationField = { key: string; label: string; secret?: boolean; required?: boolean; placeholder?: string; multiline?: boolean };
export type IntegrationDefinition = { id: IntegrationProvider; name: string; category: string; detail: string; fields: IntegrationField[]; endpoint?: string; help: string };

export const integrationDefinitions: IntegrationDefinition[] = [
  { id: "zoom", name: "Zoom", category: "Meetings", detail: "Create and manage real Zoom meetings from CRM.", endpoint: "/api/webhooks/zoom",
    fields: [
      { key: "ZOOM_ACCOUNT_ID", label: "Account ID", required: true }, { key: "ZOOM_CLIENT_ID", label: "Client ID", required: true },
      { key: "ZOOM_CLIENT_SECRET", label: "Client secret", required: true, secret: true }, { key: "ZOOM_WEBHOOK_SECRET_TOKEN", label: "Webhook secret token", required: true, secret: true },
      { key: "ZOOM_HOST_USER", label: "Default Zoom host", placeholder: "me or a licensed Zoom user's email" },
      { key: "ZOOM_USE_CRM_HOST_EMAIL", label: "Use CRM host email", placeholder: "true or false" },
    ], help: "Use a Server-to-Server OAuth app. Activate it with meeting and user read permissions. Register meeting.started and meeting.ended webhooks. The connection check reads the configured host; it does not create a meeting." },
  { id: "razorpay", name: "Razorpay", category: "Payments", detail: "Automatically create and reconcile invoice Payment Links.", endpoint: "/api/webhooks/razorpay",
    fields: [
      { key: "RAZORPAY_KEY_ID", label: "Key ID", required: true }, { key: "RAZORPAY_KEY_SECRET", label: "Key secret", required: true, secret: true },
      { key: "RAZORPAY_WEBHOOK_SECRET", label: "Webhook signing secret", required: true, secret: true },
    ], help: "Enable Razorpay Payment Links and register payment_link.paid at this webhook. The check reads the Payment Links API without creating a link or charging anyone. Live and test credentials are not interchangeable." },
  { id: "smtp", name: "SMTP", category: "Transactional email", detail: "Deliver login verification and finance invoice emails.", fields: [
    { key: "SMTP_HOST", label: "SMTP server", required: true, placeholder: "smtp.gmail.com" }, { key: "SMTP_PORT", label: "Port", required: true, placeholder: "587" },
    { key: "SMTP_USER", label: "Username", required: true }, { key: "SMTP_PASSWORD", label: "Password / app password", required: true, secret: true },
    { key: "SMTP_FROM", label: "Sender address", required: true, placeholder: "Finance <finance@example.com>" },
    { key: "SMTP_SECURE", label: "TLS mode", placeholder: "true for port 465; false for STARTTLS" },
  ], help: "Use a public SMTP hostname. TLS is required; private or loopback servers are not supported. Test the saved connection, then send a test email to check provider acceptance, not guaranteed inbox delivery. These settings also send login verification codes: incorrect credentials can prevent future sign-ins. Lead emails continue to use each user's Gmail." },
  { id: "gmail", name: "Gmail mailbox", category: "Personal email", detail: "Connect any @dmhca.in Google mailbox matching the signed-in user's CRM login.", endpoint: "/api/auth/gmail/callback",
    fields: [
      { key: "GOOGLE_MAILBOX_MODE", label: "Mailbox authorization mode" },
      { key: "GOOGLE_CLIENT_ID", label: "Google OAuth client ID" }, { key: "GOOGLE_CLIENT_SECRET", label: "Google OAuth client secret", secret: true },
      { key: "GOOGLE_REDIRECT_URI", label: "Authorized callback URL" },
      { key: "GOOGLE_WORKSPACE_DOMAIN", label: "Managed Workspace domain", placeholder: "dmhca.in" },
      { key: "GOOGLE_SERVICE_ACCOUNT_JSON", label: "Service account JSON key", secret: true, multiline: true },
    ], help: "Per-user OAuth accepts every @dmhca.in mailbox matching its user's CRM login; no individual address allowlist is needed. Add the Google client ID and secret before connecting and granting read/send consent. Alternatively, Workspace-managed access uses each active CRM user's exact login mailbox within the configured domain after super-administrator approval through domain-wide delegation. Never share service account keys with employees." },
  { id: "intake", name: "Website / chatbot", category: "Lead capture", detail: "Connect multiple websites and chatbots with independent source keys.", endpoint: "/api/webhooks/lead-intake",
    fields: [{ key: "LEAD_INTAKE_SIGNING_KEY", label: "Backend HMAC signing key", required: true, secret: true }],
    help: "Use a random signing key of at least 32 characters. Create one source for each website or chatbot below. Send signed requests from a trusted backend, never browser JavaScript. A local signature check does not prove your external website is wired correctly." },
  { id: "facebook", name: "Facebook Lead Ads", category: "Lead capture", detail: "Route leads from multiple Facebook Pages and forms into CRM.", endpoint: "/api/webhooks/facebook",
    fields: [
      { key: "FACEBOOK_APP_ID", label: "Meta app ID", required: true }, { key: "FACEBOOK_APP_SECRET", label: "Meta app secret", required: true, secret: true },
      { key: "FACEBOOK_WEBHOOK_VERIFY_TOKEN", label: "Webhook verification token", required: true, secret: true },
      { key: "FACEBOOK_GRAPH_VERSION", label: "Graph API version", required: true, placeholder: "v25.0" },
    ], help: "One Meta app can connect multiple Pages. Save each Page token separately, then create sources for individual forms or a Page-wide fallback. App review, leads_retrieval access and Page leadgen subscriptions must be configured in Meta." },
  { id: "stripe", name: "Stripe", category: "Payments", detail: "Collect USD invoice payments with Stripe Checkout.", endpoint: "/api/webhooks/stripe",
    fields: [
      { key: "STRIPE_SECRET_KEY", label: "Stripe secret API key", required: true, secret: true },
      { key: "STRIPE_WEBHOOK_SECRET", label: "Stripe endpoint signing secret", required: true, secret: true },
    ], help: "Use matching test/live credentials. Subscribe this endpoint to checkout.session.completed and checkout.session.async_payment_succeeded. Only signed, fully paid sessions with the exact invoice amount are recorded. No payment is collected by the connection check." },
];

export function gmailRequiredFields(values: Record<string, string>) {
  return values.GOOGLE_MAILBOX_MODE === "workspace"
    ? ["GOOGLE_WORKSPACE_DOMAIN", "GOOGLE_SERVICE_ACCOUNT_JSON"]
    : ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];
}
