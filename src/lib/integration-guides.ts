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
  telecmi: {
    needs: ["A TeleCMI India account with admin click-to-call API access and its app secret", "An individual TeleCMI agent ID for each CRM user", "TeleCMI-configured device routing and an approved outbound caller ID"],
    steps: [
      { title: "Confirm the account API", detail: "This integration uses the India admin click-to-call endpoint https://piopiy.telecmi.com/v1/adminConnect. Confirm your plan supports it. Other products and regions are not interchangeable. CRM sends destination digits with the lead's country calling code and no plus sign." },
      { title: "Save the app secret", detail: "Enter the account app secret used as the API token, not an agent password. App ID is optional reference information and is not sent by this endpoint. Secrets are encrypted and never returned to the browser. You may instead configure TELECMI_APP_SECRET in the server environment before saving CRM credentials." },
      { title: "Map each CRM user", detail: "Use TeleCMI agent mapping below. Assign each active CRM user their own TeleCMI agent ID, not their phone number or CRM user ID. One agent cannot be shared across CRM users." },
      { title: "Configure answering devices with TeleCMI", detail: "Log in to the correct agent account in the supported Windows/desktop or mobile app. TeleCMI controls agent availability, registered mobile fallback and which device rings. CRM does not inspect installed apps or automatically choose a device." },
    ],
    verify: "Check saved setup validates local configuration only; it does not authenticate or place a call. On a consented test lead, use Click to call and answer your mapped agent device. Confirm both ends connect. CRM records provider acceptance, rejection or an unknown outcome, not connected status or duration. Requests are limited to one per user per 60 seconds.",
    problems: [
      { title: "Call rejected or no agent mapping", detail: "Verify the app secret and the signed-in CRM user's exact agent ID in TeleCMI agents. Saved CRM credentials replace environment values. Check the lead's phone and country code, account balance and outbound permissions." },
      { title: "Desktop or mobile app does not ring", detail: "TeleCMI must confirm API compatibility with that app and configure the mapped agent's answering devices. Installing an app or sharing a login does not configure CRM mapping." },
    ],
    docs: { label: "TeleCMI India admin click-to-call documentation", url: "https://doc.telecmi.com/chub-india/docs/click-to-call-admin/" },
    next: { label: "Manage TeleCMI agent mapping", href: "#integration-telecmi" },
  },
  stripe: {
    needs: ["A Stripe account enabled for USD payments", "A test/live secret API key", "A matching webhook endpoint signing secret"],
    steps: [
      { title: "Get the secret key", detail: "Use your organization's Stripe account with USD payments enabled. Copy the secret API key from its developer settings. Start in test mode; never put the key in browser code." },
      { title: "Configure webhooks", detail: "In Workbench/Webhooks, add the public endpoint shown below for checkout.session.completed and checkout.session.async_payment_succeeded. Copy that endpoint's whsec_ signing secret, not a CLI forwarding secret." },
      { title: "Save and verify", detail: "Save both secrets here and test the connection. Create a USD test invoice, pay through Stripe Checkout and verify the CRM status link changes to Paid. Use matching test/live modes. INR invoices use Razorpay instead." },
    ],
    verify: "Only signed paid sessions matching the invoice ID, saved session ID, amount and USD currency can mark paid. A success-page redirect alone never marks paid.",
    problems: [
      { title: "Checkout expires or creation times out", detail: "Stripe Checkout sessions expire. Reconcile an expired or interrupted session before replacing an invoice; retained payment/email locks prevent accidental duplicate requests. Check provider status before retrying." },
      { title: "Paid in Stripe but pending in CRM", detail: "Inspect this endpoint's delivery attempts in Stripe. Confirm the endpoint signing secret and account mode match, then retry the signed event after fixing configuration. A browser redirect cannot confirm payment." },
    ],
    docs: { label: "Stripe Checkout webhooks", url: "https://docs.stripe.com/payments/checkout/fulfill-orders" },
  },
  intake: {
    needs: ["Access to your website or chatbot backend", "A public HTTPS CRM address", "One source ID and API key for each form or chatbot"],
    steps: [
      { title: "Prepare a backend signing key", detail: "Generate a random secret of at least 32 characters (the developer handoff includes a generation command). Save it in Connection settings and in your website server's secret storage. This is not an SMTP password. Never put it in a public form, chatbot widget or browser bundle." },
      { title: "Create your lead sources in CRM", detail: "Use Manage lead sources below. Create a Website form source for contact forms and a Website chatbot source for chat enquiries. Choose an active counselor and initial stage. Save each Source ID and the API key shown once after creation." },
      { title: "Connect your form or chatbot server", detail: "When a visitor submits contact details, your backend validates the submission and sends the signed JSON request shown in the developer handoff below. WordPress needs a server-side form hook/plugin; a frontend-only website needs a serverless function. A form action or public widget alone cannot hold these credentials safely." },
      { title: "Map fields and deliver reliably", detail: "Send name and phone, plus email, country, course, qualification and speciality when available. Map the contact form's Message to lead.message (up to 10,000 characters): CRM automatically adds a source-labeled note on the new or matched lead. Blank messages create no note. For chatbot sources, send the transcript when contact details are collected. Persist a unique event_id for each enquiry. Retry transient failures with that same ID and a fresh timestamp/signature; do not generate a new ID for retries." },
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
      { title: "Route all your Meta forms to counselors", detail: "For 10 or more forms, use one Meta app setup and one saved token per Page, not separate environment credentials per form. Page checks request up to 100 forms and mark truncated results. Create a Facebook Lead Ads source for each Page + Form ID, name it after the form, and select its counselor/stage. Repeat for every form, including forms on other Pages. Leave Form ID blank only for a Page-wide fallback. One fallback is allowed per Page. Exact form routes take precedence, even when disabled. Forms must collect name and phone." },
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
    needs: ["A Google Cloud project with Gmail API enabled", "Either a Web OAuth client or a domain-wide delegated service account", "Workspace super-admin approval for automatic organization access"],
    steps: [
      { title: "Prepare Google Cloud", detail: "Enable Gmail API. Choose managed Workspace access or per-user OAuth below. For OAuth, configure your audience/consent screen, add test users while testing, and complete Google's verification requirements for your production audience. Workspace administrators may also need to allow the app." },
      { title: "Automatic Workspace access (no employee consent)", detail: "For organization-managed mailboxes, create a service account with domain-wide delegation and download a JSON key. A Workspace super administrator must add its numeric client_id in Admin console > Security > Access and data control > API controls > Manage Domain Wide Delegation, authorizing https://www.googleapis.com/auth/gmail.readonly and https://www.googleapis.com/auth/gmail.send. No Google Cloud IAM Owner role is needed." },
      { title: "Save managed configuration", detail: "Choose Workspace-managed in Connection settings, enter your exact Workspace domain (for example dmhca.in), and paste the downloaded JSON key. Save and run Check saved setup while signed in with your primary organizational mailbox. This verifies delegation for your own mailbox without sending mail. Employees in that domain use their CRM login mailbox automatically; they do not click Connect Gmail. This grants the service account organization-wide mailbox authority: protect the key and restrict CRM access." },
      { title: "Per-user OAuth only: create a Web client", detail: "Create a Web application OAuth client. Copy its client ID and secret into Connection settings. Register the exact Authorized callback URL shown below, including scheme, hostname, port (locally) and path. Skip this step in Workspace-managed mode." },
      { title: "Per-user OAuth alternative", detail: "After adding the client ID and secret, open Your Gmail mailbox and choose Connect Gmail. Every @dmhca.in address is eligible, provided it matches the user's CRM login. No individual address allowlist is required in CRM. Approve read/send access; each counselor connects separately. Other domains and another user's mailbox are rejected. Managed mode instead uses the super-admin's domain-wide delegation." },
    ],
    verify: "Managed mode checks delegation against your own mailbox; OAuth mode checks settings locally and requires Connect Gmail. In either mode, send a test message from an accessible lead and verify From and Sent, then manually sync your inbox. Automatic authorization does not imply a background inbox import.",
    problems: [
      { title: "redirect_uri_mismatch or access blocked", detail: "Copy the callback exactly into the Google Web client. Check the OAuth audience/test users, Gmail API, Google verification and Workspace app restrictions." },
      { title: "Wrong mailbox or sending scope missing", detail: "Reconnect using your exact CRM login email and grant both read and send scopes. Changing the shared OAuth client requires existing users to reconnect. SMTP is never a fallback for lead email." },
      { title: "Managed authorization fails", detail: "Check the service account numeric client_id (not project ID), both exact delegation scopes, Gmail API enablement and the user's Gmail license. Use primary mailbox addresses, not aliases. Delegation changes can take up to 24 hours. An administrator can disable managed mode centrally; revoke the grant in Google Admin and delete the key to remove Google access." },
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
  TELECMI_PRODUCT: "Account product, region or plan as confirmed by TeleCMI. Leave blank if not yet known.",
  TELECMI_API_DOCS_URL: "Public HTTPS documentation supplied for your account. Stored for reference only; CRM does not fetch this URL.",
  TELECMI_APP_ID: "Optional account reference. The India adminConnect API authenticates with the app secret and agent ID, not this field.",
  TELECMI_APP_SECRET: "Required server-side account app secret, sent as the adminConnect token. Never enter an agent's app login password.",
  TELECMI_DEVICE_ROUTING_CONFIRMED: "Provider-side setup reference only. TeleCMI controls desktop/mobile ringing; this field does not verify connectivity.",
  STRIPE_SECRET_KEY: "Server-only sk_test_ or sk_live_ API key. Never a publishable key.",
  STRIPE_WEBHOOK_SECRET: "whsec_ signing secret for the deployed Stripe webhook endpoint.",
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
  GOOGLE_MAILBOX_MODE: "OAuth requires each user's consent. Workspace-managed requires one super-admin-approved domain-wide delegation.",
  GOOGLE_WORKSPACE_DOMAIN: "Only active CRM login mailboxes in this exact domain are eligible; aliases, subdomains and external domains are not automatically included.",
  GOOGLE_SERVICE_ACCOUNT_JSON: "Complete downloaded JSON key with client_email, client_id and private_key. Stored encrypted, never returned to the browser. Do not paste it in chat or commit it.",
  LEAD_INTAKE_SIGNING_KEY: "At least 32 random characters. Share only with your trusted website backend.",
  FACEBOOK_APP_ID: "Numeric ID from your Meta developer app.",
  FACEBOOK_APP_SECRET: "App secret from the same Meta app; not a Page access token.",
  FACEBOOK_WEBHOOK_VERIFY_TOKEN: "A private token you choose; enter the same value in Meta webhook setup.",
  FACEBOOK_GRAPH_VERSION: "A supported version selected for your app, for example v25.0.",
};
