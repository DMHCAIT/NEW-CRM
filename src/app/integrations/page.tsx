"use client";

import { useEffect, useRef, useState } from "react";
import { Globe, Link2, Mail, Plus, RefreshCw } from "lucide-react";
import { IntegrationConnections } from "@/components/integration-connections";
import { FacebookPageConnections } from "@/components/facebook-page-connections";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { Configuration, OperationFeedback, formValues, operationRequest, useOperationalData } from "./operational-ui";

type Integration = Configuration & { name: string; detail: string; endpoint?: string; webhook?: Configuration };
type Source = { id: string; name: string; is_active: boolean; allowed_origins: string[]; intake_source_settings: { channel: string; owner_id: string; stage_id: string | null; facebook_page_id: string | null; facebook_form_id?: string | null } | null };
type SourceData = { sources: Source[]; owners: { id: string; full_name: string }[]; stages: { id: string; name: string }[]; canManage: boolean };
type Mail = { id: string; gmail_message_id: string; lead_id: string | null; from_email: string; subject: string; body: string; received_at: string | null };
type GmailData = { connection: { email: string; last_synced_at: string | null; last_error: string | null; initialSync: boolean; hasPendingPage: boolean; syncInProgress: boolean } | null; messages: Mail[]; canManage: boolean; canConnect: boolean };

