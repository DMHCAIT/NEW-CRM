import type { IntegrationProvider } from "@/lib/integration-definitions";

type GuideStep = { title: string; detail: string };
type IntegrationGuide = {
  needs: string[];
  steps: GuideStep[];
  verify: string;
  problems: GuideStep[];
  docs: { label: string; url: string };
  next?: { label: string; href: string };
};

export const integrationGuides: Record<IntegrationProvider, IntegrationGuide> = {
  intake: {
    needs: ["Access to your website or chatbot backend", "A public HTTPS CRM address", "One source ID and API key for each form or chatbot"],
    steps: [
      { title: "Prepare a backend signing key", detail: "Generate a random secret of at least 32 characters (the developer handoff includes a generation command). Save it in Connection settings and in your website server's secret storage. This is not an SMTP password. Never put it in a public form, chatbot widget or browser bundle." },
      { title: "Create your lead sources in CRM", detail: "Use Manage lead sources below. Create a Website form source for contact forms and a Website chatbot source for chat enquiries. Choose an active counselor and initial stage. Save each Source ID and the API key shown once after creation." },
      { title: "Connect your form or chatbot server", detail: "When a visitor submits contact details, your backend validates the submission and sends the signed JSON request shown in the developer handoff below. WordPress needs a server-side form hook/plugin; a frontend-only website needs a serverless function. A form action or public widget alone cannot hold these credentials safely." },
      { title: "Map fields and deliver reliably", detail: "Send name and phone, plus email, country, course and qualification when available. Map the contact form's Message to lead.message (up to 10,000 characters): CRM automatically adds a source-labeled note on the new or matched lead. Blank messages create no note. For chatbot sources, send the transcript when contact details are collected. Persist a unique event_id for each enquiry. Retry transient failures with that same ID and a fresh timestamp/signature; do not generate a new ID for retries." },
    ],
    verify: "Submit one real contact form and one chatbot enquiry. Check the API response, assigned counselor, initial stage and chatbot transcript in CRM. The setup check only validates local signing; it does not connect your website automatically.",
    problems: [
      { title: "No lead appears", detail: "Check the website backend delivery log, reachable CRM URL, enabled source and active counselor. Existing matches may attach to an existing lead under your duplicate policy instead of creating a new one." },
      { title: "Signature or authentication rejected", detail: "Use the source API key, not the signing key, as the Bearer token. Sign the exact JSON bytes sent. Check both server clocks; signatures have a five-minute window." },
      { title: "Allowed origins", detail: "Optional Origin restrictions apply to supplied request headers; they do not replace authentication or enable browser CORS. If configured, the backend request must use an allowed Origin. Leave blank if not using this restriction." },
    ],
    docs: { label: "HMAC signing reference (Node.js)", url: "https://nodejs.org/api/crypto.html#cryptocreatehmacalgorithm-key-options" },
    next: { label: "Manage lead sources", href: "#integration-sources" },
  },
  facebook: {
    needs: ["A Meta developer app and business/Page access", "A Page access token for every Page", "Approved lead access and a public HTTPS webhook"],
    steps: [
      { title: "Prepare your Meta app", detail: "Use your business's Meta developer app. Copy its App ID and App secret, and choose a Graph API version supported by that app. Complete the permissions/app review required for leads_retrieval and Page access. A token must be authorized for the Page and its leads." },
      { title: "Save app settings and register the webhook", detail: "Enter the app details here and choose your own private webhook verification token. In Meta's Page webhook configuration, paste the endpoint below and the identical verification token. Enable leadgen events. Saving in CRM does not create the Meta subscription." },
      { title: "Connect each Facebook Page", detail: "Use Meta's access-token tools for your app to generate a Page access token as a person/system user authorized for that Page, with the approved lead and Page permissions. Copy the Page's numeric ID (not the App ID). Open Pages & forms below and add that ID/token. CRM verifies identity before saving. Check forms & subscription to discover Form IDs and confirm this app's leadgen subscription. Renew expired/revoked tokens." },
      { title: "Route forms to counselors", detail: "Create a Facebook Lead Ads source for each Page + Form ID and select its counselor/stage. Leave Form ID blank only for a Page-wide fallback. One fallback is allowed per Page. Exact form routes take precedence, even when disabled. Forms must collect name and phone." },
    ],
    verify: "Use Meta's Lead Ads Testing Tool to submit a test lead for each routed form. Confirm webhook delivery and the assigned CRM lead. App and Page checks do not prove lead retrieval permission or end-to-end delivery.",
    problems: [
      { title: "Webhook verification fails", detail: "Confirm the public HTTPS endpoint and exact verify token match. Localhost is not reachable by Meta. Save the app configuration before Meta attempts verification." },
      { title: "Forms are visible but leads do not arrive", detail: "Check the app's Page leadgen subscription, reviewed lead access, Page token validity and exact Page/Form route. Check whether an existing lead matched instead of creating another." },
    ],
    docs: { label: "Meta Lead Ads documentation", url: "https://developers.facebook.com/docs/marketing-api/guides/lead-ads/" },
    next: { label: "Connect Pages & forms", href: "#integration-facebook-pages" },
  },
  gmail: {
    needs: ["A Google Cloud project with Gmail API enabled", "A Web application OAuth client", "Each user's consent using their CRM login mailbox"],
    steps: [
      { title: "Prepare Google Cloud", detail: "Enable Gmail API and configure your OAuth audience/consent screen. Add test users while testing, or complete Google's verification requirements for your production audience. Workspace administrators may also need to allow this app." },
      { title: "Create the OAuth client", detail: "Create a Web application OAuth client. Copy its client ID and secret into Connection settings. Register the exact Authorized callback URL shown below, including scheme, hostname, port (locally) and path." },
      { title: "Authorize your personal mailbox", detail: "After saving, open Your Gmail mailbox below and choose Connect Gmail. Sign in to Google with the same email used to log in to CRM and approve read/send access. Each counselor connects separately; an administrator's consent does not connect everyone." },
    ],
    verify: "The setup check is local only. Connect Gmail, then send a test message from an accessible lead's Emails tab and verify the From address and Sent folder. CRM login alone does not grant Google consent.",
    problems: [
      { title: "redirect_uri_mismatch or access blocked", detail: "Copy the callback exactly into the Google Web client. Check the OAuth audience/test users, Gmail API, Google verification and Workspace app restrictions." },
      { title: "Wrong mailbox or sending scope missing", detail: "Reconnect using your exact CRM login email and grant both read and send scopes. Changing the shared OAuth client requires existing users to reconnect. SMTP is never a fallback for lead email." },
    ],
    docs: { label: "Google Gmail OAuth documentation", url: "https://developers.google.com/workspace/gmail/api/auth/about-auth" },
    next: { label: "Connect your Gmail mailbox", href: "#integration-mailbox" },
  },
  smtp: {
    needs: ["A public SMTP hostname and provider credentials", "An authorized sender address", "TLS on port 465, or STARTTLS on 587/2525"],
    steps: [
      { title: "Get SMTP details from your mail provider", detail: "Copy the server hostname, port and username from the provider. Use an app password or provider SMTP credential where required, not your CRM login password. If app passwords are unavailable, check the provider's account/security policy." },
      { title: "Choose a verified sender and encryption", detail: "Use an address your provider allows you to send from. Choose implicit TLS for port 465, or STARTTLS for port 587/2525. Private network or loopback SMTP servers are not supported. Configure SPF, DKIM and DMARC with your email provider." },
      { title: "Save and test before signing out", detail: "Run Test saved connection, then send a test email to your own CRM login address. Check inbox and spam. These settings send login verification codes and invoice emails: incorrect credentials can prevent future sign-ins. Keep administrator recovery access available." },
    ],
    verify: "Authentication success does not prove sender acceptance. A test email accepted by SMTP does not guarantee inbox delivery. Verify receipt before depending on these settings. Lead emails still use each user's Gmail.",
    problems: [
      { title: "Authentication or TLS fails", detail: "Check the provider username/app password, SMTP access policy, matching port/encryption and server certificate. Never disable TLS validation to bypass an error." },
      { title: "Accepted but not received", detail: "Check spam, provider delivery logs, verified sender and domain DNS records. CRM cannot guarantee delivery after the provider accepts a message." },
    ],
    docs: { label: "Google app password guidance", url: "https://support.google.com/accounts/answer/185833" },
  },
  zoom: {
    needs: ["Zoom account administrator access", "An activated Server-to-Server OAuth app", "An authorized Zoom host and public webhook"],
    steps: [
      { title: "Create and activate your Zoom app", detail: "Create a Server-to-Server OAuth app in Zoom Marketplace. Grant the meeting creation and user read permissions required by your account. Copy Account ID, Client ID and Client secret into Connection settings." },
      { title: "Choose the meeting host", detail: "Enter an authorized Zoom user's email or ID as the default host, or use me where supported by your account. Only enable Use CRM host email when CRM meeting hosts have matching authorized Zoom accounts." },
      { title: "Configure event notifications", detail: "In the Zoom app, register the public HTTPS endpoint below and enable meeting.started and meeting.ended events. Copy the event subscription Secret Token here. Activate the app after updating permissions and subscriptions." },
    ],
    verify: "Test saved connection authenticates and reads the configured host. Then create a Zoom-hosted CRM meeting, open its join URL and check start/end updates. The check itself does not create a meeting or prove webhook delivery.",
    problems: [
      { title: "Host or meeting access denied", detail: "Check app activation, account membership, granted scopes and the selected host's license/permissions. A readable host does not prove meeting creation permission." },
      { title: "Meeting status does not update", detail: "Check Zoom webhook delivery, public endpoint availability, event subscriptions and the exact webhook secret token." },
    ],
    docs: { label: "Zoom Server-to-Server OAuth guide", url: "https://developers.zoom.us/docs/internal-apps/s2s-oauth/" },
  },
  razorpay: {
    needs: ["A Razorpay account with Payment Links enabled", "Key ID and secret from the same mode", "A separate webhook signing secret"],
    steps: [
      { title: "Prepare your payment account", detail: "Enable Payment Links for the Razorpay account. Generate an API key pair and keep test/live mode consistent. The CRM creates a fixed-amount link for each eligible invoice." },
      { title: "Register signed payment events", detail: "Register the public HTTPS endpoint below in Razorpay webhooks for payment_link.paid. Choose a separate webhook signing secret and save that exact secret here; it is not the API key secret." },
      { title: "Save credentials and check access", detail: "Save the key pair and webhook secret, then run Test saved connection. The check only reads the Payment Links API; it does not create a link, collect money or prove webhook delivery." },
    ],
    verify: "Use an authorized test invoice: issue it, confirm a short Payment Link and secure CRM status URL are emailed, then verify a signed payment_link.paid event updates status and sends a receipt. Never make an unintended live payment just to check setup.",
    problems: [
      { title: "Payment Links API access denied", detail: "Check account activation, Payment Links access and the matching key pair/mode with Razorpay. Saving a key does not enable a product on your account." },
      { title: "Payment received but invoice unchanged", detail: "Check the signed payment_link.paid event, webhook secret, mode, endpoint delivery and invoice/link reference before retrying an operation." },
    ],
    docs: { label: "Razorpay Payment Links documentation", url: "https://razorpay.com/docs/payments/payment-links/" },
  },
};

