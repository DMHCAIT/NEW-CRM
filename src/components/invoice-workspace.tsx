"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckCircle2, ChevronRight, Download, FileText, Mail, Plus, RefreshCw, Search, ShieldCheck, Wallet } from "lucide-react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { Configuration, formValues, LeadOption, OperationFeedback, useOperationalData } from "@/app/integrations/operational-ui";
import { formatDateTime } from "@/lib/crm-data";
import { InvoiceCreateForm, type InstallmentParent } from "@/components/invoice-create-form";
import type { BillingCompany } from "@/lib/billing";
import { SectionLoading } from "@/components/section-loading";
import { installmentLabel } from "@/lib/invoice-schedule";
import { buildInvoiceHtml } from "@/lib/invoice-document";
import { invoiceStatusShouldRefresh } from "@/lib/invoice-policy";
import type { InvoiceDocumentDetails } from "@/lib/billing";
import { installmentPaymentSummary } from "@/lib/invoice-payment-summary";

type Invoice = {
  document_details?: Partial<InvoiceDocumentDetails>;
  id: string; invoice_no: string; lead_id: string; created_by: string; total: number; subtotal: number; tax_amount: number; discount_amount: number; discount_reason: string | null; notes: string | null; currency: string;
  status: string; created_at: string; due_date: string | null; approved_at: string | null; approved_by: string | null; sent_at: string | null; paid_at: string | null;
  payment_type: string; discount_percent: number; course_total: number | null; parent_invoice_id: string | null;
  razorpay_payment_link_id: string | null; razorpay_short_url: string | null; email_message_id: string | null; payment_link_lock_at: string | null; email_lock_at: string | null; payment_verified_by: string | null;
  external_payment_reference: string | null; external_payment_evidence: string | null; payment_verified_at: string | null;
  company_snapshot?: BillingCompany | null; billing_name?: string; billing_email?: string; billing_address?: string;
  stripe_checkout_url?: string | null;
  payment_url?: string | null;
  installment_number?: number | null;
  payment_expires_at?: string | null; stripe_expires_at?: string | null;
  tax_review_required?: boolean; pricing_review_note?: string | null;
  invoice_date?: string | null; scheduled_for?: string | null; delivery_error?: string | null;
  course_id?: string | null; company_code?: string | null; can_reconcile_payment?: boolean;
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
  smtp: Configuration;
};
const statusLabel = (status: string) => ({ scheduled: "Scheduled", pending_approval: "Pending approval", sent: "Awaiting payment", paid: "Paid", rejected: "Rejected", cancelled: "Cancelled", expired: "Expired" }[status] ?? status.replaceAll("_", " "));
const money = (value: number, currency = "INR") => new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(Number(value));
const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`)) : "On receipt";
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function InvoiceWorkspace({ leadId, timelineOnly = false }: { leadId?: string; timelineOnly?: boolean }) {
  const Heading = leadId ? "h2" : "h1";
  const state = useOperationalData<Data>(leadId ? `/api/invoices?leadId=${encodeURIComponent(leadId)}` : "/api/invoices");
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [page, setPage] = useState(0);
  const [enrollmentId, setEnrollmentId] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [downloadingId, setDownloadingId] = useState("");
  const [paymentStatusError, setPaymentStatusError] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  const { data, busy, refresh } = state;
  async function downloadInvoice(invoice: Invoice) {
    setDownloadError(""); setDownloadingId(invoice.id);
    try {
      const response = await fetch(`/api/invoices/${encodeURIComponent(invoice.id)}/pdf`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error ?? "Invoice PDF could not be downloaded.");
      }
      if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/pdf"))
        throw new Error("The server did not return an invoice PDF. Refresh and sign in again if needed.");
      const blob = await response.blob();
      if (await blob.slice(0, 5).text() !== "%PDF-") throw new Error("The invoice PDF is incomplete. Please retry.");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url; link.download = `${invoice.invoice_no}.pdf`;
      document.body.appendChild(link);
      link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Invoice PDF could not be downloaded. Please retry.");
    } finally { setDownloadingId(""); }
  }
  useEffect(() => {
    setPaymentStatusError("");
    if (busy || showForm || !data?.invoices.some(invoice => invoiceStatusShouldRefresh(invoice.status))) return;
    const selected = data.invoices.find(invoice => invoice.id === selectedId);
    const watchSelected = selected && invoiceStatusShouldRefresh(selected.status);
    let active = true;
    let loading = false;
    let lastRegisterRefresh = Date.now();
    const resume = async () => {
      if (!active || document.visibilityState !== "visible" || loading) return;
      loading = true;
      try {
        if (watchSelected) {
          const response = await fetch(`/api/invoices/${encodeURIComponent(selected.id)}/status`, { cache: "no-store" });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error ?? "Payment status could not be refreshed.");
          if (active && (payload.status !== selected.status || payload.paidAt !== selected.paid_at || Date.now() - lastRegisterRefresh >= 15000)) {
            await refresh();
            lastRegisterRefresh = Date.now();
          }
        } else await refresh();
        if (active) setPaymentStatusError("");
      } catch (error) {
        if (active) setPaymentStatusError(error instanceof Error ? error.message : "Payment status could not be refreshed.");
      } finally { loading = false; }
    };
    const timer = window.setInterval(resume, watchSelected ? 2000 : 15000);
    if (watchSelected) void resume();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [busy, data, refresh, showForm, selectedId]);
  useEffect(() => {
    if (selectedId) {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [selectedId]);
  const records = data?.invoices ?? [];
  const recordsById = new Map(records.map(invoice => [invoice.id, invoice]));
  const leadNames = new Map(data?.leads.map(lead => [lead.id, lead.name]));
  const profileNames = new Map(data?.profiles?.map(profile => [profile.id, profile.full_name]));
  const courseName = (invoice: Invoice) => (recordsById.get(invoice.parent_invoice_id ?? invoice.id) ?? invoice).invoice_items[0]?.description ?? "Course unavailable";
  const invoiceCourseBalance = (invoice: Invoice) => {
    const root = recordsById.get(invoice.parent_invoice_id ?? invoice.id) ?? invoice;
    const parent = data?.installmentParents?.find(row => row.id === root.id);
    return parent?.available_balance ?? Math.max(0, round(Number(root.course_total ?? root.total ?? 0)
      - records.filter(row => (row.id === root.id || row.parent_invoice_id === root.id) && !["cancelled", "rejected"].includes(row.status))
        .reduce((sum, row) => sum + Number(row.total), 0)));
  };
  const invoices = records.filter(invoice => (!status || invoice.status === status) && `${invoice.invoice_no} ${courseName(invoice)} ${invoice.billing_name ?? ""} ${leadNames.get(invoice.lead_id) ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(invoices.length / 25) - 1));
  const visibleInvoices = invoices.slice(pageIndex * 25, (pageIndex + 1) * 25);
  const selected = recordsById.get(selectedId);
  const selectedRoot = selected?.parent_invoice_id ? recordsById.get(selected.parent_invoice_id) : selected;
  const selectedEnrollment = data?.installmentParents?.find(parent => parent.id === selectedRoot?.id);
  const selectedInstallments = selected?.payment_type === "installments" && selectedRoot
    ? records.filter(row => (row.parent_invoice_id ?? row.id) === selectedRoot.id).sort((a, b) => Number(a.installment_number ?? 0) - Number(b.installment_number ?? 0) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)) : [];
  const selectedCourseTotal = Number(selectedRoot?.course_total ?? selectedRoot?.total ?? 0);
  const selectedBalance = selected ? data?.courseBalances?.[selected.id] ?? Math.max(0, round(selectedCourseTotal - records.filter(row => (row.id === selectedRoot?.id || row.parent_invoice_id === selectedRoot?.id) && row.status === "paid").reduce((sum, row) => sum + Number(row.total), 0))) : 0;
  const selectedUnallocated = selected ? invoiceCourseBalance(selected) : 0;
  const person = (id: string | null) => (id ? profileNames.get(id) : undefined) ?? "User name unavailable";
  const enrollmentApproved = (invoice: Invoice) => {
    const root = recordsById.get(invoice.parent_invoice_id ?? invoice.id);
    return root && !invoice.tax_review_required && !root.tax_review_required && !["pending_approval", "rejected"].includes(root.status)
      && (!(Number(root.discount_percent) > 0 || root.pricing_review_note) || Boolean(root.approved_at));
  };
  const canRecordPayment = (invoice: Invoice) => Boolean(data?.canCreate && (invoice.can_reconcile_payment
    ?? (invoice.created_by === data.userId || data.canApprove)));
  function addInstallments(parent: InstallmentParent) {
    setEnrollmentId(parent.id); setSelectedId(""); setShowForm(true);
  }
  const sum = (statuses: string[]) => {
    const totals = new Map<string, number>();
    for (const invoice of records.filter(row => statuses.includes(row.status))) totals.set(invoice.currency, (totals.get(invoice.currency) ?? 0) + Number(invoice.total));
    return totals.size ? [...totals].map(([currency, value]) => money(value, currency)).join(" / ") : money(0);
  };
  function approvalAction(invoice: Invoice) {
    if (!data?.canApprove || invoice.status !== "pending_approval" || invoice.tax_review_required) return null;
    return <button className="button button-primary" disabled={state.busy} aria-label={invoice.scheduled_for ? `Approve enrollment ${invoice.invoice_no}` : `Approve and send invoice ${invoice.invoice_no}`} onClick={() => {
      if (confirm(`Approve ${invoice.invoice_no} with ${invoice.discount_percent}% discount and total ${money(invoice.total, invoice.currency)}? ${invoice.scheduled_for ? "This approves the enrollment once. Installments will be emailed on their scheduled dates." : "The invoice and payment link will be emailed automatically."}`))
        void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "approve" });
    }}><ShieldCheck size={14} />{invoice.scheduled_for ? "Approve enrollment" : "Approve & send invoice"}</button>;
  }
  function invoiceActions(invoice: Invoice) {
    const parent = data?.installmentParents?.find(row => row.id === (invoice.parent_invoice_id ?? invoice.id));
    return <div className="invoice-record-actions">
      {invoice.status === "paid" && <span role="status" style={{ background: "#167844", color: "#fff", borderRadius: 4, padding: "10px 16px", fontWeight: 700 }}>Paid {money(invoice.total, invoice.currency)}</span>}
      {invoice.payment_url && invoice.status === "sent" && enrollmentApproved(invoice) && <a className="button button-primary" href={invoice.payment_url} target="_blank" rel="noreferrer">Pay Now</a>}
      <button className="button button-secondary" disabled={Boolean(downloadingId)} onClick={() => void downloadInvoice(invoice)}><Download size={14} />{downloadingId === invoice.id ? "Downloading…" : "Download PDF"}</button>
      {data?.canCreate && parent && Number(parent.available_balance) >= 1 && !parent.tax_review_required && <button className="button button-primary" disabled={state.busy} onClick={() => addInstallments(parent)}><Plus size={14} />Add next installment</button>}
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
        {["one_shot", "installments"].includes(invoice.payment_type) && canRecordPayment(invoice) && <>
          <button className="button button-secondary" disabled={state.busy} onClick={() => void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "sync_payment" })}><RefreshCw size={14} />Check payment status</button>
        </>}
        {invoice.payment_url && enrollmentApproved(invoice) && <a className="button button-secondary" href={invoice.payment_url} target="_blank" rel="noreferrer">Pay Now</a>}
        {invoice.payment_link_lock_at && <span className="invoice-action-note">Payment Link reconciliation required</span>}
        {canRecordPayment(invoice) && !invoice.email_message_id && <button className="button button-secondary" disabled={state.busy || !data?.smtp.configured || Boolean(invoice.email_lock_at) || Boolean(invoice.payment_link_lock_at)} onClick={() => void state.mutate(`/api/invoices/${invoice.id}`, "PATCH", { action: "email" })}><Mail size={14} />{invoice.email_lock_at ? "Email reconciliation required" : "Send invoice"}</button>}
        {invoice.email_message_id && <span className="invoice-action-note">Email accepted by SMTP</span>}
      </>}
    </div>;
  }
  const events = (timelineOnly ? records : []).flatMap(invoice => [
    { id: `${invoice.id}-created`, date: invoice.created_at, actor: person(invoice.created_by), action: invoice.status === "pending_approval" ? "Discount requested" : invoice.scheduled_for ? "Installment scheduled" : "Invoice issued", detail: money(invoice.total, invoice.currency), invoice },
    ...invoice.invoice_approvals.flatMap(approval => approval.decision !== "pending" && approval.decided_at ? [{ id: approval.id, date: approval.decided_at, actor: person(approval.decided_by), action: `Invoice ${approval.decision}`, detail: approval.comment || "Approval decision recorded", invoice }] : []),
    ...(invoice.sent_at ? [{ id: `${invoice.id}-sent`, date: invoice.sent_at, actor: "SMTP delivery service", action: "Invoice email accepted", detail: "Provider acceptance does not confirm delivery.", invoice }] : []),
    ...(invoice.paid_at ? [{ id: `${invoice.id}-paid`, date: invoice.paid_at, actor: invoice.payment_verified_by ? person(invoice.payment_verified_by) : "Verified payment", action: "Payment received", detail: money(invoice.total, invoice.currency), invoice }] : []),
  ]).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  if (state.loading && !data) return <SectionLoading title="Invoices" />;
  if (timelineOnly) return <div className="invoice-workspace invoice-embedded"><OperationFeedback {...state} /><div className="invoice-section-heading"><span className="invoice-heading-icon"><FileText size={21} /></span><div><h2>Invoices timeline</h2><p>Persisted invoice, approval, email and payment events</p></div></div><div className="invoice-event-list">{events.map(event => <article key={event.id} className="invoice-event"><span className="invoice-event-dot" /><div><time dateTime={event.date}>{formatDateTime(event.date)}</time><strong>{event.action}</strong><p>{event.invoice.invoice_no} · {event.detail}</p><small>{event.actor}</small></div></article>)}{!state.loading && !events.length && !state.error && <div className="invoice-empty"><FileText size={28} /><h3>No invoice activity yet</h3><p>Invoice events for this lead will appear here.</p></div>}</div></div>;
  return <div className={`invoice-workspace finance-workspace${leadId ? " invoice-embedded" : ""}`}>
    <header className={leadId ? "invoice-section-heading" : "page-heading invoice-page-heading"}><span className="invoice-heading-icon"><FileText size={23} /></span><div><div className="invoice-eyebrow">{leadId ? "RELATED RECORDS" : "ADMISSIONS FINANCE"}</div><Heading>{leadId ? "Lead invoices" : "Invoices"}</Heading><p>{leadId ? "Billing, approvals and payment records for this lead." : "A clear view of your billing, approvals and collections."}</p></div><div className="heading-actions"><button className="button button-secondary" disabled={state.loading || state.busy} onClick={() => void state.refresh()}><RefreshCw size={14} />Refresh</button>{data?.canCreate && <button className="button button-primary" disabled={state.busy} onClick={() => { setShowForm(!showForm); setSelectedId(""); setEnrollmentId(""); }}><Plus size={15} />{showForm ? "Close form" : "Create invoice"}</button>}</div></header>
    <OperationFeedback {...state} />
    {paymentStatusError && <div className="helper-banner" role="alert">{paymentStatusError}</div>}
    {downloadError && <div className="helper-banner" role="alert">{downloadError}</div>}
    <nav className="workspace-view-tabs" aria-label="Invoice register views">{[{ value: "", label: "All invoices" }, { value: "pending_approval", label: "Awaiting approval" }, { value: "scheduled", label: "Scheduled" }, { value: "sent", label: "Awaiting payment" }, { value: "paid", label: "Paid" }].map(view => <button key={view.value} aria-current={status === view.value ? "page" : undefined} onClick={() => { setStatus(view.value); setPage(0); }} disabled={state.loading}><span>{view.label}</span><span>{records.filter(record => !view.value || record.status === view.value).length}</span></button>)}</nav>
    {data && <>
      <div className="invoice-metrics">{[{ label: "Awaiting payment", value: sum(["sent"]), icon: Wallet, tone: "blue" }, { label: "Collected", value: sum(["paid"]), icon: CheckCircle2, tone: "green" }, { label: "Pending approval", value: String(records.filter(invoice => invoice.status === "pending_approval").length), icon: CalendarClock, tone: "amber" }].map(metric => <div className={`panel invoice-metric is-${metric.tone}`} key={metric.label}><span><metric.icon size={19} /></span><div><small>{metric.label}</small><strong>{metric.value}</strong></div></div>)}</div>
      <div className="invoice-workflow-note"><ShieldCheck size={17} /><p>Confirm course pricing <ChevronRight size={12} /> Approve enrollment discount once <ChevronRight size={12} /> Schedule invoices &amp; collect payment <span>Fixed tax: INR 18% / USD 0% · Installments: 9:00 AM India time, due 4 days after invoice date · Loan/EMI: admin-verified financing.</span></p></div>
      {(!data.razorpay.configured || !data.smtp.configured) && <details className="invoice-setup"><summary>Some delivery or payment actions need setup</summary><p>{!data.razorpay.configured && `Razorpay Payment Links setup missing: ${data.razorpay.missing.join(", ")}. `}{!data.smtp.configured && `Transactional email setup missing: ${data.smtp.missing.join(", ")}.`} Razorpay handles INR and USD; international payments must be enabled for USD. Invoice and receipt emails use the configured finance SMTP sender.</p></details>}
    </>}
    {showForm && data?.canCreate && <InvoiceCreateForm key={enrollmentId} enrollment={data.installmentParents?.find(parent => parent.id === enrollmentId)} leadId={leadId} leads={data.leads} parents={data.installmentParents ?? []} busy={state.busy} onSubmit={values => state.mutate("/api/invoices", "POST", values)} onClose={() => setShowForm(false)} />}
    {selected && <section className="panel invoice-details" ref={detailRef} tabIndex={-1} aria-label={`Invoice ${selected.invoice_no} details`}><div className="panel-heading"><div><h2>Invoice details</h2><p>Live record · {statusLabel(selected.status)}</p></div><button className="button button-secondary" onClick={() => setSelectedId("")}>Close details</button></div>
      {["sent", "expired"].includes(selected.status) && ["one_shot", "installments"].includes(selected.payment_type) && <p className="zf-policy-note">Online payments are confirmed automatically by Razorpay. This view checks for updates every two seconds; manual verification is only for recovery or external payments.</p>}
      {selected.scheduled_for && <p className="zf-policy-note">Scheduled email: {formatDateTime(selected.scheduled_for)}. Delivery waits for enrollment approval, not earlier installment payments.</p>}
      {selected.parent_invoice_id && selectedRoot?.approved_at && <p className="zf-policy-note">Enrollment approval inherited from {selectedRoot.invoice_no}: {person(selectedRoot.approved_by)} · {formatDateTime(selectedRoot.approved_at)}. No additional discount approval is required.</p>}
      {selected.delivery_error && <p role="alert" className="zf-alert">Delivery needs attention: {selected.delivery_error}</p>}
      {selectedRoot && selected.payment_type === "installments" && <section className="zf-installment-plan" aria-label="Course installments">
        <div className="panel-heading"><div><h3>{courseName(selected)} - course installments</h3><p>One course enrollment: {selectedRoot.invoice_no}. All payments below reduce this course balance only.</p></div>
          {data?.canCreate && selectedEnrollment && Number(selectedEnrollment.available_balance) >= 1 && !selectedEnrollment.tax_review_required && <button className="button button-primary" disabled={state.busy} onClick={() => addInstallments(selectedEnrollment)}><Plus size={14} />Add next installment</button>}</div>
        <dl className="zf-payment-summary">{[["Course total", selectedCourseTotal], ["Paid", round(selectedCourseTotal - selectedBalance)], ["Outstanding", selectedBalance], ["Available for new installments", selectedUnallocated]].map(([label, amount]) => <div key={label}><dt>{label}</dt><dd>{money(Number(amount), selected.currency)}</dd></div>)}</dl>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Installment</th><th>Amount</th><th>Invoice date</th><th>Due date</th><th>Status</th><th /></tr></thead><tbody>{selectedInstallments.map((row, index) => <tr key={row.id} aria-current={row.id === selected.id ? "true" : undefined}><td>{installmentLabel(row.installment_number ?? index + 1)}<small>{row.invoice_no}</small></td><td>{money(row.total, row.currency)}</td><td>{dateLabel(row.invoice_date ?? row.created_at.slice(0, 10))}</td><td>{dateLabel(row.due_date)}</td><td><span className={`invoice-status is-${row.status}`}>{statusLabel(row.status)}</span></td><td><button className="button button-secondary" onClick={() => setSelectedId(row.id)}>Open installment</button></td></tr>)}</tbody></table></div>
      </section>}
      {["sent", "scheduled", "expired"].includes(selected.status) && enrollmentApproved(selected) && (canRecordPayment(selected) || data?.canApprove) && <section className="invoice-external-payment" aria-label="Record external payment">
        <h3>Record external payment</h3><p>Record the full amount of this {selected.payment_type === "installments" ? "installment" : "invoice"} only: <strong>{money(selected.total, selected.currency)}</strong>.</p>
        {canRecordPayment(selected) && ["one_shot", "installments"].includes(selected.payment_type) && <form key={`${selected.id}-link`} className="operational-form" onSubmit={async event => { event.preventDefault(); const values = formValues(event.currentTarget); await state.mutate(`/api/invoices/${selected.id}`, "PATCH", { action: "verify_payment_url", url: values.url }); }}>
          <label>Payment link<input className="form-input" name="url" type="url" required maxLength={2000} placeholder="Paste the company Razorpay payment URL" /></label>
          <button className="button button-primary" disabled={state.busy}>Verify link &amp; mark paid</button>
          <p className="zf-hint">The provider must confirm a captured payment matching the customer, amount and currency. An unpaid, unrelated or already-used payment cannot mark this invoice Paid.</p>
        </form>}
        {data?.canApprove && <details><summary>Finance: confirm bank / UPI payment</summary><form key={`${selected.id}-finance`} className="operational-form" onSubmit={async event => { event.preventDefault(); if (!confirm("Confirm that finance verified receipt of the full amount for this invoice?")) return; const values = formValues(event.currentTarget); await state.mutate(`/api/invoices/${selected.id}`, "PATCH", { action: "external_payment", reference: values.reference, evidence: values.evidence }); }}>
          <label>Payment reference<input className="form-input" name="reference" required maxLength={200} /></label><label>Receipt link or verification evidence<textarea className="form-input" name="evidence" required maxLength={2000} /></label>
          <button className="button button-primary" disabled={state.busy}>Confirm received &amp; mark paid</button></form></details>}
      </section>}
      <div className="invoice-paper"><div className="invoice-document-preview" aria-label="Saved invoice preview" dangerouslySetInnerHTML={{ __html: buildInvoiceHtml({ ...selected,
        payment_summary: selected.payment_type === "installments" && selectedRoot ? installmentPaymentSummary(selectedCourseTotal, selected, selectedInstallments) : undefined,
      }, {
        leadName: leadNames.get(selected.lead_id),
        paymentUrl: enrollmentApproved(selected) ? selected.payment_url : null,
        remainingBalance: selected.payment_type === "installments" ? selectedUnallocated : undefined,
      }) }} />
      </div>
        {((selected.tax_review_required && selected.status !== "paid") || selected.pricing_review_note || selected.external_payment_reference) && <div className="invoice-record-meta">
        {selected.tax_review_required && selected.status !== "paid" && <p className="zf-policy-note is-warning">Tax policy review required. An administrator must reconcile existing payment links, recalculate tax, and approve the revised invoice before delivery.</p>}
        {selected.pricing_review_note && <p className="zf-policy-note">{selected.pricing_review_note}</p>}
        {selected.external_payment_reference && <p className="invoice-paper-note"><strong>External payment verified</strong>Reference: {selected.external_payment_reference}<br />Evidence: {selected.external_payment_evidence ?? "Not recorded"}<br />Verified by {person(selected.payment_verified_by)}{selected.payment_verified_at && ` · ${formatDateTime(selected.payment_verified_at)}`}</p>}
        </div>}
      <div className="invoice-detail-footer">{invoiceActions(selected)}</div></section>}
    <section className="panel invoice-register"><div className="panel-heading"><div><h2>{leadId ? "Invoices for this lead" : "Invoice register"}</h2><p>{invoices.length} matching records</p></div></div>
      <div className="table-toolbar"><label className="toolbar-search"><Search size={15} /><input type="search" aria-label="Search invoices" placeholder={leadId ? "Search invoice number" : "Search invoice or lead"} value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label><SearchableDropdown className="invoice-status-filter" ariaLabel="Invoice status" placeholder="All statuses" value={status} onChange={value => { setStatus(value); setPage(0); }} options={[{ value: "", label: "All statuses" }, ...["pending_approval","scheduled","sent","paid","rejected","cancelled","expired"].map(value => ({value,label:statusLabel(value)}))]} /></div>
      <div className="table-wrap"><table className="data-table invoice-table"><thead><tr><th>Invoice / Date</th>{!leadId && <th>Bill to</th>}<th>Current due / Balance</th><th>Status</th><th>Due date</th><th>Actions</th></tr></thead><tbody>{visibleInvoices.map(invoice => <tr key={invoice.id}>
        <td><button className="invoice-number-button" onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}><FileText size={16} /><span>{invoice.invoice_no}<small>{courseName(invoice)}</small><small>{dateLabel(invoice.invoice_date ?? invoice.created_at.slice(0,10))}{invoice.installment_number ? ` · ${installmentLabel(invoice.installment_number)}` : ""}</small></span></button></td>
        {!leadId && <td>{invoice.billing_name || leadNames.get(invoice.lead_id) || "Linked lead"}</td>}
        <td className="amount-cell"><strong>{money(invoice.total,invoice.currency)}</strong>{invoice.payment_type === "installments" && <small>Course balance: {money(invoiceCourseBalance(invoice),invoice.currency)}</small>}</td>
        <td><span className={`invoice-status is-${invoice.status}`}>{statusLabel(invoice.status)}</span>{invoice.delivery_error ? <small className="invoice-overdue">Delivery needs attention</small> : invoice.email_message_id ? <small className="invoice-email-state"><Mail size={11} />Email sent</small> : invoice.status === "pending_approval" ? <small className="invoice-email-state">Sends after approval</small> : null}{invoice.status === "sent" && invoice.due_date && new Date(`${invoice.due_date}T23:59:59`).getTime() < Date.now() && <small className="invoice-overdue">Overdue</small>}</td>
        <td>{dateLabel(invoice.due_date)}</td><td><div className="invoice-table-actions">
          {invoice.payment_url && invoice.status === "sent" && enrollmentApproved(invoice) && <a className="button button-primary" href={invoice.payment_url} target="_blank" rel="noreferrer">Pay Now</a>}
          {approvalAction(invoice)}
          {data?.canCreate && data.installmentParents?.some(parent => parent.id === (invoice.parent_invoice_id ?? invoice.id) && Number(parent.available_balance) >= 1 && !parent.tax_review_required) && <button className="button button-secondary" disabled={state.busy} onClick={() => { const parent = data.installmentParents?.find(row => row.id === (invoice.parent_invoice_id ?? invoice.id)); if (parent) addInstallments(parent); }}>Add next installment</button>}
          {["sent", "scheduled", "expired"].includes(invoice.status) && enrollmentApproved(invoice) && (canRecordPayment(invoice) || data?.canApprove) && <button className="button button-secondary" onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}>Record payment</button>}
          {data?.canApprove && invoice.tax_review_required && ["pending_approval", "sent"].includes(invoice.status) && <button className="button button-secondary" disabled={state.busy} onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}>Review tax before approval</button>}
          <button className="button button-secondary" onClick={() => { setSelectedId(invoice.id); setShowForm(false); }}>Details</button><button className="button button-secondary" disabled={Boolean(downloadingId)} onClick={() => void downloadInvoice(invoice)}>{downloadingId === invoice.id ? "Downloading…" : "PDF"}</button>
        </div></td>
      </tr>)}</tbody></table></div>
      {!state.loading && !invoices.length && !state.error && <div className="invoice-empty"><FileText size={30} /><h3>{search || status ? "No matching invoices" : "No invoices yet"}</h3><p>{search || status ? "Try a different search or status filter." : data?.canCreate ? "Create an invoice to start the approval and collection workflow." : "Invoices issued for accessible leads will appear here."}</p></div>}
      <div className="table-footer workspace-pagination"><span>{invoices.length ? pageIndex * 25 + 1 : 0}&ndash;{Math.min((pageIndex + 1) * 25, invoices.length)} of {invoices.length} invoices</span><div><button className="button button-secondary" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>Previous</button><button className="button button-secondary" disabled={(pageIndex + 1) * 25 >= invoices.length} onClick={() => setPage(pageIndex + 1)}>Next</button></div></div>
      <div className="table-footer">All {leadId ? "lead" : "accessible"} invoices · Payment status refreshes every 15 seconds. Interrupted provider actions remain locked for reconciliation.</div>
    </section>
  </div>;
}