export default function IntegrationsPage() {
  const state = useOperationalData<{ integrations: Integration[]; unsupported: string[]; note: string }>("/api/integrations");
  const sources = useOperationalData<SourceData>("/api/integrations/sources");
  const gmail = useOperationalData<GmailData>("/api/integrations/gmail");
  const [sourceForm, setSourceForm] = useState(false);
  const [channel, setChannel] = useState("website");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [newStageId, setNewStageId] = useState("");
  const [editOwnerId, setEditOwnerId] = useState("");
  const [editStageId, setEditStageId] = useState("");
  const [newKey, setNewKey] = useState<{ id: string; apiKey: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [mail, setMail] = useState<Mail | null>(null);
  const [editingSource, setEditingSource] = useState<Source | null>(null);
  const [sourceError, setSourceError] = useState("");
  const sourceFeedback = useRef<HTMLDivElement>(null);
  const defaultStageId = sources.data?.stages.find((stage) => stage.name.toLocaleLowerCase() === "fresh")?.id ?? sources.data?.stages[0]?.id ?? "";
  useEffect(() => {
    if (!newStageId && defaultStageId) setNewStageId(defaultStageId);
  }, [defaultStageId, newStageId]);
  useEffect(() => {
    if (!newKey && !sourceError) return;
    sourceFeedback.current?.focus({ preventScroll: true });
    sourceFeedback.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [newKey, sourceError]);
  async function connectGmail() {
    setBusy(true); setLocalError("");
    try {
      const response = await operationRequest<{ url: string }>("/api/integrations/gmail/connect", "POST");
      window.location.assign(response.url);
    } catch (error) { setLocalError(error instanceof Error ? error.message : "Connection failed."); setBusy(false); }
  }
  return <div className="integrations-page">
    <div className="page-heading integration-page-heading"><span className="integration-page-icon"><Link2 size={25} /></span><div><span className="integration-category">SETUP / CONNECTED APPS</span><h1>Integrations</h1><p>Connect your tools. Bring every enquiry, conversation and payment into CRM.</p></div><button className="button button-secondary" onClick={() => { void state.refresh(); void sources.refresh(); void gmail.refresh(); }} disabled={state.loading}><RefreshCw size={14} />Refresh</button></div>
    <nav className="integration-workspace-nav" aria-label="Integration workspace"><a href="#integration-apps">Apps &amp; setup guides</a>{sources.data?.canManage && <a href="#integration-facebook-pages">Facebook Pages</a>}<a href="#integration-sources">Lead source routing</a><a href="#integration-mailbox">My mailbox</a></nav>
    <OperationFeedback {...state} error={localError || state.error} />
    <div id="integration-apps">{state.data && <IntegrationConnections integrations={state.data.integrations} onChange={() => void state.refresh()} />}</div>
    {sources.data?.canManage && <FacebookPageConnections canManage={sources.data.canManage} />}
    <section className="panel integration-workspace" id="integration-sources">
      <div className="panel-heading"><div><span className="integration-category">ROUTE NEW ENQUIRIES</span><h2>Websites, chatbots &amp; Facebook forms</h2><p>Choose who receives each source&apos;s enquiries and where new leads start.</p></div>{sources.data?.canManage && !sourceForm && <button className="button button-primary" disabled={Boolean(newKey)} onClick={() => { setSourceError(""); setSourceForm(true); setNewOwnerId(""); setNewStageId(defaultStageId); }}><Plus size={14} />Create source</button>}</div>
      <OperationFeedback {...sources} />
      {sources.data && !sources.data.canManage && <p className="integration-empty">Only an Admin or Super Admin with integration-management access can manage source routing. Ask your administrator to connect a source.</p>}
      <div ref={sourceFeedback} tabIndex={-1} className="integration-source-feedback">
        {sourceError && <div className="helper-banner" role="alert"><strong>Source creation needs attention</strong><p>{sourceError}</p></div>}
        {newKey && <section className="integration-source-receipt" role="status" aria-label="Created source credentials"><h3>Source created successfully</h3><p>{newKey.apiKey ? "Save these credentials on your website backend before leaving this page. The API key is shown only once." : "Facebook route saved. Facebook delivery uses the connected Page token; no website API key is needed."}</p><label>Source ID<input readOnly value={newKey.id} onFocus={event => event.currentTarget.select()} /></label>{newKey.apiKey && <label>One-time API key<input readOnly value={newKey.apiKey} autoComplete="off" spellCheck={false} onFocus={event => event.currentTarget.select()} /></label>}<p>Do not put the API key or signing key into browser JavaScript.</p><button type="button" className="button button-secondary" onClick={() => { if (!newKey.apiKey || confirm("Have you saved the Source ID and API key securely? The original API key cannot be retrieved after dismissal.")) setNewKey(null); }}>I saved it — dismiss</button></section>}
      </div>
      {sourceForm && sources.data?.canManage && <form className="operational-form integration-source-form" aria-label="Create lead source" onInvalidCapture={event => {
        const name = (event.target as HTMLInputElement).name;
        setSourceError(name === "owner_id" ? "Select an active counselor in Assign new leads to." : name === "stage_id" ? "Select an initial stage." : "Complete all required fields and check their format before creating the source.");
      }} onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true); setSourceError("");
        try {
          const values = formValues(event.currentTarget);
          const result = await operationRequest<{ id: string; apiKey: string | null }>("/api/integrations/sources", "POST", {
            name: values.name, channel, owner_id: values.owner_id, stage_id: values.stage_id,
            allowed_origins: String(values.allowed_origins ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
            ...(channel === "facebook" ? { facebook_page_id: values.facebook_page_id, ...(values.facebook_form_id ? { facebook_form_id: values.facebook_form_id } : {}) } : {}),
          });
          if (!result.id || (channel !== "facebook" && !result.apiKey)) throw new Error("The server did not return source credentials. Check the source register before retrying; a source may have been created.");
          setNewKey(result); setSourceForm(false); await sources.refresh();
        } catch (error) { setSourceError(error instanceof Error ? error.message : "Source creation failed."); }
        finally { setBusy(false); }
      }}>
        <div className="integration-source-intro"><h3>Create a lead source</h3><p>{channel === "facebook" ? "Connect a Page token first, then route a specific form or all other forms from that Page." : "After creation, give the Source ID and one-time API key to your website developer. A source does not connect the website automatically."}</p></div>
        <label><span>Source name <span className="integration-required">*</span></span><input className="form-input" name="name" required maxLength={100} placeholder="e.g. DMHCA - Contact form" /><span className="integration-field-help">Use a name that identifies the website and form.</span></label>
        <label>Enquiry channel<select className="form-input" value={channel} onChange={(event) => setChannel(event.target.value)}><option value="website">Website form</option><option value="chatbot">Website chatbot</option><option value="facebook">Facebook Lead Ads</option></select><span className="integration-field-help">Use a separate source for contact forms and chatbot enquiries.</span></label>
        <div className="form-field"><label htmlFor="new-source-owner">Assign new leads to <span className="integration-required">*</span></label><SearchableDropdown id="new-source-owner" ariaLabel="Assign new leads to" placeholder="Select active owner" name="owner_id" required value={newOwnerId} onChange={setNewOwnerId} options={sources.data.owners.map((owner) => ({ value: owner.id, label: owner.full_name }))} /><span className="integration-field-help">New leads enter this counselor&apos;s bucket.</span></div>
        <div className="form-field"><label htmlFor="new-source-stage">Initial stage <span className="integration-required">*</span></label><SearchableDropdown id="new-source-stage" ariaLabel="Initial stage" placeholder="Choose stage" name="stage_id" required value={newStageId} onChange={setNewStageId} options={sources.data.stages.map((stage) => ({ value: stage.id, label: stage.name }))} /><span className="integration-field-help">Applied to newly created leads, not existing matches.</span></div>
        {channel === "facebook" ? <><label>Facebook Page ID<input className="form-input" name="facebook_page_id" required pattern="\d{1,40}" maxLength={40} /><span className="integration-field-help">Numeric ID of a connected Page, not your Meta App ID.</span></label><label>Facebook Form ID (optional)<input className="form-input" name="facebook_form_id" pattern="\d{1,40}" maxLength={40} placeholder="Blank = fallback for other forms on this Page" /><span className="integration-field-help">Find form IDs using Check forms &amp; subscription above.</span></label><p className="integration-routing-note">An exact Page + Form source takes priority. One Page-wide fallback is allowed per Page. Connect that Page&apos;s access token above.</p></> : <details className="integration-source-advanced"><summary>Advanced: restrict Origin headers (optional)</summary><label>Allowed Origin headers (one origin per line)<textarea className="form-input" name="allowed_origins" placeholder="https://example.com" /></label><p>Leave blank unless your website backend sends an Origin header you want to restrict. This is not the website connection URL and does not enable browser submissions.</p></details>}
        <div className="integration-form-footer"><span>New leads follow this routing. Existing matches keep their owner.</span><div><button type="button" className="button button-secondary" disabled={busy} onClick={() => { setSourceForm(false); setSourceError(""); }}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? "Creating..." : "Create source"}</button></div></div>
      </form>}
      {sources.data?.canManage && !sources.loading && !sources.error && !sources.data.sources.length && !sourceForm && <div className="integration-blank-state"><span className="integration-blank-icon"><Globe size={21} /></span><div><h3>No lead sources yet</h3><p>Create a source for each contact form, chatbot or Facebook form. Select a counselor and initial stage to get started.</p></div></div>}
      {!!sources.data?.sources.length && <div className="table-wrap"><table className="data-table"><thead><tr><th>Source</th><th>Channel / Page / Form</th><th>Owner</th><th>Source ID</th><th>Status</th><th>Actions</th></tr></thead><tbody>{sources.data.sources.map((source) => <tr key={source.id}><td>{source.name}</td><td>{source.intake_source_settings?.channel ?? "Legacy — not configured"}<span className="table-sub">{source.intake_source_settings?.facebook_page_id}{source.intake_source_settings?.channel === "facebook" && <> / {source.intake_source_settings.facebook_form_id || "Other forms (fallback)"}</>}</span></td><td>{sources.data?.owners.find((owner) => owner.id === source.intake_source_settings?.owner_id)?.full_name ?? "Unavailable"}</td><td><code>{source.id}</code></td><td>{source.is_active ? "Enabled" : "Disabled"}</td><td><div className="heading-actions">{source.intake_source_settings && <button className="button button-secondary button-small" onClick={() => { setEditingSource(source); setEditOwnerId(source.intake_source_settings?.owner_id ?? ""); setEditStageId(source.intake_source_settings?.stage_id ?? defaultStageId); }}>Edit assignment</button>}<button className="button button-secondary button-small" disabled={sources.busy} onClick={() => void sources.mutate("/api/integrations/sources", "PATCH", { id: source.id, is_active: !source.is_active })}>{source.is_active ? "Disable" : "Enable"}</button></div></td></tr>)}</tbody></table></div>}
      {editingSource && sources.data && <form key={editingSource.id} className="operational-form" onSubmit={async (event) => {
        event.preventDefault();
        const input = formValues(event.currentTarget);
        if (await sources.mutate("/api/integrations/sources", "PATCH", { id: editingSource.id, ...input })) setEditingSource(null);
      }}><h3>New-lead assignment for {editingSource.name}</h3>
        <div className="form-field"><label htmlFor="edit-source-owner">Owner</label><SearchableDropdown id="edit-source-owner" ariaLabel="Owner" placeholder="Select an active owner" name="owner_id" required value={editOwnerId} onChange={setEditOwnerId} options={sources.data.owners.map((owner) => ({ value: owner.id, label: owner.full_name }))} /></div>
        <div className="form-field"><label htmlFor="edit-source-stage">Initial stage</label><SearchableDropdown id="edit-source-stage" ariaLabel="Initial stage" placeholder="Choose stage" name="stage_id" required value={editStageId} onChange={setEditStageId} options={sources.data.stages.map((stage) => ({ value: stage.id, label: stage.name }))} /></div>
        <button className="button button-primary" disabled={sources.busy}>Save assignment</button><button type="button" className="button button-secondary" onClick={() => setEditingSource(null)}>Cancel</button>
      </form>}
      <details><summary>Backend intake request contract</summary><p>Send JSON to <code>POST /api/webhooks/lead-intake</code>. Headers: <code>Authorization: Bearer SOURCE_API_KEY</code>, <code>x-crm-source: SOURCE_UUID</code>, <code>x-crm-timestamp: UNIX_SECONDS</code>, <code>x-crm-signature: v1=HEX_HMAC_SHA256</code>. Sign the exact string <code>TIMESTAMP.RAW_JSON_BODY</code> using the server-only <code>LEAD_INTAKE_SIGNING_KEY</code>. Signatures expire after five minutes. Do not expose either key in frontend code. There is intentionally no browser CORS endpoint.</p><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify({ event_id: "your-durable-submission-id", lead: { name: "Full name", phone: "+919876543210", email: "person@example.com", course: "Course enquiry", message: "Please explain course eligibility." }, transcript: [{ role: "user", content: "Chatbot enquiry (optional)" }] }, null, 2)}</pre><p>A non-blank lead.message (up to 10,000 characters) automatically becomes a source-labeled note on the new or matched lead. Blank messages create no note. Reusing event_id does not duplicate notes.</p><p>Limit: 60 authenticated submissions per source per minute, 512 KB body. Reuse event_id on retries. Existing-lead matches follow CRM duplicateFields across all records, including hidden and archived leads. block/warn policies attach an inbound event without overwriting details; allow creates another lead. Chatbot transcripts are stored only for chatbot sources. All unknown fields, including assignee and stage, are rejected.</p></details>
    </section>
    <section className="panel integration-mailbox" id="integration-mailbox">
      <div className="panel-heading"><div><span className="integration-category">PERSONAL EMAIL</span><h2><Mail size={17} />Your Gmail mailbox</h2><p>Connect your CRM login mailbox. Your lead emails are sent as you, never from shared SMTP. Read and send consent is required.</p></div>{gmail.data?.canConnect && <button className="button button-primary" disabled={busy || gmail.busy} onClick={() => void connectGmail()}>{gmail.data.connection ? "Reconnect Gmail" : "Connect Gmail"}</button>}</div>
      <OperationFeedback {...gmail} />
      {gmail.data?.connection ? <><p>Connected mailbox: <strong>{gmail.data.connection.email}</strong> · Last sync: {gmail.data.connection.last_synced_at ? new Date(gmail.data.connection.last_synced_at).toLocaleString() : "Never"}</p>
        {gmail.data.connection.last_error && <p role="alert">{gmail.data.connection.last_error}</p>}
        <p>{gmail.data.connection.initialSync ? "Initial inbox import; continue syncing until all pages complete." : gmail.data.connection.hasPendingPage ? "Additional message changes remain." : "History cursor ready. Run sync to fetch new changes."}</p>
        <div className="heading-actions">{gmail.data.canManage && <><button className="button button-primary" disabled={gmail.busy || busy} onClick={() => void gmail.mutate("/api/integrations/gmail/sync", "POST")}>{gmail.data.connection.hasPendingPage || gmail.data.connection.initialSync ? "Continue sync" : "Sync inbox"}</button><button className="button button-secondary" disabled={gmail.busy} onClick={() => { if (confirm("Reset the stored history cursor and re-import your inbox?")) void gmail.mutate("/api/integrations/gmail/sync", "DELETE"); }}>Reset expired history</button></>}{gmail.data.canConnect && <button className="button button-secondary" disabled={gmail.busy} onClick={() => { if (confirm("Delete local Gmail tokens and inbox copy? Linked CRM email history is retained.")) void gmail.mutate("/api/integrations/gmail", "DELETE"); }}>Disconnect locally</button>}</div>
      </> : gmail.data && !gmail.loading && !gmail.error && <div className="integration-blank-state"><span className="integration-blank-icon"><Mail size={21} /></span><div><h3>Your mailbox is not connected</h3><p>Ask your administrator to complete Google OAuth setup, then connect with your CRM login email. Lead emails will be sent from your own mailbox.</p><a href="#integration-apps">View Gmail setup guide</a></div></div>}
      {!!gmail.data?.messages.length && <div className="table-wrap"><table className="data-table"><thead><tr><th>Received</th><th>From</th><th>Subject</th><th>CRM lead</th><th /></tr></thead><tbody>{gmail.data.messages.map((message) => <tr key={message.id}><td>{message.received_at ? new Date(message.received_at).toLocaleString() : "—"}</td><td>{message.from_email}</td><td>{message.subject || "(no subject)"}</td><td>{message.lead_id ? <a href={`/leads/${message.lead_id}`}>Open accessible lead</a> : "No accessible sender match"}</td><td><button className="button button-secondary button-small" onClick={() => setMail(message)}>Read</button></td></tr>)}</tbody></table></div>}
      {gmail.data?.connection && !gmail.loading && !gmail.error && !gmail.data.messages.length && <div className="integration-blank-state"><span className="integration-blank-icon"><Mail size={21} /></span><div><h3>No inbox messages stored yet</h3><p>{gmail.data.canManage ? "Use Sync inbox or Continue sync to import messages from your connected mailbox." : "Ask an integration administrator to sync the mailbox. Lead email sending is available from the lead workspace."}</p></div></div>}
      {mail && <article style={{ marginTop: 20 }}><button className="button button-secondary" onClick={() => setMail(null)}>Close message</button><h3>{mail.subject}</h3><p>From: {mail.from_email}</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{mail.body}</pre></article>}
      <details className="integration-section-help"><summary>About inbox sync &amp; privacy</summary><p>Latest 50 stored inbox messages. Sender matching uses only leads currently visible to your verified CRM user. Matching emails are also logged to the lead when you have leads.edit permission. Removed Gmail messages leave CRM email history intact. Disconnect locally deletes tokens; revoke the app in Google to revoke the remote grant.</p></details>
    </section>
  </div>;
}
