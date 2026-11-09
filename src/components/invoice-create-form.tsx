"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { apiRequest } from "@/lib/crm-data";
import { OperationFeedback, formValues, useOperationalData, type LeadOption } from "@/app/integrations/operational-ui";
import type { BillingCompany, Course, InvoiceDocumentDetails } from "@/lib/billing";
import { coursePrice } from "@/lib/billing";
import { invoiceDeadline, invoiceTaxPercent } from "@/lib/invoice-policy";
import { installmentLabel, invoiceDateToday, scheduledDueDate } from "@/lib/invoice-schedule";
import { invoiceBranding } from "@/lib/invoice-branding";
import { buildInvoiceHtml } from "@/lib/invoice-document";

export type InstallmentParent = {
  document_details?: Partial<InvoiceDocumentDetails>;
  company_snapshot?: BillingCompany | null;
  id: string; invoice_no: string; course_total: number; currency: string; balance: number;
  lead_id: string; course_id: string | null; company_code: string | null;
  enrollment_subtotal: number; enrollment_discount: number; enrollment_tax: number;
  tax_percent: number; discount_percent: number; next_installment: number; pending: boolean;
  tax_review_required?: boolean;
  available_balance?: number; already_paid?: number; approval_pending?: boolean;
  course_name?: string;
  installments?: { id: string; invoice_no: string; number: number; amount: number; invoice_date?: string; due_date: string | null; status: string }[];
};
type Billing = {
  lead: { id: string; name: string; email: string; billing_address: string; phone?: string; owner_name?: string; owner_email?: string };
  canSaveAddress: boolean;
};

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const fixed = (value: number) => (Number.isFinite(value) ? value : 0).toFixed(2);
const today = () => new Date().toISOString().slice(0, 10);
const displayDate = (value: string) => value
  ? new Date(`${value}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-")
  : "";

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return <label className="zf-field"><span className="zf-label">{label}{required && <span className="zf-req"> *</span>}</span><span className="zf-control">{children}</span></label>;
}

export function InvoiceCreateForm({ leadId, leads, parents, busy, onSubmit, onClose, enrollment }: {
  leadId?: string; leads: LeadOption[]; parents: InstallmentParent[]; busy: boolean;
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>; onClose: () => void;
  enrollment?: InstallmentParent;
}) {
  const catalog = useOperationalData<{ courses: Course[]; companies: BillingCompany[] }>("/api/courses");
  const [selectedLead, setSelectedLead] = useState(leadId ?? enrollment?.lead_id ?? "");
  const billTo = leadId ?? selectedLead;
  const [billing, setBilling] = useState<Billing | null>(null);
  const [billingError, setBillingError] = useState("");
  const [address, setAddress] = useState("");
  const [courseId, setCourseId] = useState(enrollment?.course_id ?? "");
  const [company, setCompany] = useState(enrollment?.company_code ?? "DMHCA");
  const [currency, setCurrency] = useState(enrollment?.currency ?? "INR");
  const [paymentType, setPaymentType] = useState(enrollment ? "installments" : "one_shot");
  const [parentId, setParentId] = useState(enrollment?.id ?? "");
  const [amount, setAmount] = useState("");
  const [discount, setDiscount] = useState("0");
  const dueDate = invoiceDeadline(new Date().toISOString()).slice(0, 10);
  const [reload, setReload] = useState(0);
  const [invoiceDate, setInvoiceDate] = useState(invoiceDateToday);
  const [extraInstallments, setExtraInstallments] = useState<{ amount: string; invoice_date: string }[]>([]);
  const [detailEdits, setDetailEdits] = useState<{ context: string; values: Partial<InvoiceDocumentDetails> }>({ context: "", values: {} });
  const requestId = useRef("");
  const requestSignature = useRef("");
  useEffect(() => {
    let active = true;
    setBilling(null); setAddress(""); setBillingError("");
    if (billTo) apiRequest<Billing>(`/api/invoices/billing?leadId=${encodeURIComponent(billTo)}`)
      .then(result => { if (active) { setBilling(result); setAddress(result.lead.billing_address ?? ""); } })
      .catch(error => { if (active) setBillingError(error instanceof Error ? error.message : "Billing details could not be loaded."); });
    return () => { active = false; };
  }, [billTo, reload]);

  const isInstallment = paymentType === "installments";
  const eligibleParents = parents.filter(item => item.lead_id === billTo && (
    (item.course_id === courseId && item.company_code === company && item.currency === currency)
    || (!item.course_id && company === "DMHCA" && currency === "INR")));
  const selectedParent = isInstallment ? eligibleParents.find(item => item.id === parentId)
    ?? eligibleParents.find(item => item.course_id === courseId && Boolean(courseId)) : undefined;
  const effectiveParentId = selectedParent?.id ?? "";
  const detailContext = `${billTo}:${effectiveParentId}`;
  const documentDetails: Partial<InvoiceDocumentDetails> = {
    billing_phone: billing?.lead.phone ?? "", ...selectedParent?.document_details,
    ...(detailEdits.context === detailContext ? detailEdits.values : {}),
  };
  const editDetail = (key: keyof InvoiceDocumentDetails, value: string) => setDetailEdits({
    context: detailContext, values: { ...(detailEdits.context === detailContext ? detailEdits.values : {}), [key]: value },
  });
  const legacyParent = selectedParent && !selectedParent.course_id ? selectedParent : null;
  const course = catalog.data?.courses.find(item => item.id === courseId);
  const issuer = selectedParent?.company_snapshot ?? catalog.data?.companies.find(item => item.code === "DMHCA");
  const brand = issuer ? invoiceBranding(issuer) : null;
  const catalogPrice = coursePrice(course, company, currency);
  const standardPrice = Number(selectedParent?.enrollment_subtotal ?? catalogPrice ?? 0);
  const price = standardPrice;
  const discountPercent = selectedParent?.discount_percent ?? (Number(discount) || 0);
  const discountAmount = round(price * discountPercent / 100);
  const effectiveTaxPercent = selectedParent && !selectedParent.tax_review_required ? selectedParent.tax_percent : invoiceTaxPercent(currency);
  const taxAmount = selectedParent && !selectedParent.tax_review_required ? selectedParent.enrollment_tax
    : round((price - discountAmount) * effectiveTaxPercent / 100);
  const total = round(price - discountAmount + taxAmount);
  const hasDiscount = discountPercent > 0 && !selectedParent;
  const balance = selectedParent?.available_balance ?? selectedParent?.balance ?? total;
  const installmentRows = [{ amount, invoice_date: invoiceDate }, ...extraInstallments];
  const currentDue = isInstallment ? round(installmentRows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0)) : total;
  const invalidSchedule = isInstallment && (installmentRows.some((row, index) => !row.invoice_date
    || row.invoice_date < invoiceDateToday() || (index > 0 && row.invoice_date < installmentRows[index - 1].invoice_date)
    || !Number.isFinite(Number(row.amount)) || Number(row.amount) < 1 || round(Number(row.amount)) !== Number(row.amount)));
  const leavesUnpayableBalance = isInstallment && round(balance - currentDue) > 0 && round(balance - currentDue) < 1;
  const format = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(value);
  const courseOptions = (catalog.data?.courses ?? [])
    .filter(item => item.is_active || (isInstallment && parents.some(parent => parent.course_id === item.id && parent.lead_id === billTo)))
    .map(item => ({ value: item.id, label: item.is_active ? item.name : `${item.name} — existing enrollments only` }));
  function resetParent() { setParentId(""); setAmount(""); setExtraInstallments([]); requestId.current = ""; }
  const canSubmit = !busy && !catalog.loading && Boolean(billing) && billing?.lead.id === billTo && Boolean(billing?.lead.email)
    && (Boolean(legacyParent) || Boolean(course && (course.is_active || selectedParent))) && Boolean(issuer?.address) && Boolean(address.trim())
    && standardPrice > 0 && currentDue >= 1 && currentDue <= balance && !selectedParent?.tax_review_required && !leavesUnpayableBalance && !invalidSchedule;
  const previewDue = isInstallment ? Number(amount) || 0 : total;
  const previewSubtotal = isInstallment ? round(total > 0 ? price * previewDue / total : 0) : price;
  const previewDiscount = isInstallment ? round(total > 0 ? discountAmount * previewDue / total : 0) : discountAmount;

  return <section className="panel invoice-editor zf-invoice"><div className="zf-editor-heading"><div className="zf-brand-heading">{brand && <Image src={brand.logo} alt={`${brand.code} logo`} width={60} height={60} unoptimized />}<div><p className="invoice-eyebrow">{issuer?.legal_name ?? "BILLING WORKSPACE"}</p><h2 className="zf-title">{enrollment ? "Add course installments" : "New Proforma Invoice"}</h2><p>Save in CRM. Send to your lead and owner. Track approval and payment in one place.</p></div></div><span className="invoice-status is-sent">4-day payment terms</span></div>
    <ol className="zf-process" aria-label="Invoice process"><li><b>1</b> Invoice details</li><li><b>2</b> Pricing &amp; approval</li><li><b>3</b> Delivery &amp; payment</li></ol>
    <OperationFeedback {...catalog} />
    {billingError && <p role="alert" className="zf-alert">{billingError} <button type="button" className="button button-secondary" onClick={() => setReload(value => value + 1)}>Retry billing details</button></p>}
    <form className="operational-form invoice-form" onSubmit={async event => {
      event.preventDefault();
      const values = formValues(event.currentTarget);
      const payload = { ...values, parent_invoice_id: effectiveParentId, discount_percent: discountPercent,
        document_details: {
          student_id: documentDetails.student_id ?? "", billing_phone: values.detail_billing_phone ?? "",
          place_of_supply: documentDetails.place_of_supply ?? "", course_details: documentDetails.course_details ?? "",
          sac_code: documentDetails.sac_code ?? "",
        },
        ...(isInstallment ? { installments: installmentRows.map(row => ({ amount: Number(row.amount), invoice_date: row.invoice_date })) } : {}),
        tax_percent: effectiveTaxPercent, save_billing_address: values.save_billing_address === "on" };
      if (isInstallment) {
        const signature = JSON.stringify(payload);
        if (!requestId.current || signature !== requestSignature.current) requestId.current = crypto.randomUUID();
        requestSignature.current = signature;
      }
      if (await onSubmit({ ...payload, ...(isInstallment ? { request_id: requestId.current } : {}) })) onClose();
    }}><fieldset className="zf-body" disabled={busy || catalog.loading}>
      <input type="hidden" name="tax_amount" value={fixed(taxAmount)} />
      <input type="hidden" name="payment_type" value={paymentType} />

      <h3 className="zf-section">Proforma Invoice Details</h3>
      <div className="zf-grid">
        <Field label="Proforma Invoice Date" required><input className="zf-input" readOnly value={displayDate(isInstallment ? invoiceDate : today())} aria-label="Proforma Invoice Date" /></Field>
        <Field label="Lead Owner"><input className="zf-input" readOnly value={billing?.lead.owner_name || "—"} aria-label="Lead Owner" /></Field>
        <Field label="Due Date" required><input className="zf-input" name="due_date" type="date" required readOnly value={isInstallment ? invoiceDate ? scheduledDueDate(invoiceDate) : "" : dueDate} aria-label="Due Date" /></Field>
        <Field label="Invoice Company" required><select className="zf-input" name="company_code" value={company} onChange={event => { setCompany(event.target.value); if (event.target.value === "IBMP") setCurrency("USD"); resetParent(); }}><option value="DMHCA">DMHCA</option><option value="IBMP">IBMP</option></select></Field>
      </div>
      <p className="zf-hint">Company selects the course price: DMHCA offers INR and USD; IBMP has its own USD fee. Both use the DMHCA invoice and Razorpay checkout.</p>
      {issuer && !issuer.address && <p className="zf-hint">An administrator must complete this company&apos;s billing address in <a href="/courses">Courses</a>.</p>}

      <h3 className="zf-section">Customer Details</h3>
      <div className="zf-grid">
        <Field label="Lead" required><SearchableDropdown name="lead_id" required disabled={Boolean(leadId)} placeholder="Select a lead" ariaLabel="Invoice lead" value={billTo} onChange={value => { setSelectedLead(value); resetParent(); }} options={leads.map(lead => ({ value: lead.id, label: lead.name }))} /></Field>
        <Field label="Billing Address" required><textarea className="zf-input" name="billing_address" rows={2} maxLength={2000} value={address} required onChange={event => setAddress(event.target.value)} /></Field>
        <Field label="Mobile"><input className="zf-input" name="detail_billing_phone" maxLength={100} value={documentDetails.billing_phone ?? ""} onChange={event => editDetail("billing_phone", event.target.value)} aria-label="Mobile" /></Field>
        {billing?.canSaveAddress ? <label className="zf-field zf-check"><span className="zf-label" /><span className="zf-control"><input type="checkbox" name="save_billing_address" defaultChecked /> Save billing address on this lead</span></label> : <span />}
        <Field label="Email" required><input className="zf-input" readOnly value={billing?.lead.email ?? ""} aria-label="Email" placeholder={billing ? "Set a lead email before issuing" : ""} /></Field>
        <Field label="Owner email"><input className="zf-input" readOnly value={billing?.lead.owner_email ?? ""} aria-label="Owner email" placeholder="Assigned lead owner's email" /></Field>
        <Field label="Currency" required><select className="zf-input" name="currency" value={currency} onChange={event => { setCurrency(event.target.value); resetParent(); }}>{company !== "IBMP" && <option value="INR">INR</option>}<option value="USD">USD</option></select></Field>
      </div>

      <h3 className="zf-section">Payment Details</h3>
      {course && !selectedParent && catalogPrice === null && <p role="alert" className="zf-alert">Set this course&apos;s {company} {currency} price in Courses before issuing an invoice.</p>}
      <h4 className="zf-subsection">Course<span className="zf-req"> *</span></h4>
      <div className="zf-table-wrap"><table className="zf-table">
        <thead><tr><th>Course</th><th>Price</th><th>Discount %</th><th>Discount</th><th>Tax %</th><th>Tax Amount</th><th>Total</th></tr></thead>
        <tbody><tr>
          <td className="zf-course-cell"><SearchableDropdown name="course_id" required={!legacyParent} disabled={Boolean(legacyParent)} placeholder={legacyParent ? "Historical enrollment" : "-Select-"} ariaLabel="Invoice course" value={courseId} onChange={value => { setCourseId(value); resetParent(); }} options={courseOptions} /></td>
          <td><input className="zf-input" readOnly value={fixed(price)} aria-label="Price" /></td>
          <td><span className="zf-suffix"><input className="zf-input" name="discount_percent" type="number" min={0} max={100} step="0.01" required readOnly={Boolean(selectedParent)} value={discountPercent} onChange={event => setDiscount(event.target.value)} aria-label="Discount %" /><b>%</b></span></td>
          <td><input className="zf-input" readOnly value={fixed(discountAmount)} aria-label="Discount" /></td>
          <td><span className="zf-suffix"><input className="zf-input" name="tax_percent" type="number" readOnly value={effectiveTaxPercent} aria-label="Tax %" /><b>%</b></span></td>
          <td><input className="zf-input" readOnly value={fixed(taxAmount)} aria-label="Tax Amount" /></td>
          <td><input className="zf-input" readOnly value={fixed(total)} aria-label="Line Total" /></td>
        </tr></tbody>
      </table></div>
      {!catalog.loading && !catalog.data?.courses.some(item => item.is_active) && <p className="zf-hint">No active courses. Ask an administrator to add course prices in <a href="/courses">Courses</a>.</p>}
      {course && <p className="zf-hint">{selectedParent ? "Original enrollment total" : "Standard course fee"}: <strong>{format(standardPrice)}</strong></p>}
      <p className="zf-policy-note">Tax is set automatically: INR 18% GST / USD 0%. {selectedParent && selectedParent.tax_percent !== invoiceTaxPercent(currency) && !selectedParent.tax_review_required ? "This historical enrollment retains its previously paid tax agreement." : "Tax cannot be edited."} {isInstallment ? "Each payment window starts at 9:00 AM India time on its invoice date and closes four days later." : "Payment links close 96 hours after invoice creation; approval does not extend the deadline."}</p>

      <div className="zf-grid zf-summary">
        <Field label="Total Price"><input className="zf-input" readOnly value={fixed(price)} aria-label="Total Price" /></Field>
        <Field label="Discount Approved"><input className="zf-input" readOnly value={hasDiscount || selectedParent?.approval_pending ? "Pending admin approval" : selectedParent && discountPercent > 0 ? "Original enrollment approved" : "Not required"} aria-label="Discount Approved" /></Field>
        <Field label="Total Tax"><input className="zf-input" readOnly value={fixed(taxAmount)} aria-label="Total Tax" /></Field>
        <Field label="Average Discount %"><span className="zf-suffix"><input className="zf-input" readOnly value={discountPercent.toFixed(1)} aria-label="Average Discount %" /><b>%</b></span></Field>
        <Field label="Approver"><input className="zf-input" readOnly value={hasDiscount ? "Admin / Super Admin" : "Not required"} aria-label="Approver" /></Field>
        <Field label="Total Discount"><input className="zf-input" readOnly value={fixed(discountAmount)} aria-label="Total Discount" /></Field>
        {hasDiscount ? <Field label="Discount Reason" required><input className="zf-input" name="discount_reason" maxLength={1000} required /></Field> : <span />}
        <Field label="Full Course Total"><input className="zf-input zf-strong" readOnly value={fixed(total)} aria-label="Total Amount" /></Field>
        <Field label="Is Loan Payment" required><select className="zf-input" value={paymentType === "loan" ? "yes" : "no"} aria-label="Is Loan Payment" onChange={event => { setPaymentType(event.target.value === "yes" ? "loan" : "one_shot"); resetParent(); }}><option value="no">No</option><option value="yes">Yes</option></select></Field>
        {paymentType !== "loan" ? <Field label="Payment Type" required><select className="zf-input" value={paymentType} aria-label="Payment Type" onChange={event => { setPaymentType(event.target.value); resetParent(); }}><option value="one_shot">Full payment</option><option value="installments">Installment</option><option value="emi">EMI — externally financed</option></select></Field> : <span />}
        {isInstallment && <>
          <Field label="Course enrollment"><select className="zf-input" name="parent_invoice_id" value={effectiveParentId} onChange={event => { setParentId(event.target.value); if (!parents.find(item => item.id === event.target.value)?.course_id) setCourseId(""); setAmount(""); setExtraInstallments([]); requestId.current = ""; }}><option value="">{selectedParent ? "Continue the selected course enrollment" : "First installment / new course enrollment"}</option>{eligibleParents.map(item => <option key={item.id} value={item.id}>{item.course_name ?? item.invoice_no} — {format(item.balance)} remaining{!item.course_id ? " — historical DMHCA enrollment" : ""}</option>)}</select></Field>
        </>}
      </div>
      {isInstallment && <><section className="zf-installment-plan" aria-label="Installment schedule">
        <div className="panel-heading"><div><h3>{selectedParent?.course_name ? `${selectedParent.course_name} - installments` : "Installment schedule"}</h3><p>Create one or more installments now. Add further installments to this same course later.</p></div>
          <button type="button" className="button button-secondary" disabled={busy || installmentRows.length >= 36 || balance < installmentRows.length + 1} onClick={() => { requestId.current = ""; setExtraInstallments(rows => [...rows, { amount: "", invoice_date: rows.at(-1)?.invoice_date ?? invoiceDate }]); }}>+ Add installment</button></div>
        <div className="zf-table-wrap"><table className="zf-table zf-installment-table"><thead><tr><th>Installment</th><th>Amount (including tax)</th><th>Invoice / email date</th><th>Due date (+4 days)</th><th /></tr></thead><tbody>
          {selectedParent?.installments?.map(row => <tr key={row.id} className="zf-saved-installment"><td><strong>{installmentLabel(row.number)}</strong><small>{row.invoice_no}</small></td><td>{format(row.amount)}</td><td>{row.invoice_date ? displayDate(row.invoice_date) : "Not recorded"}</td><td>{row.due_date ? displayDate(row.due_date) : "Not recorded"}</td><td>{row.status === "sent" ? "Awaiting payment" : row.status.replaceAll("_", " ")}</td></tr>)}
          {balance > 0 && installmentRows.map((row, index) => <tr key={index}><td><strong>{installmentLabel((selectedParent?.next_installment ?? 1) + index)}</strong><small>New</small></td>
            <td><input className="zf-input" type="number" min={1} max={balance} step="0.01" required aria-label={`Installment ${(selectedParent?.next_installment ?? 1) + index} amount`} value={row.amount} onChange={event => { requestId.current = ""; if (index === 0) setAmount(event.target.value); else setExtraInstallments(rows => rows.map((item, position) => position === index - 1 ? { ...item, amount: event.target.value } : item)); }} /></td>
            <td><input className="zf-input" type="date" min={index === 0 ? invoiceDateToday() : installmentRows[index - 1].invoice_date} required aria-label={`Installment ${(selectedParent?.next_installment ?? 1) + index} invoice date`} value={row.invoice_date} onChange={event => { requestId.current = ""; if (index === 0) setInvoiceDate(event.target.value); else setExtraInstallments(rows => rows.map((item, position) => position === index - 1 ? { ...item, invoice_date: event.target.value } : item)); }} /></td>
            <td><input className="zf-input" readOnly aria-label={`Installment ${(selectedParent?.next_installment ?? 1) + index} due date`} value={row.invoice_date ? displayDate(scheduledDueDate(row.invoice_date)) : ""} /></td>
            <td>{index > 0 && <button type="button" className="button button-secondary" aria-label={`Remove installment ${index + 1}`} onClick={() => { requestId.current = ""; setExtraInstallments(rows => rows.filter((_, position) => position !== index - 1)); }}>Remove</button>}</td></tr>)}
        </tbody></table></div>
        <p className="zf-hint">Emails are scheduled at 9:00 AM Asia/Kolkata, even if an earlier installment is unpaid. Discount approval is requested once for the enrollment; scheduled emails wait for that approval. A running delivery scheduler is required.</p>
        {balance === 0 && <p role="status" className="zf-policy-note">This course is fully allocated. Pay the existing installments; creating another invoice will not create another course balance.</p>}
        {currentDue > balance && <p role="alert" className="zf-alert">Installments exceed the available course balance by {format(round(currentDue - balance))}.</p>}
        {installmentRows.length === 36 && <p className="zf-hint">Save these 36 rows, then add more installments to the same course. There is no lifetime installment-count limit; the course balance is the limit.</p>}
      </section><dl className="zf-payment-summary">{[
        ["Full course total", total], ["Already paid", selectedParent?.already_paid ?? round(total - (selectedParent?.balance ?? total))], ["Available to schedule", balance],
        ["Scheduled in this plan", currentDue], ["Unallocated balance", Math.max(0, round(balance - currentDue))],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(Number(value))}</dd></div>)}</dl>
        <p className={`zf-policy-note${selectedParent?.pending || selectedParent?.tax_review_required ? " is-warning" : ""}`}>
          {selectedParent?.tax_review_required ? "Admin tax review is required for this enrollment. Open the original invoice to review and approve the corrected pricing."
            : "Existing unpaid and scheduled installments reserve their amounts. New plans cannot exceed the unallocated course balance. Approved enrollment discounts carry forward without another approval."}
        </p></>}
      {leavesUnpayableBalance && <p role="alert" className="zf-alert">Include the remaining balance in this payment; online providers require at least one currency unit per installment.</p>}
      {["loan", "emi"].includes(paymentType) && <p className="zf-hint">Finance must verify the external disbursement with a reference and evidence. No online payment is collected for this arrangement.</p>}
      {issuer && (course || legacyParent) && <details className="zf-preview"><summary>Preview branded invoice{isInstallment ? " - first new installment" : ""}</summary>
        <p className="zf-hint">The email and saved CRM invoice use this layout. Invoice numbers are assigned on save; each installment has its own invoice.</p>
        <div className="invoice-document-preview" dangerouslySetInnerHTML={{ __html: buildInvoiceHtml({
          invoice_no: "Assigned on save", lead_id: billTo, created_at: new Date().toISOString(),
          invoice_date: isInstallment ? invoiceDate || null : today(), due_date: isInstallment ? invoiceDate ? scheduledDueDate(invoiceDate) : null : dueDate,
          status: hasDiscount || selectedParent?.approval_pending ? "pending_approval" : isInstallment && invoiceDate > invoiceDateToday() ? "scheduled" : "sent",
          company_snapshot: issuer, billing_name: billing?.lead.name, billing_email: billing?.lead.email, billing_address: address,
          document_details: documentDetails,
          payment_summary: isInstallment ? {
            courseTotal: total,
            paidToDate: selectedParent?.already_paid ?? round(total - (selectedParent?.balance ?? total)),
            outstanding: selectedParent?.balance ?? total,
            balanceAfterPayment: Math.max(0, round((selectedParent?.balance ?? total) - previewDue)),
            schedule: [
              ...(selectedParent?.installments ?? []).map(row => ({ number: row.number, amount: row.amount, dueDate: row.due_date, status: row.status, current: false })),
              ...installmentRows.map((row, index) => ({ number: (selectedParent?.next_installment ?? 1) + index, amount: Number(row.amount) || 0, dueDate: row.invoice_date ? scheduledDueDate(row.invoice_date) : null, status: hasDiscount || selectedParent?.approval_pending ? "pending_approval" : "scheduled", current: index === 0 })),
            ],
          } : undefined,
          invoice_items: [{ description: course?.name ?? legacyParent?.course_name ?? "Historical enrollment", quantity: 1, unit_price: previewSubtotal, amount: previewSubtotal }],
          subtotal: previewSubtotal, discount_amount: previewDiscount, discount_reason: null,
          tax_amount: round(previewDue - previewSubtotal + previewDiscount), total: previewDue, currency, notes: null,
          payment_type: paymentType, course_total: total, installment_number: isInstallment ? selectedParent?.next_installment ?? 1 : null,
        }) }} /></details>}

    </fieldset><div className="invoice-form-footer zf-footer"><p>{hasDiscount ? "Discount requested: Admin / Super Admin must approve before the invoice and payment link are emailed." : isInstallment ? "Today's installments are emailed on Save with a Pay Now button, with the creator and assigned owner copied. Future dates remain scheduled." : "Automatically emailed to the lead, with the creator and assigned owner copied."}</p>
      <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="button button-primary" disabled={!canSubmit}>{busy ? "Saving..." : hasDiscount || selectedParent?.approval_pending ? "Save & request approval" : isInstallment ? "Save installment plan" : "Save & send invoice"}</button>
    </div></form>
  </section>;
}
