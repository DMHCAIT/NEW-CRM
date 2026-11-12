"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, ChevronRight, ExternalLink, Globe, Mail, Phone, Plug, Search, ShieldCheck, Video, Wallet } from "lucide-react";
import { gmailRequiredFields, integrationDefinitions, type IntegrationDefinition, type IntegrationProvider } from "@/lib/integration-definitions";
import { integrationFieldHelp } from "@/lib/integration-guides";
import { IntegrationSetupGuide } from "@/components/integration-setup-guide";
import { OperationFeedback, formValues, operationRequest, useOperationalData } from "@/app/integrations/operational-ui";
import { TELECMI_CALL_MESSAGE } from "@/lib/telecmi";

export type IntegrationSummary = { id?: IntegrationProvider; name: string; configured: boolean; missing: string[]; required: string[] };
type Setting = { provider: IntegrationProvider; source: string; revision: string | null; values: Record<string, string>; saved: Record<string, boolean>; updatedAt: string | null; testedAt: string | null; testStatus: string | null; testMessage: string | null };
type SettingsData = { canManage: boolean; settings: Setting[]; appUrl: string };
const icons = { zoom: Video, razorpay: Wallet, stripe: Wallet, smtp: Mail, gmail: Mail, intake: Globe, facebook: Plug, telecmi: Phone };
const fieldOptions: Record<string, { value: string; label: string }[]> = {
  TELECMI_DEVICE_ROUTING_CONFIRMED: [{ value: "", label: "Not confirmed" }, { value: "false", label: "Not confirmed" }, { value: "true", label: "Confirmed with TeleCMI" }],
  GOOGLE_MAILBOX_MODE: [{ value: "", label: "Per-user OAuth (default)" }, { value: "oauth", label: "Per-user OAuth" }, { value: "workspace", label: "Workspace-managed (administrator delegation)" }],
  SMTP_PORT: [{ value: "", label: "Choose a port" }, { value: "587", label: "587 - STARTTLS" }, { value: "465", label: "465 - Implicit TLS" }, { value: "2525", label: "2525 - STARTTLS" }],
  SMTP_SECURE: [{ value: "", label: "Automatic (based on port)" }, { value: "true", label: "Implicit TLS (port 465)" }, { value: "false", label: "STARTTLS (port 587 / 2525)" }],
  ZOOM_USE_CRM_HOST_EMAIL: [{ value: "", label: "Use default Zoom host" }, { value: "false", label: "Use default Zoom host" }, { value: "true", label: "Use CRM meeting host email" }],
};

