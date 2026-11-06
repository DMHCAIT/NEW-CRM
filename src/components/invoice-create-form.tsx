"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SearchableDropdown } from "@/components/searchable-dropdown";
import { apiRequest } from "@/lib/crm-data";
import { OperationFeedback, formValues, useOperationalData, type LeadOption } from "@/app/integrations/operational-ui";
import type { BillingCompany, Course } from "@/lib/billing";
import { invoiceDeadline, invoiceTaxPercent } from "@/lib/invoice-policy";

export type InstallmentParent = {
  id: string; invoice_no: string; course_total: number; currency: string; balance: number;
  lead_id: string; course_id: string | null; company_code: string | null;
  enrollment_subtotal: number; enrollment_discount: number; enrollment_tax: number;
  tax_percent: number; discount_percent: number; next_installment: number; pending: boolean;
  tax_review_required?: boolean;
};
type Billing = {
  lead: { id: string; name: string; email: string; billing_address: string; phone?: string; owner_name?: string };
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

export function InvoiceCreateForm({ leadId, leads, parents, busy, onSubmit, onClose }: {
  leadId?: string; leads: LeadOption[]; parents: InstallmentParent[]; busy: boolean;
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>; onClose: () => void;
}) {
  const catalog = useOperationalData<{ courses: Course[]; companies: BillingCompany[] }>("/api/courses");
  const [selectedLead, setSelectedLead] = useState(leadId ?? "");
  const billTo = leadId ?? selectedLead;
  const [billing, setBilling] = useState<Billing | null>(null);
  const [billingError, setBillingError] = useState("");
  const [address, setAddress] = useState("");
  const [courseId, setCourseId] = useState("");
  const [company, setCompany] = useState("DMHCA");
  const [currency, setCurrency] = useState("INR");
  const [paymentType, setPaymentType] = useState("one_shot");
  const [parentId, setParentId] = useState("");
  const [amount, setAmount] = useState("");
  const [discount, setDiscount] = useState("0");
  const dueDate = invoiceDeadline(new Date().toISOString()).slice(0, 10);
  const [reload, setReload] = useState(0);
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
  const legacyParent = selectedParent && !selectedParent.course_id ? selectedParent : null;
  const course = catalog.data?.courses.find(item => item.id === courseId);
  const issuer = catalog.data?.companies.find(item => item.code === company);
  const standardPrice = Number(selectedParent?.enrollment_subtotal ?? (currency === "USD" ? course?.price_usd ?? 0 : course?.price_inr ?? 0));
  const price = standardPrice;
  const discountPercent = selectedParent?.discount_percent ?? (Number(discount) || 0);
  const discountAmount = round(price * discountPercent / 100);
  const effectiveTaxPercent = selectedParent && !selectedParent.tax_review_required ? selectedParent.tax_percent : invoiceTaxPercent(currency);
  const taxAmount = selectedParent && !selectedParent.tax_review_required ? selectedParent.enrollment_tax
    : round((price - discountAmount) * effectiveTaxPercent / 100);
  const total = round(price - discountAmount + taxAmount);
  const hasDiscount = discountPercent > 0 && !selectedParent;
  const balance = selectedParent?.tax_review_required
    ? round(total - (selectedParent.course_total - selectedParent.balance)) : selectedParent?.balance ?? total;
  const currentDue = isInstallment ? Number(amount) || 0 : total;
  const leavesUnpayableBalance = isInstallment && round(balance - currentDue) > 0 && round(balance - currentDue) < 1;
  const format = (value: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(value);
  const courseOptions = (catalog.data?.courses ?? [])
    .filter(item => item.is_active || (isInstallment && parents.some(parent => parent.course_id === item.id && parent.lead_id === billTo)))
    .map(item => ({ value: item.id, label: item.is_active ? item.name : `${item.name} — existing enrollments only` }));
  function resetParent() { setParentId(""); setAmount(""); }
  const canSubmit = !busy && !catalog.loading && Boolean(billing) && billing?.lead.id === billTo && Boolean(billing?.lead.email)
    && (Boolean(legacyParent) || Boolean(course && (course.is_active || selectedParent))) && Boolean(issuer?.address) && Boolean(address.trim())
    && currentDue >= 1 && currentDue <= balance && !selectedParent?.pending && !selectedParent?.tax_review_required && !leavesUnpayableBalance;

  return <section className="panel invoice-editor zf-invoice"><div className="zf-editor-heading"><div><p className="invoice-eyebrow">BILLING WORKSPACE</p><h2 className="zf-title">New Proforma Invoice</h2><p>Confirm the course agreement, request any discount approval, then collect payment securely.</p></div><span className="invoice-status is-sent">4-day payment terms</span></div>
    <ol className="zf-process" aria-label="Invoice process"><li><b>1</b> Invoice details</li><li><b>2</b> Pricing &amp; approval</li><li><b>3</b> Delivery &amp; payment</li></ol>
    <OperationFeedback {...catalog} />
    {billingError && <p role="alert" className="zf-alert">{billingError} <button type="button" className="button button-secondary" onClick={() => setReload(value => value + 1)}>Retry billing details</button></p>}
    <form className="operational-form invoice-form" onSubmit={async event => {
      event.preventDefault();
      const values = formValues(event.currentTarget);
      if (await onSubmit({ ...values, parent_invoice_id: effectiveParentId, discount_percent: discountPercent,
        tax_percent: effectiveTaxPercent, save_billing_address: values.save_billing_address === "on" })) onClose();
    }}><fieldset className="zf-body" disabled={busy || catalog.loading}>
      <input type="hidden" name="tax_amount" value={fixed(taxAmount)} />
      <input type="hidden" name="payment_type" value={paymentType} />

      <h3 className="zf-section">Proforma Invoice Details</h3>
      <div className="zf-grid">
        <Field label="Proforma Invoice Date" required><input className="zf-input" readOnly value={displayDate(today())} aria-label="Proforma Invoice Date" /></Field>
        <Field label="Lead Owner"><input className="zf-input" readOnly value={billing?.lead.owner_name || "—"} aria-label="Lead Owner" /></Field>
        <Field label="Due Date" required><input className="zf-input" name="due_date" type="date" required readOnly value={dueDate} aria-label="Due Date" /></Field>
        <Field label="Invoice Company" required><select className="zf-input" name="company_code" value={company} onChange={event => { setCompany(event.target.value); resetParent(); }}><option value="DMHCA">DMHCA</option><option value="IBMP">IBMP</option></select></Field>
      </div>
      {issuer && !issuer.address && <p className="zf-hint">An administrator must complete this company&apos;s billing address in <a href="/courses">Courses</a>.</p>}

      <h3 className="zf-section">Customer Details</h3>
      <div className="zf-grid">
        <Field label="Lead" required><SearchableDropdown name="lead_id" required disabled={Boolean(leadId)} placeholder="Select a lead" ariaLabel="Invoice lead" value={billTo} onChange={value => { setSelectedLead(value); resetParent(); }} options={leads.map(lead => ({ value: lead.id, label: lead.name }))} /></Field>
        <Field label="Billing Address" required><textarea className="zf-input" name="billing_address" rows={2} maxLength={2000} value={address} required onChange={event => setAddress(event.target.value)} /></Field>
        <Field label="Mobile" required><input className="zf-input" readOnly value={billing?.lead.phone ?? ""} aria-label="Mobile" /></Field>
        {billing?.canSaveAddress ? <label className="zf-field zf-check"><span className="zf-label" /><span className="zf-control"><input type="checkbox" name="save_billing_address" defaultChecked /> Save billing address on this lead</span></label> : <span />}
        <Field label="Email" required><input className="zf-input" readOnly value={billing?.lead.email ?? ""} aria-label="Email" placeholder={billing ? "Set a lead email before issuing" : ""} /></Field>
        <span />
        <Field label="Currency" required><select className="zf-input" name="currency" value={currency} onChange={event => { setCurrency(event.target.value); resetParent(); }}><option value="INR">INR</option><option value="USD">USD</option></select></Field>
      </div>

      <h3 className="zf-section">Payment Details</h3>
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
      <p className="zf-policy-note">Tax is set automatically: INR 18% GST / USD 0%. {selectedParent && selectedParent.tax_percent !== invoiceTaxPercent(currency) && !selectedParent.tax_review_required ? "This historical enrollment retains its previously paid tax agreement." : "Tax cannot be edited."} Payment links close 96 hours after invoice creation; approval does not extend the deadline.</p>

      <div className="zf-grid zf-summary">
        <Field label="Total Price"><input className="zf-input" readOnly value={fixed(price)} aria-label="Total Price" /></Field>
        <Field label="Discount Approved"><input className="zf-input" readOnly value={hasDiscount ? "Pending admin approval" : selectedParent && discountPercent > 0 ? "Original enrollment approved" : "Not required"} aria-label="Discount Approved" /></Field>
        <Field label="Total Tax"><input className="zf-input" readOnly value={fixed(taxAmount)} aria-label="Total Tax" /></Field>
        <Field label="Average Discount %"><span className="zf-suffix"><input className="zf-input" readOnly value={discountPercent.toFixed(1)} aria-label="Average Discount %" /><b>%</b></span></Field>
        <Field label="Approver"><input className="zf-input" readOnly value={hasDiscount ? "Admin / Super Admin" : "Not required"} aria-label="Approver" /></Field>
        <Field label="Total Discount"><input className="zf-input" readOnly value={fixed(discountAmount)} aria-label="Total Discount" /></Field>
        {hasDiscount ? <Field label="Discount Reason" required><input className="zf-input" name="discount_reason" maxLength={1000} required /></Field> : <span />}
        <Field label="Full Course Total"><input className="zf-input zf-strong" readOnly value={fixed(total)} aria-label="Total Amount" /></Field>
        <Field label="Is Loan Payment" required><select className="zf-input" value={paymentType === "loan" ? "yes" : "no"} aria-label="Is Loan Payment" onChange={event => { setPaymentType(event.target.value === "yes" ? "loan" : "one_shot"); resetParent(); }}><option value="no">No</option><option value="yes">Yes</option></select></Field>
        {paymentType !== "loan" ? <Field label="Payment Type" required><select className="zf-input" value={paymentType} aria-label="Payment Type" onChange={event => { setPaymentType(event.target.value); resetParent(); }}><option value="one_shot">Full payment</option><option value="installments">Installment</option><option value="emi">EMI — externally financed</option></select></Field> : <span />}
        {isInstallment && <>
          <Field label="Original Invoice"><select className="zf-input" name="parent_invoice_id" value={effectiveParentId} onChange={event => { setParentId(event.target.value); if (!parents.find(item => item.id === event.target.value)?.course_id) setCourseId(""); setAmount(""); }}><option value="">First installment / new enrollment</option>{eligibleParents.map(item => <option key={item.id} value={item.id}>{item.invoice_no} — {format(item.balance)} remaining{!item.course_id ? " — historical DMHCA enrollment" : ""}</option>)}</select></Field>
          <Field label={`Installment ${selectedParent?.next_installment ?? 1} Amount (including tax)`} required><input className="zf-input" name="installment_amount" type="number" min={1} max={balance} step="0.01" required value={amount} onChange={event => setAmount(event.target.value)} /></Field>
        </>}
      </div>
      {isInstallment && <><dl className="zf-payment-summary">{[
        ["Full course total", total], ["Already paid", round(total - balance)], ["Remaining balance", balance],
        ["This installment", currentDue], ["Balance after payment", Math.max(0, round(balance - currentDue))],
      ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{format(Number(value))}</dd></div>)}</dl>
        <p className={`zf-policy-note${selectedParent?.pending || selectedParent?.tax_review_required ? " is-warning" : ""}`}>
          {selectedParent?.tax_review_required ? "Admin tax review is required for this enrollment. Open the original invoice to review and approve the corrected pricing."
            : selectedParent?.pending ? "An installment is awaiting payment or approval. Complete it before creating the next. If its payment window expired, ask an admin to reconcile and close it first."
              : "Only one unpaid installment is permitted at a time. Confirmed payments automatically reduce the remaining balance."}
        </p></>}
      {leavesUnpayableBalance && <p role="alert" className="zf-alert">Include the remaining balance in this payment; online providers require at least one currency unit per installment.</p>}
      {["loan", "emi"].includes(paymentType) && <p className="zf-hint">Finance must verify the external disbursement with a reference and evidence. No online payment is collected for this arrangement.</p>}

      <h3 className="zf-section">Additional Details</h3>
      <div className="zf-grid"><Field label="Notes"><textarea className="zf-input" name="notes" maxLength={3000} rows={3} /></Field></div>
    </fieldset><div className="invoice-form-footer zf-footer"><p>{hasDiscount ? "Discount requested: Admin / Super Admin must approve before the invoice and payment link are emailed." : "Automatically emailed to the lead, with the creator and assigned owner copied."}</p>
      <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="button button-primary" disabled={!canSubmit}>{busy ? "Saving..." : hasDiscount ? "Save & request approval" : "Save"}</button>
    </div></form>
  </section>;
}
