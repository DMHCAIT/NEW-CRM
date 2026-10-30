"use client";

import { useState } from "react";
import { CheckCircle2, Facebook, Plus } from "lucide-react";
import { formValues, OperationFeedback, operationRequest, useOperationalData } from "@/app/integrations/operational-ui";

type Page = { page_id: string; page_name: string; is_active: boolean; tokenConfigured: boolean; updated_at: string };
type Check = { page: { id: string; name?: string }; forms: { id: string; name?: string; status?: string }[]; formsTruncated: boolean; subscriptionVerified: boolean; message: string };

export function FacebookPageConnections({ canManage }: { canManage: boolean }) {
  const state = useOperationalData<{ pages: Page[] }>("/api/integrations/facebook-pages");
  const [editing, setEditing] = useState<string | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function request(method: string, input: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await operationRequest<Check & { message?: string }>("/api/integrations/facebook-pages", method, input);
      if (input.action === "test") setCheck(result);
      else { setEditing(null); setCheck(null); setMessage(result.message || "Page connection saved. Configure form routing below and run a Page check."); }
      await state.refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Facebook Page operation failed."); }
    finally { setBusy(false); }
  }
  if (!canManage) return null;
  return <section className="panel integration-facebook-pages" id="integration-facebook-pages">
    <div className="panel-heading"><div><span className="integration-category">FACEBOOK CONNECTIONS</span><h2><Facebook size={18} />Pages &amp; forms</h2><p>Connect each Page with its own access token. Then map form IDs to lead sources below.</p></div><button className="button button-primary" disabled={busy} onClick={() => setEditing(editing === "" ? null : "")}><Plus size={14} />Add Page</button></div>
    <OperationFeedback {...state} error={error || state.error} message={message} />
    {editing !== null && <form key={editing} className="operational-form integration-page-form" onSubmit={event => { event.preventDefault(); const values = formValues(event.currentTarget); void request(editing ? "PATCH" : "POST", { ...values, ...(editing ? { page_id: editing } : {}) }); }}>
      <label>Page ID<input className="form-input" name="page_id" required pattern="\d{1,40}" maxLength={40} defaultValue={editing} readOnly={Boolean(editing)} /><span className="integration-field-help">Numeric Facebook Page ID, not your Meta App ID or Form ID.</span></label>
      <label>Page access token<input className="form-input" name="access_token" type="password" autoComplete="new-password" required maxLength={8192} placeholder="Write-only; never shown after saving" /><span className="integration-field-help">Use a token authorized for this Page with approved lead access. Not your Meta App secret.</span></label>
      <div className="integration-config-actions"><button className="button button-primary" disabled={busy}>Verify identity &amp; save Page</button><button className="button button-secondary" type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>
    </form>}
    {!state.loading && !state.error && state.data && !state.data.pages.length && editing === null && <div className="integration-blank-state"><span className="integration-blank-icon"><Facebook size={21} /></span><div><h3>No Facebook Pages connected</h3><p>Save your Meta app settings, then use Add Page to connect a Page and route its form enquiries.</p><a href="#integration-apps">View app setup guides</a></div></div>}
    {!!state.data?.pages.length && <div className="table-wrap"><table className="data-table"><thead><tr><th>Page</th><th>Credentials</th><th>Status</th><th>Actions</th></tr></thead><tbody>{state.data.pages.map(page => <tr key={page.page_id}><td><strong>{page.page_name || "Facebook Page"}</strong><span className="table-sub">{page.page_id}</span></td><td>{page.tokenConfigured ? "Token saved securely" : "Token required"}</td><td>{page.is_active ? "Enabled" : "Paused"}</td><td><div className="heading-actions">
      <button className="button button-secondary" disabled={busy || !page.is_active} onClick={() => { setCheck(null); void request("PATCH", { page_id: page.page_id, action: "test" }); }}>Check forms &amp; subscription</button>
      <button className="button button-secondary" disabled={busy} onClick={() => setEditing(page.page_id)}>Replace token</button>
      <button className="button button-secondary" disabled={busy} onClick={() => void request("PATCH", { page_id: page.page_id, is_active: !page.is_active })}>{page.is_active ? "Pause" : "Enable"}</button>
      <button className="button button-quiet" disabled={busy} onClick={() => { if (confirm("Remove this Page connection? Leads stop arriving unless legacy server Page credentials exist. Existing leads remain.")) void request("DELETE", { page_id: page.page_id }); }}>Remove</button>
    </div></td></tr>)}</tbody></table></div>}
    {check && <div className="integration-page-check"><h3><CheckCircle2 size={17} />{check.page.name || check.page.id}</h3><p>{check.message}</p><p>{check.subscriptionVerified ? "This Meta app is subscribed to leadgen events." : "Subscription not verified. Subscribe this Meta app to this Page's leadgen events in Meta."}</p>
      {check.forms.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Form name</th><th>Form ID to use in a lead source</th><th>Status</th></tr></thead><tbody>{check.forms.map(form => <tr key={form.id}><td>{form.name || "Lead form"}</td><td><code>{form.id}</code></td><td>{form.status}</td></tr>)}</tbody></table></div> : <p>No forms were returned for this Page. Check the Page&apos;s forms and token permissions in Meta.</p>}
      {check.formsTruncated && <p>Only the first page of forms is displayed. Additional forms can be connected by their exact ID.</p>}
      <p>Lead retrieval permissions and delivery must still be verified using Meta&apos;s Lead Ads Testing Tool. This check does not create a CRM lead.</p>
    </div>}
  </section>;
}
