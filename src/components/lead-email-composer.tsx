"use client";

import { useEffect, useRef, useState } from "react";
import { Mail, Send, Trash2 } from "lucide-react";
import { apiRequest, getApiReadSnapshot, getPreparedApiRead } from "@/lib/crm-data";
import type { Lead } from "@/lib/types";
import { createLeadEmailDraft, leadEmailTemplates, type LeadEmailInvoice, type LeadEmailTemplateId } from "@/lib/lead-email-templates";
import { EmailSignaturePreview } from "@/components/email-signature-preview";

type EmailContext = { sender: { name: string; phone: string; signatureHtml: string }; invoices: LeadEmailInvoice[]; canViewInvoices: boolean };
type Mailbox = { email: string; managed?: boolean; reason?: string } | null;
export function LeadEmailComposer({ lead, login, mailbox, subject, content, onSubject, onContent, busy, onSend, onConnect }: {
  lead: Lead; login: string; mailbox: Mailbox; subject: string; content: string;
  onSubject: (value: string) => void; onContent: (value: string) => void; busy: boolean;
  onSend: (includeSignature: boolean) => Promise<void>; onConnect: () => void;
}) {
  const [context, setContext] = useState<EmailContext | null>(() => getPreparedApiRead<EmailContext>(`/api/leads/${lead.id}/email-context`) ?? getApiReadSnapshot<EmailContext>(`/api/leads/${lead.id}/email-context`) ?? null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [includeSignature, setIncludeSignature] = useState(true);
  const [invoiceId, setInvoiceId] = useState("");
  const sending = useRef(false);
  const ready = Boolean(mailbox && mailbox.email.toLowerCase() === login.toLowerCase());
  useEffect(() => {
    let active = true;
    setError(""); setInvoiceId("");
    void apiRequest<EmailContext>(`/api/leads/${lead.id}/email-context`, { usePrefetched: true, maxAgeMs: 30000, forceFresh: attempt > 0 }).then(result => {
      if (active) setContext(result);
    }).catch(failure => { if (active) { setContext(null); setError(failure instanceof Error ? failure.message : "Could not load email signature and invoice details."); } });
    return () => { active = false; };
  }, [lead.id, attempt]);
  function applyTemplate(id: LeadEmailTemplateId) {
    if (!context) return;
    try {
      const draft = createLeadEmailDraft(id, { doctor: lead.name, course: lead.course, sender: context.sender.name,
        phone: context.sender.phone, invoice: context.invoices.find(invoice => invoice.id === invoiceId) });
      if (draft.subject.length > 200) throw new Error("The generated subject exceeds 200 characters. Shorten the lead's course or write a shorter subject manually.");
      if ((subject.trim() || content.trim()) && !window.confirm("Replace the current subject and message with this template?")) return;
      onSubject(draft.subject); onContent(draft.body); setError("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not apply this template."); }
  }
  return <section className="gmail-compose" aria-label="Compose email">
    <header className="gmail-compose-header"><span><Mail size={17} />New message</span><span>{mailbox?.managed ? "Workspace" : "Gmail"}</span></header>
    <div className="gmail-compose-status"><span className={`lead-mailbox-state${ready ? " is-connected" : ""}`}>{mailbox?.managed ? ready ? "Workspace-managed" : "Managed mailbox unavailable" : ready ? "Gmail connected" : "Mailbox not connected"}</span>
      {!mailbox?.managed && <button type="button" className="button button-quiet" disabled={busy} onClick={onConnect}>{ready ? "Reconnect Gmail" : "Connect Gmail"}</button>}
    </div>
    <form onSubmit={async event => {
      event.preventDefault();
      if (sending.current || busy || !context) return;
      sending.current = true;
      try { await onSend(includeSignature); } finally { sending.current = false; }
    }}>
      <div className="gmail-address-row"><span>From</span><span>{login}</span></div>
      <div className="gmail-address-row"><span>To</span><span>{lead.email || "No lead email address"}</span></div>
      <div className="gmail-template-picker"><div><strong>Templates</strong><small>Choose a shared template, then edit freely</small></div>
        <div className="gmail-template-options">{leadEmailTemplates.map(template => <button key={template.id} type="button" title={template.description} disabled={busy || !context} onClick={() => applyTemplate(template.id)}>{template.name}</button>)}</div>
        {context?.canViewInvoices && <label className="gmail-invoice-picker">Invoice for reminder<select value={invoiceId} onChange={event => setInvoiceId(event.target.value)} disabled={busy}><option value="">Select an unpaid invoice</option>{context.invoices.map(invoice => <option key={invoice.id} value={invoice.id}>{invoice.invoiceNo} - {invoice.currency} {invoice.amount.toLocaleString("en-IN")} - due {invoice.dueDate}</option>)}</select></label>}
        {context && !context.canViewInvoices && <small>Invoice viewing permission is required to populate an invoice reminder.</small>}
        {context?.canViewInvoices && !context.invoices.length && <small>No sent, unpaid invoices are available for this lead.</small>}
      </div>
      {error && <div className="gmail-compose-error" role="alert">{error}{!context && <button type="button" className="button button-quiet" disabled={busy} onClick={() => setAttempt(value => value + 1)}>Retry loading email details</button>}</div>}
      <label className="gmail-subject"><span>Subject</span><input aria-label="Email subject" value={subject} maxLength={200} required placeholder="Subject" disabled={busy} onChange={event => onSubject(event.target.value)} /></label>
      <div className="gmail-message-body"><label className="sr-only" htmlFor={`email-message-${lead.id}`}>Message</label><textarea id={`email-message-${lead.id}`} required maxLength={20000} rows={13} value={content} disabled={busy} placeholder="Write your message, or choose a template above..." onChange={event => onContent(event.target.value)} />
        {includeSignature && context?.sender.signatureHtml && <div className="gmail-compose-signature"><EmailSignaturePreview html={context.sender.signatureHtml} /></div>}
      </div>
      {context?.sender.signatureHtml ? <label className="gmail-signature-option"><input type="checkbox" checked={includeSignature} disabled={busy} onChange={event => setIncludeSignature(event.target.checked)} />Include my saved signature</label> : context && <p className="gmail-compose-hint">No signature saved. A Super Admin can add one in Users &amp; hierarchy.</p>}
      {!context && !error && <p role="status" className="gmail-compose-hint">Loading your signature and invoice details...</p>}
      {(!lead.email || !ready) && <p className="lead-compose-warning" role="alert">{!lead.email ? "Add an email address to the lead before sending." : mailbox?.reason || (mailbox?.email ? `The connected account (${mailbox.email}) does not match your login. Connect Gmail using ${login}.` : `Connect Gmail using ${login} before sending.`)}</p>}
      <p className="gmail-compose-hint">{mailbox?.managed ? ready ? "Your own Workspace mailbox is used automatically; no individual Google connection is required. Google authorization is checked when sending." : mailbox.reason : ready ? "Your Google Workspace mailbox is connected. Emails are sent from your CRM login address." : "CRM sign-in alone does not grant mailbox access."} No shared SMTP sender is used.</p>
      <footer className="gmail-compose-footer"><button className="gmail-send-button" disabled={busy || !context || !ready || !lead.email || !subject.trim() || !content.trim()}><Send size={16} />{busy ? "Sending..." : "Send"}</button>
        <span>{content.length.toLocaleString()} / 20,000</span><button type="button" className="gmail-discard-button" title="Discard draft" aria-label="Discard draft" disabled={busy || (!subject && !content)} onClick={() => { if (window.confirm("Discard this email draft?")) { onSubject(""); onContent(""); setError(""); } }}><Trash2 size={18} /></button>
      </footer>
    </form>
  </section>;
}
