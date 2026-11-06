"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckCircle2, ChevronRight, Download, FileText, Mail, Plus, RefreshCw, Search, ShieldCheck, Wallet } from "lucide-react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { Configuration, LeadOption, OperationFeedback, useOperationalData } from "@/app/integrations/operational-ui";
import { formatDateTime } from "@/lib/crm-data";
import { InvoiceCreateForm, type InstallmentParent } from "@/components/invoice-create-form";
import { legacyCompany, type BillingCompany } from "@/lib/billing";

type Invoice = {
  id: string; invoice_no: string; lead_id: string; created_by: string; total: number; subtotal: number; tax_amount: number; discount_amount: number; discount_reason: string | null; notes: string | null; currency: string;
  status: string; created_at: string; due_date: string | null; approved_at: string | null; approved_by: string | null; sent_at: string | null; paid_at: string | null;
  payment_type: string; discount_percent: number; course_total: number | null; parent_invoice_id: string | null;
  razorpay_payment_link_id: string | null; razorpay_short_url: string | null; email_message_id: string | null; payment_link_lock_at: string | null; email_lock_at: string | null; payment_verified_by: string | null;
  external_payment_reference: string | null; external_payment_evidence: string | null; payment_verified_at: string | null;
  company_snapshot?: BillingCompany | null; billing_name?: string; billing_email?: string; billing_address?: string;
  stripe_checkout_url?: string | null;
  installment_number?: number | null;
  payment_expires_at?: string | null; stripe_expires_at?: string | null;
  tax_review_required?: boolean; pricing_review_note?: string | null;
  invoice_items: { description: string; quantity: number; unit_price: number; amount: number }[];
  invoice_approvals: { id: string; requested_by: string; decided_by: string | null; decision: string; comment: string | null; created_at: string; decided_at: string | null }[];
};
type Data = {
  invoices: Invoice[];
  courseBalances?: Record<string, number>;
  installmentParents?: InstallmentParent[];
  leads: LeadOption[];
  profiles: { id: string; full_name: string }[];
  userId: string;
  canCreate: boolean;
  canApprove: boolean;
  razorpay: Configuration;
  stripe: Configuration;
  smtp: Configuration;
};
const statusLabel = (status: string) => ({ pending_approval: "Pending approval", sent: "Awaiting payment", paid: "Paid", rejected: "Rejected", cancelled: "Cancelled", expired: "Expired" }[status] ?? status.replaceAll("_", " "));
const money = (value: number, currency = "INR") => new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(Number(value));
const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`)) : "On receipt";
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function InvoiceWorkspace({ leadId, timelineOnly = false }: { leadId?: string; timelineOnly?: boolean }) {
  const state = useOperationalData<Data>(leadId ? `/api/invoices?leadId=${encodeURIComponent(leadId)}` : "/api/invoices");
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  const { data, busy, refresh } = state;
  useEffect(() => {
    if (busy || showForm || !data?.invoices.some(invoice => invoice.status === "sent" || invoice.status === "pending_approval")) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15000);
    return () => window.clearInterval(timer);
  }, [busy, data, refresh, showForm]);
  useEffect(() => {
    if (selectedId) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [selectedId]);
  const records = data?.invoices ?? [];
  const invoices = records.filter(invoice => (!status || invoice.status === status) && `${invoice.invoice_no} ${invoice.billing_name ?? ""} ${data?.leads.find(lead => lead.id === invoice.lead_id)?.name ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const selected = records.find(invoice => invoice.id === selectedId);
  const selectedRoot = selected?.parent_invoice_id ? records.find(row => row.id === selected.parent_invoice_id) : selected;
  const selectedCourseTotal = Number(selectedRoot?.course_total ?? selectedRoot?.total ?? 0);
  const selectedBalance = selected ? data?.courseBalances?.[selected.id] ?? Math.max(0, round(selectedCourseTotal - records.filter(row => (row.id === selectedRoot?.id || row.parent_invoice_id === selectedRoot?.id) && row.status === "paid").reduce((sum, row) => sum + Number(row.total), 0))) : 0;
  const company = selected?.company_snapshot ?? legacyCompany;
  const person = (id: string | null) => data?.profiles?.find(profile => profile.id === id)?.full_name ?? "User name unavailable";
  const sum = (statuses: string[]) => {
    const totals = new Map<string, number>();
    for (const invoice of records.filter(row => statuses.includes(row.status))) totals.set(invoice.currency, (totals.get(invoice.currency) ?? 0) + Number(invoice.total));
    return totals.size ? [...totals].map(([currency, value]) => money(value, currency)).join(" / ") : money(0);
  };
  function approvalAction(invoice: Invoice) {
    if (!data?.canApprove || invoice.status !== "pending_approval" || invoice.tax_review_required) return null;
    return <button className="button button-primary" disabled={state.busy} aria-label={`Approve and send invoice ${invoice.invoice_no}`} onClick={() => {
      if (confirm(`Approve ${invoice.invoice_no} with ${invoice.discount_percent}% discount and total ${money(invoice.total, invoice.currency)}? The invoice and payment link will be emailed automatically.`))
        void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "approve" });
    }}><ShieldCheck size={14} />Approve &amp; send invoice</button>;
  }
  function invoiceActions(invoice: Invoice) {
    return <div className="invoice-record-actions">
      <a className="button button-secondary" href={`/api/invoices/${invoice.id}/pdf`}><Download size={14} />Download PDF</a>
      {invoice.status === "expired" && data?.canApprove && <button className="button button-secondary" disabled={state.busy} onClick={() => {
        if (confirm("Reconcile and cancel the expired payment links, then close this unpaid invoice? Received funds must be verified first."))
          void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "close_expired" });
      }}>Reconcile &amp; close expired invoice</button>}
      {invoice.tax_review_required && invoice.status !== "paid" && invoice.status !== "expired" && data?.canApprove && <button className="button button-primary" disabled={state.busy} onClick={() => {
        if (confirm("Cancel existing unpaid payment links and recalculate this agreement with INR 18% / USD 0% tax? Revised totals will require approval before delivery."))
          void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "review_tax" });
      }}>Review &amp; recalculate tax</button>}
      {invoice.status === "pending_approval" && !invoice.tax_review_required && data?.canApprove && <>
        {approvalAction(invoice)}
        <button className="button button-secondary" disabled={state.busy} onClick={() => { const comment = prompt("Rejection reason"); if (comment !== null) void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "reject", comment }); }}>Reject</button>
      </>}
      {invoice.status === "sent" && !invoice.tax_review_required && <>
        {data?.canApprove && <button className="button button-secondary" disabled={state.busy} onClick={() => {
          const reference = prompt("Verified external payment reference (confirm the full invoice amount was received)");
          if (reference) { const evidence = prompt("Evidence (receipt/reference note)"); if (evidence) void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "external_payment", reference, evidence }); }
        }}>Verify external payment</button>}
        {["one_shot", "installments"].includes(invoice.payment_type) && data?.canCreate && (invoice.created_by === data.userId || data.canApprove) && <>
          <button className="button button-secondary" disabled={state.busy} onClick={() => void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "sync_payment" })}><RefreshCw size={14} />Check payment status</button>
          <button className="button button-secondary" disabled={state.busy} onClick={() => {
            const url = prompt("Paste the company Razorpay (INR) or Stripe (USD) payment URL. Paid status is verified with the provider.");
            if (url) void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "verify_payment_url", url });
          }}>Verify payment URL</button>
        </>}
        {invoice.razorpay_short_url && <a className="button button-secondary" href={invoice.razorpay_short_url} target="_blank" rel="noreferrer">Razorpay Payment Link</a>}
        {invoice.stripe_checkout_url && <span className="invoice-action-note">USD: use the stable payment link in the invoice email</span>}
        {invoice.payment_link_lock_at && <span className="invoice-action-note">Payment Link reconciliation required</span>}
        {data?.canCreate && (invoice.created_by === data.userId || data.canApprove) && !invoice.email_message_id && <button className="button button-secondary" disabled={state.busy || !data.smtp.configured || Boolean(invoice.email_lock_at) || Boolean(invoice.payment_link_lock_at)} onClick={() => void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "email" })}><Mail size={14} />{invoice.email_lock_at ? "Email reconciliation required" : "Send invoice"}</button>}
        {invoice.email_message_id && <span className="invoice-action-note">Email accepted by SMTP</span>}
      </>}
    </div>;
  }
  const events = records.flatMap(invoice => [
    { id: `${invoice.id}-created`, date: invoice.created_at, actor: person(invoice.created_by), action: invoice.status === "pending_approval" ? "Discount requested" : "Invoice issued", detail: money(invoice.total, invoice.currency), invoice },
    ...invoice.invoice_approvals.flatMap(approval => approval.decision !== "pending" && approval.decided_at ? [{ id: approval.id, date: approval.decided_at, actor: person(approval.decided_by), action: `Invoice ${approval.decision}`, detail: approval.comment || "Approval decision recorded", invoice }] : []),
    ...(invoice.sent_at ? [{ id: `${invoice.id}-sent`, date: invoice.sent_at, actor: "SMTP delivery service", action: "Invoice email accepted", detail: "Provider acceptance does not confirm delivery.", invoice }] : []),
    ...(invoice.paid_at ? [{ id: `${invoice.id}-paid`, date: invoice.paid_at, actor: invoice.payment_verified_by ? person(invoice.payment_verified_by) : "Verified payment", action: "Payment received", detail: money(invoice.total, invoice.currency), invoice }] : []),
  ]).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  if (timelineOnly) return <div className="invoice-workspace invoice-embedded"><OperationFeedback {...state} /><div className="invoice-section-heading"><span className="invoice-heading-icon"><FileText size={21} /></span><div><h2>Invoices timeline</h2><p>Persisted invoice, approval, email and payment events</p></div></div><div className="invoice-event-list">{events.map(event => <article key={event.id} className="invoice-event"><span className="invoice-event-dot" /><div><time dateTime={event.date}>{formatDateTime(event.date)}</time><strong>{event.action}</strong><p>{event.invoice.invoice_no} · {event.detail}</p><small>{event.actor}</small></div></article>)}{!state.loading && !events.length && !state.error && <div className="invoice-empty"><FileText size={28} /><h3>No invoice activity yet</h3><p>Invoice events for this lead will appear here.</p></div>}</div></div>;
  return <div className={`invoice-workspace${leadId ? " invoice-embedded" : ""}`}>
    <header className={leadId ? "invoice-section-heading" : "page-heading invoice-page-heading"}><span className="invoice-heading-icon"><FileText size={23} /></span><div><div className="invoice-eyebrow">{leadId ? "RELATED RECORDS" : "ADMISSIONS FINANCE"}</div><h1>{leadId ? "Lead invoices" : "Invoices"}</h1><p>{leadId ? "Billing, approvals and payment records for this lead." : "A clear view of your billing, approvals and collections."}</p></div><div className="heading-actions"><button className="button button-secondary" disabled={state.loading || state.busy} onClick={() => void state.refresh()}><RefreshCw size={14} />Refresh</button>{data?.canCreate && <button className="button button-primary" disabled={state.busy} onClick={() => { setShowForm(!showForm); setSelectedId(""); }}><Plus size={15} />{showForm ? "Close form" : "Create invoice"}</button>}</div></header>
    <OperationFeedback {...state} />
    {data && <>
      <div className="invoice-metrics">{[{ label: "Awaiting payment", value: sum(["sent"]), icon: Wallet, tone: "blue" }, { label: "Collected", value: sum(["paid"]), icon: CheckCircle2, tone: "green" }, { label: "Pending approval", value: String(records.filter(invoice => invoice.status === "pending_approval").length), icon: CalendarClock, tone: "amber" }].map(metric => <div className={`panel invoice-metric is-${metric.tone}`} key={metric.label}><span><metric.icon size={19} /></span><div><small>{metric.label}</small><strong>{metric.value}</strong></div></div>)}</div>
      <div className="invoice-workflow-note"><ShieldCheck size={17} /><p>Confirm course pricing <ChevronRight size={12} /> Approve requested discounts <ChevronRight size={12} /> Email invoice &amp; collect payment <span>Fixed tax: INR 18% / USD 0% · Payment window: 4 days from creation · Loan/EMI: admin-verified financing.</span></p></div>
      {(!data.razorpay.configured || !data.smtp.configured || !data.stripe?.configured) && <details className="invoice-setup"><summary>Some delivery or payment actions need setup</summary><p>{!data.razorpay.configured && `Razorpay Payment Links setup missing: ${data.razorpay.missing.join(", ")}. `}{!data.stripe?.configured && `Stripe USD setup missing: ${data.stripe?.missing.join(", ") ?? "configure Stripe in Integrations"}. `}{!data.smtp.configured && `Transactional email setup missing: ${data.smtp.missing.join(", ")}.`} Invoice and receipt emails use the configured finance SMTP sender.</p></details>}
    </>}
    {showForm && data?.canCreate && <InvoiceCreateForm leadId={leadId} leads={data.leads} parents={data.installmentParents ?? []} busy={state.busy} onSubmit={values => state.mutate("/api/invoices", "POST", values)} onClose={() => setShowForm(false)} />}
    {selected && <section className="panel invoice-details" ref={detailRef} tabIndex={-1} aria-label={`Invoice ${selected.invoice_no} details`}><div className="panel-heading"><div><h2>Invoice details</h2><p>Live record · {statusLabel(selected.status)}</p></div><button className="button button-secondary" onClick={() => setSelectedId("")}>Close details</button></div>
      <div className="invoice-paper"><div className="invoice-paper-header" style={{ background: company.primary_color, color: "white", borderBottom: `6px solid ${company.accent_color}`, padding: 20 }}><div><span>{company.legal_name} · ADMISSIONS</span><h2>INVOICE</h2><p>{selected.invoice_no}</p><p style={{ whiteSpace: "pre-line" }}>{company.address}</p>{company.tax_id && <p>Tax ID: {company.tax_id}</p>}</div><span className={`invoice-status is-${selected.status}`}>{statusLabel(selected.status)}</span></div>
        <div className="invoice-billing"><div><small>BILL TO</small><strong>{selected.billing_name || data?.leads.find(lead => lead.id === selected.lead_id)?.name || "Linked lead"}</strong><p>{selected.billing_email}</p><p style={{ whiteSpace: "pre-line" }}>{selected.billing_address}</p><p>{selected.payment_type.replaceAll("_", " ")}</p>{selected.parent_invoice_id && <p>Installment linked to {selectedRoot?.invoice_no ?? "original invoice"}</p>}</div><dl><div><dt>Invoice date</dt><dd>{dateLabel(selected.created_at.slice(0,10))}</dd></div><div><dt>Due date</dt><dd>{dateLabel(selected.due_date)}</dd></div><div><dt>Currency</dt><dd>{selected.currency}</dd></div></dl></div>
        <div className="invoice-paper-table"><table><thead><tr><th>Item description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>{selected.invoice_items.map((item,index) => <tr key={index}><td>{item.description}</td><td>{item.quantity}</td><td>{money(item.unit_price,selected.currency)}</td><td>{money(item.amount,selected.currency)}</td></tr>)}</tbody></table></div>
        <dl className="invoice-totals"><div><dt>Subtotal</dt><dd>{money(selected.subtotal,selected.currency)}</dd></div><div><dt>Discount ({selected.discount_percent}%)</dt><dd>-{money(selected.discount_amount,selected.currency)}</dd></div><div><dt>Tax</dt><dd>{money(selected.tax_amount,selected.currency)}</dd></div><div className="invoice-grand-total"><dt>Current payment due</dt><dd>{money(selected.total,selected.currency)}</dd></div>{selected.payment_type === "installments" && <div><dt>Remaining course balance</dt><dd>{money(selectedBalance,selected.currency)}</dd></div>}</dl>
        {selected.payment_expires_at && <p className="zf-policy-note"><strong>Payment deadline</strong><br />{formatDateTime(selected.payment_expires_at)} · Four days from invoice creation. {selected.currency === "USD" && "A final Stripe session may run up to 30 minutes beyond this deadline."}</p>}
        {selected.tax_review_required && selected.status !== "paid" && <p className="zf-policy-note is-warning">Tax policy review required. An administrator must reconcile existing payment links, recalculate tax, and approve the revised invoice before delivery.</p>}
        {selected.pricing_review_note && <p className="zf-policy-note">{selected.pricing_review_note}</p>}
        {selected.payment_type === "installments" && <p className="invoice-paper-note"><strong>Installment {selected.installment_number ?? "record"}</strong>Full course total: {money(selectedCourseTotal, selected.currency)}<br />Confirmed course payments: {money(round(selectedCourseTotal - selectedBalance), selected.currency)}<br />Remaining course balance: {money(selectedBalance, selected.currency)}{selected.parent_invoice_id && selected.discount_percent > 0 && <><br />Discount inherited from the approved original enrollment.</>}</p>}
        {selected.discount_reason && <p className="invoice-paper-note"><strong>Discount reason</strong>{selected.discount_reason}</p>}{selected.notes && <p className="invoice-paper-note"><strong>Notes</strong>{selected.notes}</p>}
        {selected.external_payment_reference && <p className="invoice-paper-note"><strong>External payment verified</strong>Reference: {selected.external_payment_reference}<br />Evidence: {selected.external_payment_evidence ?? "Not recorded"}<br />Verified by {person(selected.payment_verified_by)}{selected.payment_verified_at && ` · ${formatDateTime(selected.payment_verified_at)}`}</p>}
        <div className="invoice-approval-history"><h3>Approval history</h3>{selected.invoice_approvals.map(approval => <p key={approval.id}><strong>{approval.decision}</strong> · {person(approval.decided_by ?? approval.requested_by)} · {formatDateTime(approval.decided_at ?? approval.created_at)}{approval.comment && <span>{approval.comment}</span>}</p>)}</div>
      </div><div className="invoice-detail-footer">{invoiceActions(selected)}</div></section>}
    <section className="panel invoice-register"><div className="panel-heading"><div><h2>{leadId ? "Invoices for this lead" : "Invoice register"}</h2><p>{invoices.length} matching records</p></div></div>
      <div className="table-toolbar"><label className="toolbar-search"><Search size={15} /><input aria-label="Search invoices" placeholder={leadId ? "Search invoice number" : "Search invoice or lead"} value={search} onChange={event => setSearch(event.target.value)} /></label><SearchableDropdown className="invoice-status-filter" ariaLabel="Invoice status" placeholder="All statuses" value={status} onChange={setStatus} options={[{ value: "", label: "All statuses" }, ...["pending_approval","sent","paid","rejected","cancelled","expired"].map(value => ({value,label:statusLabel(value)}))]} /></div>
      <div className="table-wrap"><table className="data-table invoice-table"><thead><tr><th>Invoice / Created</th>{!leadId && <th>Bill to</th>}<th>Current due / Balance</th><th>Status</th><th>Due date</th><th>Actions</th></tr></thead><tbody>{invoices.map(invoice => <tr key={invoice.id}>
        <td><button className="invoice-number-button" onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}><FileText size={16} /><span>{invoice.invoice_no}<small>{dateLabel(invoice.created_at.slice(0,10))}{invoice.installment_number ? ` · Installment ${invoice.installment_number}` : ""}</small></span></button></td>
        {!leadId && <td>{invoice.billing_name || data?.leads.find(lead => lead.id === invoice.lead_id)?.name || "Linked lead"}</td>}
        <td className="amount-cell">{money(invoice.total,invoice.currency)}{invoice.payment_type === "installments" && <small>Course balance: {money(data?.courseBalances?.[invoice.id] ?? Number(invoice.course_total ?? invoice.total),invoice.currency)}</small>}</td>
        <td><span className={`invoice-status is-${invoice.status}`}>{statusLabel(invoice.status)}</span>{invoice.status === "sent" && invoice.due_date && new Date(`${invoice.due_date}T23:59:59`).getTime() < Date.now() && <small className="invoice-overdue">Overdue</small>}</td>
        <td>{dateLabel(invoice.due_date)}</td><td><div className="invoice-table-actions">
          {approvalAction(invoice)}
          {data?.canApprove && invoice.tax_review_required && ["pending_approval", "sent"].includes(invoice.status) && <button className="button button-secondary" disabled={state.busy} onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}>Review tax before approval</button>}
          <button className="button button-secondary" onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}>Details</button><a className="button button-secondary" href={`/api/invoices/${invoice.id}/pdf`}>PDF</a>
        </div></td>
      </tr>)}</tbody></table></div>
      {!state.loading && !invoices.length && !state.error && <div className="invoice-empty"><FileText size={30} /><h3>{search || status ? "No matching invoices" : "No invoices yet"}</h3><p>{search || status ? "Try a different search or status filter." : data?.canCreate ? "Create an invoice to start the approval and collection workflow." : "Invoices issued for accessible leads will appear here."}</p></div>}
      <div className="table-footer">All {leadId ? "lead" : "accessible"} invoices · Payment status refreshes every 15 seconds. Interrupted provider actions remain locked for reconciliation.</div>
    </section>
  </div>;
}