export function IntegrationConnections({ integrations, onChange }: { integrations: IntegrationSummary[]; onChange: () => void }) {
  const settings = useOperationalData<SettingsData>("/api/integrations/settings");
  const [selected, setSelected] = useState<IntegrationProvider | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const panel = useRef<HTMLElement>(null);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All integrations");
  const [gmailMode, setGmailMode] = useState("");
  function select(provider: IntegrationProvider | null) {
    if (provider === selected) return;
    if (busy || (dirty && !confirm("Discard unsaved integration settings?"))) return;
    setSelected(provider); setDirty(false); setError(""); setMessage("");
  }
  useEffect(() => {
    if (!selected) return;
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected]);
  const configured = integrations.filter(item => item.configured).length;
  async function action(definition: IntegrationDefinition, setting: Setting | undefined, operation: "save" | "test" | "test_email", form?: HTMLFormElement) {
    if (busy || !settings.data?.canManage) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const values = form ? formValues(form) : {};
      const result = await operationRequest<{ message: string }>("/api/integrations/settings", "POST", {
        provider: definition.id, action: operation, revision: setting?.revision ?? null,
        ...(operation === "save" ? { values } : {}),
      });
      setMessage(result.message);
      if (operation === "save") { form?.reset(); setDirty(false); }
      await settings.refresh(); onChange();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Integration setup failed."); await settings.refresh(); }
    finally { setBusy(false); }
  }
  const definition = integrationDefinitions.find(item => item.id === selected);
  const setting = settings.data?.settings.find(item => item.provider === selected);
  useEffect(() => { setGmailMode(setting?.values.GOOGLE_MAILBOX_MODE || (setting?.saved.GOOGLE_CLIENT_ID ? "oauth" : "workspace")); }, [selected, setting?.revision, setting?.values.GOOGLE_MAILBOX_MODE, setting?.saved.GOOGLE_CLIENT_ID]);
  const categories = ["All integrations", "Lead capture", "Email", "Meetings", "Payments", "Calling"];
  const visible = integrationDefinitions.filter(item => (!query.trim() || `${item.name} ${item.category} ${item.detail}`.toLowerCase().includes(query.trim().toLowerCase())) &&
    (category === "All integrations" || (category === "Email" ? ["smtp", "gmail"].includes(item.id) : item.category === category)));
  return <section className="integration-connections" aria-label="Integration connections">
    <div className="integration-health"><span><ShieldCheck size={17} />Credentials encrypted &amp; access controlled</span><span><strong>{configured}</strong> of {integrationDefinitions.length} configured</span><span>Configured does not mean delivery verified</span></div>
    <OperationFeedback {...settings} loading={false} error={error || settings.error} message={message} />
    {!definition && <div className="integration-catalog-tools"><nav aria-label="Filter integration categories">{categories.map(item => <button type="button" key={item} aria-pressed={category === item} onClick={() => setCategory(item)}>{item}</button>)}</nav><label className="integration-search"><Search size={16} /><input aria-label="Search integrations" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search integrations..." type="search" /></label></div>}
    {!definition && <div className="integration-grid">{visible.map(item => {
      const summary = integrations.find(row => row.id === item.id || row.name === item.name);
      const row = settings.data?.settings.find(value => value.provider === item.id);
      const Icon = icons[item.id];
      return <section className={`panel integration-card integration-provider-${item.id}`} key={item.id}>
        <div className="integration-card-head"><span className="integration-logo"><Icon size={22} /></span><div><span className="integration-category">{item.category}</span><h3>{item.name}</h3></div><span className={`integration-state${summary?.configured ? " is-ready" : ""}`}>{summary?.configured ? "Configured" : "Setup required"}</span></div>
        <p>{item.detail}</p>
        <div className="integration-card-foot"><span>{row?.testStatus === "passed" ? "Last check passed" : row?.testStatus === "failed" ? "Last check failed" : "Not connection-tested"}</span><button className="button button-secondary" disabled={settings.loading || busy} onClick={() => select(item.id)}>{settings.data?.canManage ? "Configure" : "Setup guide"}<ChevronRight size={14} /></button></div>
      </section>;
    })}</div>}
    {!definition && !visible.length && <p className="integration-empty" role="status">No integrations match your search. Try another name or category.</p>}
    {definition && <section ref={panel} tabIndex={-1} className="panel integration-configuration" aria-label={`${definition.name} configuration`}>
      <div className="integration-setup-heading"><button type="button" className="button button-quiet" aria-label="Close integration settings" disabled={busy} onClick={() => select(null)}><ArrowLeft size={15} />All integrations</button><span className="integration-category">GUIDED CONNECTION SETUP</span></div>
      <div className="panel-heading"><div><h2>{definition.name}</h2><p>{definition.detail}</p></div><span className="integration-state">{setting?.source === "crm" ? "Settings saved" : "Setup guide & credentials"}</span></div>
      <div className="integration-provider-switcher" aria-label="Choose integration">{integrationDefinitions.map(item => <button type="button" key={item.id} aria-pressed={item.id === selected} disabled={busy} onClick={() => select(item.id)}>{item.name}</button>)}</div>
      <div className="integration-configuration-body"><IntegrationSetupGuide provider={definition.id} appUrl={settings.data?.appUrl ?? ""} />
      <div className="integration-connection-settings"><div className="integration-settings-intro"><span className="integration-category">IN CRM</span><h3>Connection settings</h3><p>Enter values from your provider account. Required fields are marked with an asterisk.</p></div>
        {definition.id === "telecmi" && <p className="integration-network-note" role="status">{TELECMI_CALL_MESSAGE}</p>}
        {definition.endpoint && !(definition.id === "gmail" && gmailMode === "workspace") && <div className="integration-endpoint"><small>{definition.id === "gmail" ? "Authorized redirect URI" : "Webhook endpoint"}</small><code>{settings.data?.appUrl}{definition.endpoint}</code></div>}
        {definition.id === "gmail" && gmailMode === "workspace" && <p className="integration-network-note">A Workspace super administrator must approve domain-wide delegation for both Gmail scopes. This grants organization-wide mailbox authority to the service account. CRM limits use to each authenticated user&apos;s login address in the configured domain. Employees do not need to connect individually.</p>}
        <p className="integration-secret-help"><ShieldCheck size={14} />Secret fields are write-only. Leave them blank to keep the saved value. Changing credentials resets the previous test result.</p>
        {(definition.id === "intake" || definition.id === "facebook" || definition.id === "zoom" || definition.id === "razorpay") && <p className="integration-network-note">Provider delivery needs a public HTTPS CRM URL. Localhost is only reachable from your own machine.</p>}
      {settings.data?.canManage ? <div className="integration-credential-column"><form key={`${definition.id}-${setting?.revision ?? "env"}`} className="integration-credential-form" onChange={() => setDirty(true)} onSubmit={event => { event.preventDefault(); void action(definition, setting, "save", event.currentTarget); }}>
        <fieldset disabled={busy}><legend>Credentials <small>{setting?.source === "crm" ? "Stored encrypted in CRM" : "Using server environment until saved"}</small></legend>
          {definition.fields.map(field => {
            if (definition.id === "gmail" && field.key !== "GOOGLE_MAILBOX_MODE" && field.key !== "GOOGLE_SERVICE_ACCOUNT_JSON" && (gmailMode === "workspace" ? field.key !== "GOOGLE_WORKSPACE_DOMAIN" : field.key === "GOOGLE_WORKSPACE_DOMAIN")) return null;
            const required = field.key !== "GOOGLE_WORKSPACE_DOMAIN" && (field.required || (definition.id === "gmail" && gmailRequiredFields({ GOOGLE_MAILBOX_MODE: gmailMode }).includes(field.key)));
            const value = setting?.values[field.key] || (field.key === "GOOGLE_REDIRECT_URI" ? `${settings.data?.appUrl}/api/auth/gmail/callback` : "");
            return <label className="form-field" key={field.key}><span>{field.label}{required && <span className="integration-required"> *</span>}{field.secret && setting?.saved[field.key] && <small>Saved securely</small>}</span>
              {fieldOptions[field.key] ? <select name={field.key} {...(field.key === "GOOGLE_MAILBOX_MODE" ? { value: gmailMode, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setGmailMode(event.target.value || "oauth") } : { defaultValue: value })} required={required} aria-describedby={`help-${field.key}`}>{fieldOptions[field.key].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> :
                field.multiline ? <textarea name={field.key} autoComplete="off" spellCheck={false} aria-describedby={`help-${field.key}`} required={Boolean(required && !setting?.saved[field.key])} rows={5} maxLength={8192} onChange={field.key === "GOOGLE_SERVICE_ACCOUNT_JSON" ? event => { if (event.target.value.trim()) setGmailMode("workspace"); } : undefined} placeholder={setting?.saved[field.key] ? "Leave blank to keep saved secret" : "Paste the complete downloaded service account JSON key to enable Workspace automatically"} /> :
                <input name={field.key} type={field.secret ? "password" : field.key === "GOOGLE_REDIRECT_URI" ? "url" : "text"} autoComplete={field.secret ? "new-password" : "off"} aria-describedby={`help-${field.key}`} required={Boolean(required && !(field.secret && setting?.saved[field.key]))} defaultValue={field.secret ? "" : value} maxLength={8192} placeholder={field.secret && setting?.saved[field.key] ? "Leave blank to keep saved secret" : field.placeholder} />}
              <span className="integration-field-help" id={`help-${field.key}`}>{integrationFieldHelp[field.key]}{field.key === "GOOGLE_WORKSPACE_DOMAIN" && " Leave blank to use your CRM login's domain."}</span></label>;
          })}
        </fieldset><div className="integration-config-actions"><button className="button button-primary" disabled={busy}>{busy ? "Working..." : definition.id === "gmail" && gmailMode === "workspace" ? "Save & connect Workspace" : "Save credentials"}</button><button type="button" className="button button-secondary" disabled={busy || settings.loading || dirty} onClick={() => void action(definition, setting, "test")}>{definition.id === "gmail" || definition.id === "intake" || definition.id === "telecmi" ? "Check saved setup" : "Test saved connection"}</button></div>
        {dirty && <p className="field-help">Save your changes before testing the active configuration.</p>}
        {setting?.testedAt && <div className={`integration-test-result${setting.testStatus === "passed" ? " is-passed" : ""}`}><strong>{setting.testStatus === "passed" ? "Check passed" : "Check failed"}</strong><time>{new Date(setting.testedAt).toLocaleString()}</time><p>{setting.testMessage}</p></div>}
      </form>
        {definition.id === "smtp" && <SmtpTest revision={setting?.revision ?? null} disabled={busy || dirty} />}
      </div> : <p className="integration-readonly">Only an Admin or Super Admin with integration management access can update shared credentials. You can still connect your own Gmail mailbox below.</p>}
      </div></div>
    </section>}
    <div className="integration-next-steps"><CheckCircle2 size={16} /><span>After saving: test the connection, complete provider subscriptions, then verify a real workflow.</span><a href="#integration-sources">Manage lead sources<ExternalLink size={13} /></a></div>
  </section>;
}

function SmtpTest({ revision, disabled }: { revision: string | null; disabled: boolean }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [error, setError] = useState("");
  return <div className="integration-smtp-test"><p>To verify sender acceptance, send a test email to your own CRM login address.</p><label className="form-field">Your CRM login email<input type="email" autoComplete="email" disabled={disabled || busy} /></label><button type="button" className="button button-secondary" disabled={disabled || busy} onClick={async event => {
    const input = event.currentTarget.closest(".integration-smtp-test")?.querySelector<HTMLInputElement>("input");
    if (!input?.value) { setError("Enter your own CRM login email before sending a test."); input?.focus(); return; }
    if (!input.reportValidity()) return;
    setBusy(true); setError(""); setMessage("");
    try { const result = await operationRequest<{ message: string }>("/api/integrations/settings", "POST", { provider: "smtp", action: "test_email", revision, recipient: input.value }); setMessage(result.message); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "SMTP test failed."); }
    finally { setBusy(false); }
  }}>Send test email</button>{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}</div>;
}