export const integrationFieldHelp: Record<string, string> = {
  ZOOM_ACCOUNT_ID: "From the Zoom Server-to-Server OAuth app credentials.",
  ZOOM_CLIENT_ID: "Client ID of the activated Server-to-Server app.",
  ZOOM_CLIENT_SECRET: "Client secret from the same Zoom app.",
  ZOOM_WEBHOOK_SECRET_TOKEN: "Secret Token from Zoom event subscriptions, not the OAuth secret.",
  ZOOM_HOST_USER: "Authorized Zoom user ID/email; blank uses me.",
  ZOOM_USE_CRM_HOST_EMAIL: "Use the CRM meeting host's email instead of the default Zoom host.",
  RAZORPAY_KEY_ID: "API Key ID from the required Razorpay test/live mode.",
  RAZORPAY_KEY_SECRET: "Secret belonging to the same Key ID.",
  RAZORPAY_WEBHOOK_SECRET: "The separate secret you chose when registering the webhook.",
  SMTP_HOST: "Hostname only, for example smtp.gmail.com. Do not enter a URL or IP.",
  SMTP_PORT: "Choose the port supported by your mail provider.",
  SMTP_USER: "Usually your full email address; confirm with your provider.",
  SMTP_PASSWORD: "Provider SMTP/app password. Not your CRM login password.",
  SMTP_FROM: "An authorized address, optionally Name <email@example.com>.",
  SMTP_SECURE: "Match the encryption mode to the selected port.",
  GOOGLE_CLIENT_ID: "From a Google Cloud Web application OAuth client.",
  GOOGLE_CLIENT_SECRET: "Client secret from that same Google OAuth client.",
  GOOGLE_REDIRECT_URI: "Register this exact URL in the Google client's authorized redirect URIs.",
  LEAD_INTAKE_SIGNING_KEY: "At least 32 random characters. Share only with your trusted website backend.",
  FACEBOOK_APP_ID: "Numeric ID from your Meta developer app.",
  FACEBOOK_APP_SECRET: "App secret from the same Meta app; not a Page access token.",
  FACEBOOK_WEBHOOK_VERIFY_TOKEN: "A private token you choose; enter the same value in Meta webhook setup.",
  FACEBOOK_GRAPH_VERSION: "A supported version selected for your app, for example v25.0.",
};
