"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { legacyCompany } from "@/lib/billing";
import { buildInvoiceHtml } from "@/lib/invoice-document";
import { invoiceStatusShouldRefresh } from "@/lib/invoice-policy";
import type { InvoiceDocumentDetails } from "@/lib/billing";
import type { InstallmentPaymentSummary } from "@/lib/invoice-payment-summary";
import type { BillingCompany } from "@/lib/billing";

type PaymentStatus = {
  invoiceNo: string;
  issueDate: string;
  dueDate: string | null;
  billingName: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  items: { description: string; quantity: number; unitPrice: number; amount: number }[];
  subtotal: number;
  discountAmount: number;
  discountReason: string | null;
  taxAmount: number;
  total: number;
  currency: string;
  status: string;
  paidAt: string | null;
  courseTotal: number | null;
  installmentNumber: number | null;
  paymentType: string;
  notes: string | null;
  documentDetails?: Partial<InvoiceDocumentDetails>;
  paymentSummary?: InstallmentPaymentSummary;
  company: { name: string; address: string; taxId: string; code: string; invoiceProfile?: BillingCompany["invoice_profile"] };
  paymentUrl: string | null;
  expiresAt: string | null;
};

export default function InvoiceStatusPage() {
  const params = useParams<{ token: string }>();
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!params.token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loading = false;
    let finished = false;
    const load = async () => {
      if (!active || loading || finished) return;
      clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        timer = setTimeout(load, 2000);
        return;
      }
      loading = true;
      try {
        const response = await fetch(`/api/invoice-status/${encodeURIComponent(params.token)}`, { cache: "no-store" });
        const payload = await response.json();
        if (!response.ok) {
          finished = response.status === 404;
          throw new Error(payload.error ?? "Invoice is unavailable.");
        }
        if (!active) return;
        setStatus(payload);
        setError("");
        finished = !invoiceStatusShouldRefresh(payload.status);
      } catch (error) {
        if (active) setError(error instanceof Error ? error.message : "Invoice status could not be refreshed. Reload this page to retry.");
      } finally {
        loading = false;
        if (active && !finished) timer = setTimeout(load, 2000);
      }
    };
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [params.token]);

  const invoiceHtml = status ? buildInvoiceHtml({
    invoice_no: status.invoiceNo, status: status.status, lead_id: "", created_at: status.issueDate,
    invoice_date: status.issueDate, due_date: status.dueDate,
    billing_name: status.billingName, billing_email: status.billingEmail, billing_address: status.billingAddress,
    invoice_items: status.items.map(item => ({ description: item.description, quantity: item.quantity, unit_price: item.unitPrice, amount: item.amount })),
    subtotal: status.subtotal, discount_amount: status.discountAmount, discount_reason: status.discountReason,
    tax_amount: status.taxAmount, total: status.total, currency: status.currency, notes: status.notes,
    payment_type: status.paymentType, course_total: status.courseTotal, installment_number: status.installmentNumber,
    payment_expires_at: status.expiresAt,
    paid_at: status.paidAt,
    document_details: status.documentDetails,
    payment_summary: status.paymentSummary,
    company_snapshot: { ...legacyCompany, code: status.company.code === "IBMP" ? "IBMP" : "DMHCA",
      legal_name: status.company.name, address: status.company.address, tax_id: status.company.taxId, invoice_profile: status.company.invoiceProfile },
  }, { paymentUrl: status.paymentUrl }) : "";

  return <main style={{ minHeight: "100vh", padding: "24px 12px", background: "#edf1f7" }}>
    {error && <p role="alert">{error}</p>}
    {status ? <div style={{ maxWidth: 820, margin: "0 auto", overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: invoiceHtml }} />
      : !error && <p role="status">Loading invoice…</p>}
  </main>;
}
