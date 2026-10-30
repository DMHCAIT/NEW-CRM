"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckCircle2, ChevronRight, Download, FileText, Mail, Plus, RefreshCw, Search, ShieldCheck, Wallet, X } from "lucide-react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { Configuration, LeadOption, OperationFeedback, formValues, useOperationalData } from "@/app/integrations/operational-ui";
import { formatDateTime } from "@/lib/crm-data";

type Invoice = {
  id: string; invoice_no: string; lead_id: string; created_by: string; total: number; subtotal: number; tax_amount: number; discount_amount: number; discount_reason: string | null; notes: string | null; currency: string;
  status: string; created_at: string; due_date: string | null; approved_at: string | null; approved_by: string | null; sent_at: string | null; paid_at: string | null;
  payment_type: string; discount_percent: number; course_total: number | null; parent_invoice_id: string | null;
  razorpay_payment_link_id: string | null; razorpay_short_url: string | null; email_message_id: string | null; payment_link_lock_at: string | null; email_lock_at: string | null; payment_verified_by: string | null;
  external_payment_reference: string | null; external_payment_evidence: string | null; payment_verified_at: string | null;
  invoice_items: { description: string; quantity: number; unit_price: number; amount: number }[];
  invoice_approvals: { id: string; requested_by: string; decided_by: string | null; decision: string; comment: string | null; created_at: string; decided_at: string | null }[];
};
type Data = {
  invoices: Invoice[];
  courseBalances?: Record<string, number>;
  installmentParents?: { id: string; invoice_no: string; course_total: number; currency: string; balance: number }[];
  leads: LeadOption[];
  profiles: { id: string; full_name: string }[];
  userId: string;
  canCreate: boolean;
  canApprove: boolean;
  razorpay: Configuration;
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
  const [billTo, setBillTo] = useState(leadId ?? "");
  const [quantity, setQuantity] = useState("1");
  const [rate, setRate] = useState("");
  const [tax, setTax] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [paymentType, setPaymentType] = useState("one_shot");
  const [parentInvoiceId, setParentInvoiceId] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selectedId) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [selectedId]);
  const data = state.data;
  const records = data?.invoices ?? [];
  const invoices = records.filter(invoice => (!status || invoice.status === status) && `${invoice.invoice_no} ${data?.leads.find(lead => lead.id === invoice.lead_id)?.name ?? ""}`.toLowerCase().includes(search.toLowerCase()));
  const selected = records.find(invoice => invoice.id === selectedId);
  const selectedRoot = selected?.parent_invoice_id ? records.find(row => row.id === selected.parent_invoice_id) : selected;
  const selectedCourseTotal = Number(selectedRoot?.course_total ?? selectedRoot?.total ?? 0);
  const selectedBalance = selected ? data?.courseBalances?.[selected.id] ?? Math.max(0, round(selectedCourseTotal - records.filter(row => (row.id === selectedRoot?.id || row.parent_invoice_id === selectedRoot?.id) && row.status === "paid").reduce((sum, row) => sum + Number(row.total), 0))) : 0;
  const subtotal = round(Number(quantity) * Number(rate));
  const previewDiscount = round(subtotal * Number(discount) / 100);
  const previewTotal = round(subtotal - previewDiscount + Number(tax));
  const person = (id: string | null) => data?.profiles?.find(profile => profile.id === id)?.full_name ?? "User name unavailable";
  const sum = (statuses: string[]) => {
    const totals = new Map<string, number>();
    for (const invoice of records.filter(row => statuses.includes(row.status))) totals.set(invoice.currency, (totals.get(invoice.currency) ?? 0) + Number(invoice.total));
    return totals.size ? [...totals].map(([currency, value]) => money(value, currency)).join(" / ") : money(0);
  };
  function invoiceActions(invoice: Invoice) {
    return <div className="invoice-record-actions">
      <a className="button button-secondary" href={`/api/invoices/${invoice.id}/pdf`}><Download size={14} />Download PDF</a>
      {invoice.status === "pending_approval" && data?.canApprove && <>
        <button className="button button-primary" disabled={state.busy} onClick={() => { if (confirm(`Approve discount request for ${invoice.invoice_no} (${invoice.discount_percent}%)?`)) void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "approve" }); }}><ShieldCheck size={14} />Approve discount</button>
        <button className="button button-secondary" disabled={state.busy} onClick={() => { const comment = prompt("Rejection reason"); if (comment !== null) void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "reject", comment }); }}>Reject</button>
      </>}
      {invoice.status === "sent" && <>
        {(invoice.payment_type === "emi" || invoice.payment_type === "loan") && data?.canApprove && <button className="button button-secondary" disabled={state.busy} onClick={() => {
          const reference = prompt("Financing payment reference");
          if (reference) { const evidence = prompt("Evidence (receipt/reference note)"); if (evidence) void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "external_payment", reference, evidence }); }
        }}>Verify external payment</button>}
        {invoice.razorpay_short_url && <a className="button button-secondary" href={invoice.razorpay_short_url} target="_blank" rel="noreferrer">Razorpay Payment Link</a>}
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
      <div className="invoice-workflow-note"><ShieldCheck size={17} /><p>Issue automatically without a discount <ChevronRight size={12} /> Approve requested discounts <ChevronRight size={12} /> Collect payment <span>Razorpay events or authorized external-financing verification are required to mark paid.</span></p></div>
      {(!data.razorpay.configured || !data.smtp.configured) && <details className="invoice-setup"><summary>Some delivery or payment actions need setup</summary><p>{!data.razorpay.configured && `Razorpay Payment Links setup missing: ${data.razorpay.missing.join(", ")}. `}{!data.smtp.configured && `Transactional email setup missing: ${data.smtp.missing.join(", ")}.`} Invoice and receipt emails use the configured finance SMTP sender; Gmail integration was not changed.</p></details>}
    </>}
    {showForm && data?.canCreate && <section className="panel invoice-editor"><div className="panel-heading"><div><h2>New invoice</h2><p>INR billing · Automatic issue/payment link/email unless discount approval is needed</p></div><button className="button button-quiet" type="button" aria-label="Close invoice form" disabled={state.busy} onClick={() => setShowForm(false)}><X size={18} /></button></div><form className="operational-form invoice-form" onSubmit={async event => {
      event.preventDefault();
      if (await state.mutate("/api/invoices", "POST", formValues(event.currentTarget))) { setShowForm(false); setQuantity("1"); setRate(""); setTax("0"); setDiscount("0"); setPaymentType("one_shot"); setParentInvoiceId(""); }
    }}>
      <fieldset disabled={state.busy} className="invoice-form-fields"><legend>Billing details</legend>
        {leadId ? <><input type="hidden" name="lead_id" value={leadId} /><div className="invoice-fixed-lead"><small>Bill to</small><strong>{data.leads.find(lead => lead.id === leadId)?.name ?? "This lead"}</strong></div></> : <label className="invoice-bill-to">Bill to <span className="invoice-required">*</span><SearchableDropdown name="lead_id" required ariaLabel="Invoice lead" value={billTo} onChange={setBillTo} placeholder="Search an accessible lead" options={data.leads.map(lead => ({ value: lead.id, label: lead.name }))} optionsMaxHeight={200} openDirection="auto" /></label>}
        <label>Due date <span className="invoice-required">*</span><input className="form-input" type="date" name="due_date" required /></label>
        <label>Payment type<select className="form-input" name="payment_type" value={paymentType} onChange={event => { setPaymentType(event.target.value); setParentInvoiceId(""); }}><option value="one_shot">One-shot payment</option><option value="installments">Installments</option><option value="emi">EMI financing (tracked externally)</option><option value="loan">Loan financing (tracked externally)</option></select></label>
        {paymentType === "installments" && <>
          <label>Related original invoice<select className="form-input" name="parent_invoice_id" value={parentInvoiceId} onChange={event => setParentInvoiceId(event.target.value)}><option value="">New course / first installment</option>{(data.installmentParents ?? []).map(row => <option key={row.id} value={row.id}>{row.invoice_no} · {money(row.balance, row.currency)} remaining</option>)}</select></label>
          {!parentInvoiceId ? <label>Course total (INR)<input className="form-input" name="course_total" type="number" min={0.01} step="0.01" required placeholder="Full course fee" /></label> : <input type="hidden" name="course_total" value={data.installmentParents?.find(row => row.id === parentInvoiceId)?.course_total ?? ""} />}
          {parentInvoiceId && <p>Remaining course balance after verified payments: {money(data.installmentParents?.find(row => row.id === parentInvoiceId)?.balance ?? 0)}</p>}
        </>}
        <div className="invoice-item-editor"><div className="invoice-item-caption">ITEM DETAILS <span>Currency: INR</span></div><div className="invoice-item-fields"><label>Description<input className="form-input" name="description" placeholder="Course or admission fee" required maxLength={500} /></label><label>Quantity<input className="form-input" name="quantity" type="number" min="0.01" max="10000" step="0.01" value={quantity} onChange={event => setQuantity(event.target.value)} required /></label><label>Rate (INR)<input className="form-input" name="unit_price" type="number" min={0} max={99999999} step="0.01" value={rate} onChange={event => setRate(event.target.value)} required /></label><div className="invoice-line-amount"><small>Amount</small><strong>{money(subtotal)}</strong></div></div></div>
        <label>Tax amount (INR)<input className="form-input" name="tax_amount" type="number" min={0} max={99999999} step="0.01" value={tax} onChange={event => setTax(event.target.value)} required /></label>
        <label>Discount (%)<input className="form-input" name="discount_percent" type="number" min={0} max={100} step="0.01" value={discount} onChange={event => setDiscount(event.target.value)} required /></label>
        <label>Discount reason<input className="form-input" name="discount_reason" maxLength={1000} required={Number(discount) > 0} placeholder="Required when applying a discount" /></label>
        <label>Notes<textarea className="form-input" name="notes" rows={3} maxLength={3000} placeholder="Payment instructions or information for the recipient" /></label>
        <dl className="invoice-totals"><div><dt>Subtotal</dt><dd>{money(subtotal)}</dd></div><div><dt>Discount</dt><dd>-{money(previewDiscount)}</dd></div><div><dt>Tax</dt><dd>{money(Number(tax))}</dd></div><div className="invoice-grand-total"><dt>Total due</dt><dd>{money(previewTotal)}</dd></div></dl>
      </fieldset><div className="invoice-form-footer"><p>Invoices without discounts are issued, payment-linked and emailed automatically.</p><button type="button" className="button button-secondary" disabled={state.busy} onClick={() => setShowForm(false)}>Cancel</button><button className="button button-primary" disabled={state.busy || !billTo || !rate || previewTotal <= 0}>{state.busy ? "Submitting..." : Number(discount) > 0 ? "Request discount approval" : "Issue invoice"}</button></div>
    </form></section>}
    {selected && <section className="panel invoice-details" ref={detailRef} tabIndex={-1} aria-label={`Invoice ${selected.invoice_no} details`}><div className="panel-heading"><div><h2>Invoice details</h2><p>Live record · {statusLabel(selected.status)}</p></div><button className="button button-secondary" onClick={() => setSelectedId("")}>Close details</button></div>
      <div className="invoice-paper"><div className="invoice-paper-header"><div><span className="invoice-eyebrow">DMHCA · ADMISSIONS</span><h2>INVOICE</h2><p>{selected.invoice_no}</p></div><span className={`invoice-status is-${selected.status}`}>{statusLabel(selected.status)}</span></div>
        <div className="invoice-billing"><div><small>BILL TO</small><strong>{data?.leads.find(lead => lead.id === selected.lead_id)?.name ?? "Linked lead"}</strong><p>{selected.payment_type.replaceAll("_", " ")}</p>{selected.parent_invoice_id && <p>Installment linked to {selectedRoot?.invoice_no ?? "original invoice"}</p>}</div><dl><div><dt>Invoice date</dt><dd>{dateLabel(selected.created_at.slice(0,10))}</dd></div><div><dt>Due date</dt><dd>{dateLabel(selected.due_date)}</dd></div><div><dt>Currency</dt><dd>{selected.currency}</dd></div></dl></div>
        <div className="invoice-paper-table"><table><thead><tr><th>Item description</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead><tbody>{selected.invoice_items.map((item,index) => <tr key={index}><td>{item.description}</td><td>{item.quantity}</td><td>{money(item.unit_price,selected.currency)}</td><td>{money(item.amount,selected.currency)}</td></tr>)}</tbody></table></div>
        <dl className="invoice-totals"><div><dt>Subtotal</dt><dd>{money(selected.subtotal,selected.currency)}</dd></div><div><dt>Discount ({selected.discount_percent}%)</dt><dd>-{money(selected.discount_amount,selected.currency)}</dd></div><div><dt>Tax</dt><dd>{money(selected.tax_amount,selected.currency)}</dd></div><div className="invoice-grand-total"><dt>Current payment due</dt><dd>{money(selected.total,selected.currency)}</dd></div>{selected.payment_type === "installments" && <div><dt>Remaining course balance</dt><dd>{money(selectedBalance,selected.currency)}</dd></div>}</dl>
        {selected.discount_reason && <p className="invoice-paper-note"><strong>Discount reason</strong>{selected.discount_reason}</p>}{selected.notes && <p className="invoice-paper-note"><strong>Notes</strong>{selected.notes}</p>}
        {selected.external_payment_reference && <p className="invoice-paper-note"><strong>External payment verified</strong>Reference: {selected.external_payment_reference}<br />Evidence: {selected.external_payment_evidence ?? "Not recorded"}<br />Verified by {person(selected.payment_verified_by)}{selected.payment_verified_at && ` · ${formatDateTime(selected.payment_verified_at)}`}</p>}
        <div className="invoice-approval-history"><h3>Approval history</h3>{selected.invoice_approvals.map(approval => <p key={approval.id}><strong>{approval.decision}</strong> · {person(approval.decided_by ?? approval.requested_by)} · {formatDateTime(approval.decided_at ?? approval.created_at)}{approval.comment && <span>{approval.comment}</span>}</p>)}</div>
      </div><div className="invoice-detail-footer">{invoiceActions(selected)}</div></section>}
    <section className="panel invoice-register"><div className="panel-heading"><div><h2>{leadId ? "Invoices for this lead" : "Invoice register"}</h2><p>{invoices.length} matching records</p></div></div>
      <div className="table-toolbar"><label className="toolbar-search"><Search size={15} /><input aria-label="Search invoices" placeholder={leadId ? "Search invoice number" : "Search invoice or lead"} value={search} onChange={event => setSearch(event.target.value)} /></label><SearchableDropdown className="invoice-status-filter" ariaLabel="Invoice status" placeholder="All statuses" value={status} onChange={setStatus} options={[{ value: "", label: "All statuses" }, ...["pending_approval","sent","paid","rejected","cancelled","expired"].map(value => ({value,label:statusLabel(value)}))]} /></div>
      <div className="table-wrap"><table className="data-table invoice-table"><thead><tr><th>Invoice / Created</th>{!leadId && <th>Bill to</th>}<th>Current due / Balance</th><th>Status</th><th>Due date</th><th>Actions</th></tr></thead><tbody>{invoices.map(invoice => <tr key={invoice.id}><td><button className="invoice-number-button" onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}><FileText size={16} /><span>{invoice.invoice_no}<small>{dateLabel(invoice.created_at.slice(0,10))}</small></span></button></td>{!leadId && <td>{data?.leads.find(lead => lead.id === invoice.lead_id)?.name ?? "Linked lead"}</td>}<td className="amount-cell">{money(invoice.total,invoice.currency)}{invoice.payment_type === "installments" && <small>Course balance: {money(data?.courseBalances?.[invoice.id] ?? Number(invoice.course_total ?? invoice.total),invoice.currency)}</small>}</td><td><span className={`invoice-status is-${invoice.status}`}>{statusLabel(invoice.status)}</span>{invoice.status === "sent" && invoice.due_date && new Date(`${invoice.due_date}T23:59:59`).getTime() < Date.now() && <small className="invoice-overdue">Overdue</small>}</td><td>{dateLabel(invoice.due_date)}</td><td><div className="invoice-table-actions"><button className="button button-secondary" onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}>Details</button><a className="button button-secondary" href={`/api/invoices/${invoice.id}/pdf`}>PDF</a></div></td></tr>)}</tbody></table></div>
      {!state.loading && !invoices.length && !state.error && <div className="invoice-empty"><FileText size={30} /><h3>{search || status ? "No matching invoices" : "No invoices yet"}</h3><p>{search || status ? "Try a different search or status filter." : data?.canCreate ? "Create an invoice to start the approval and collection workflow." : "Invoices issued for accessible leads will appear here."}</p></div>}
      <div className="table-footer">Latest 200 {leadId ? "lead" : "accessible"} invoices · Interrupted provider actions remain locked for reconciliation.</div>
    </section>
  </div>;
}
