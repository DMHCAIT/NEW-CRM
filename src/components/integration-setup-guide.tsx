import { ArrowRight, ExternalLink, ListChecks } from "lucide-react";
import type { IntegrationProvider } from "@/lib/integration-definitions";
import { integrationGuides } from "@/lib/integration-guides";

export function IntegrationSetupGuide({ provider, appUrl }: { provider: IntegrationProvider; appUrl: string }) {
  const guide = integrationGuides[provider];
  return <div className="integration-guide-content">
    <div className="integration-guide-intro"><span className="integration-category">SETUP PLAYBOOK</span><h3>Connect it, step by step</h3><p>Complete the steps in CRM and in your provider account. Saving credentials alone does not connect the whole workflow.</p></div>
    <div className="integration-requirements"><h4><ListChecks size={16} />What you will need</h4><ul>{guide.needs.map(need => <li key={need}>{need}</li>)}</ul></div>
    <ol className="integration-guide-steps">{guide.steps.map((step, index) => <li key={step.title}><span aria-hidden="true">{index + 1}</span><div><h4>{step.title}</h4><p>{step.detail}</p></div></li>)}</ol>
    {guide.next && <a className="integration-guide-link" href={guide.next.href}>{guide.next.label}<ArrowRight size={15} /></a>}
    <div className="integration-verification"><h4>Verify the complete workflow</h4><p>{guide.verify}</p></div>
    {provider === "intake" && <IntakeDeveloperHandoff appUrl={appUrl} />}
    <details className="integration-troubleshooting"><summary>Troubleshooting &amp; common questions</summary>{guide.problems.map(problem => <div key={problem.title}><h4>{problem.title}</h4><p>{problem.detail}</p></div>)}</details>
    <a className="integration-docs-link" href={guide.docs.url} target="_blank" rel="noreferrer">{guide.docs.label}<ExternalLink size={13} /></a>
  </div>;
}

export function IntakeDeveloperHandoff({ appUrl }: { appUrl: string }) {
  const example = `// Server-side Node.js example. Never run in the browser.
import { createHmac } from "node:crypto";

// Load these from your WEBSITE server's secret storage.
const { CRM_BASE_URL, CRM_SOURCE_ID, CRM_SOURCE_API_KEY,
  CRM_INTAKE_SIGNING_KEY } = process.env;
for (const key of ["CRM_BASE_URL", "CRM_SOURCE_ID",
  "CRM_SOURCE_API_KEY", "CRM_INTAKE_SIGNING_KEY"]) {
  if (!process.env[key]) throw new Error("Missing setting: " + key);
}

// Use the same persisted submission ID on every retry.
const body = JSON.stringify({
  event_id: submission.id,
  lead: {
    name: submission.name,
    phone: submission.phone,
    email: submission.email,
    message: submission.message || ""
  },
  // Chatbot sources may also send:
  // transcript: [{ role: "user", content: "Course enquiry" }]
});
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", CRM_INTAKE_SIGNING_KEY)
  .update(timestamp + "." + body).digest("hex");
const response = await fetch(
  CRM_BASE_URL + "/api/webhooks/lead-intake", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + CRM_SOURCE_API_KEY,
      "x-crm-source": CRM_SOURCE_ID,
      "x-crm-timestamp": timestamp,
      "x-crm-signature": "v1=" + signature
    },
    body
  }
);
if (!response.ok) {
  // Record the failure securely and retry transient errors
  // with the SAME event_id and a fresh timestamp/signature.
  throw new Error("CRM intake failed: HTTP " + response.status);
}`;
  return <details className="integration-developer-handoff"><summary>Developer handoff: connect your website or chatbot</summary>
    <p>Give this contract to your website developer. Adapt <code>submission</code> to the validated data in your existing form handler. Store the enquiry before delivery so retries keep the same ID. Add rate limiting and spam protection on your public form.</p>
    <p>Generate a signing key on a trusted machine, then store it securely on both servers. This command prints a new secret; do not paste the result into chat or source control.</p>
    <pre><code>{`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`}</code></pre>
    <dl><div><dt>Website server setting</dt><dd>Value to store privately</dd></div><div><dt>CRM_BASE_URL</dt><dd><code>{appUrl || "https://your-crm-domain"}</code></dd></div><div><dt>CRM_SOURCE_ID</dt><dd>Source ID from CRM after creating a website/chatbot source.</dd></div><div><dt>CRM_SOURCE_API_KEY</dt><dd>The API key displayed once for that source.</dd></div><div><dt>CRM_INTAKE_SIGNING_KEY</dt><dd>The same signing key saved in CRM Connection settings.</dd></div></dl>
    <pre><code>{example}</code></pre>
    <p><strong>Required:</strong> name and phone. <strong>Optional lead fields:</strong> email, country, course, qualification, message. A non-empty message (up to 10,000 characters) automatically creates a source-labeled note on the new or matched lead. Retrying the same event ID does not duplicate the note. Transcript roles: user, assistant, agent (chatbot sources only). Do not send assignee/stage; CRM applies your source routing.</p>
    <p>Limit: 512 KB and 60 authenticated submissions per source/minute. Signatures expire after five minutes. A successful retry is idempotent. Duplicate matching follows CRM policy and may attach the event to an existing lead without overwriting or reassigning it.</p>
  </details>;
}
