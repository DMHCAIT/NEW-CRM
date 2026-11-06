"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

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
  company: { name: string; address: string; taxId: string; code: string };
  primaryColor: string;
  accentColor: string;
  paymentUrl: string | null;
  expiresAt: string | null;
};

const dateLabel = (value: string | null) => value
  ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value))
  : "On receipt";

const money = (value: number, currency: string) => new Intl.NumberFormat("en-IN", {
  style: "currency", currency,
}).format(value);

function statusLabel(status: string) {
  return ({ paid: "Paid", sent: "Awaiting payment", pending_approval: "Pending approval",
    pending_review: "Pending finance review" } as Record<string, string>)[status] ?? status.replaceAll("_", " ");
}

export default function InvoiceStatusPage() {
  const params = useParams<{ token: string }>();
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState("");

  useEffect(() => {
    if (!params.token) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => fetch(`/api/invoice-status/${encodeURIComponent(params.token)}`, { cache: "no-store" })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Invoice is unavailable.");
        if (!active) return;
        setStatus(payload);
        setError("");
        if (["sent", "pending_approval", "pending_review"].includes(payload.status)) timer = setTimeout(load, 10000);
      })
      .catch(() => { if (active) setError("Invoice status could not be refreshed. Reload this page to retry."); });
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [params.token]);

  const logo = status?.company.code === "IBMP" ? "/IBMP-logo.png" : "/DMHCA-Logo.webp";

  return <main style={{ minHeight: "100vh", padding: "32px 16px", background: "#f3f6fb" }}>
    <article style={{ maxWidth: 820, margin: "0 auto", overflow: "hidden", background: "white", borderRadius: 12, boxShadow: "0 12px 40px #10204018" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 18, padding: "22px 28px", color: "white", background: status?.primaryColor ?? "#1c1d4e", borderBottom: `5px solid ${status?.accentColor ?? "#a91e2c"}` }}>
        <img src={logo} alt="" style={{ width: 76, maxHeight: 72, objectFit: "contain", background: "white", borderRadius: 4, padding: 4 }} />
        <div><strong>{status?.company.name ?? "INVOICE"}</strong><div style={{ marginTop: 5, fontSize: 13 }}>INVOICE</div></div>
      </header>
      <div style={{ padding: "28px clamp(18px, 5vw, 42px)" }}>
        {error ? <p role="alert">{error}</p> : status ? <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16 }}>
            <div><h1 style={{ margin: "0 0 8px", fontSize: 24 }}>Invoice {status.invoiceNo}</h1>
              <p style={{ margin: 0, color: "#566579" }}>Issued {dateLabel(status.issueDate)}{status.installmentNumber ? ` · Installment ${status.installmentNumber}` : ""}</p>
            </div>
            <strong role="status" style={{ padding: "8px 12px", borderRadius: 6, color: status.status === "paid" ? "#17663d" : "#334966", background: status.status === "paid" ? "#e8f7ef" : "#edf3fb" }}>
              {statusLabel(status.status)}
            </strong>
          </div>

          <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 24, margin: "30px 0" }}>
            <div><h2 style={{ margin: "0 0 10px", fontSize: 13, color: "#64748b" }}>BILL TO</h2>
              <strong>{status.billingName || "Customer"}</strong>
              {status.billingAddress && <p style={{ whiteSpace: "pre-line", margin: "7px 0" }}>{status.billingAddress}</p>}
              {status.billingEmail && <p style={{ margin: "7px 0", overflowWrap: "anywhere" }}>{status.billingEmail}</p>}
            </div>
            <div><h2 style={{ margin: "0 0 10px", fontSize: 13, color: "#64748b" }}>FROM</h2>
              <strong>{status.company.name}</strong>
              {status.company.address && <p style={{ whiteSpace: "pre-line", margin: "7px 0" }}>{status.company.address}</p>}
              {status.company.taxId && <p style={{ margin: "7px 0" }}>Tax ID: {status.company.taxId}</p>}
            </div>
            <div><h2 style={{ margin: "0 0 10px", fontSize: 13, color: "#64748b" }}>PAYMENT DETAILS</h2>
              <p style={{ margin: "7px 0" }}>Due date: {dateLabel(status.dueDate)}</p>
              {status.expiresAt && <p style={{ margin: "7px 0" }}>Payment deadline: {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(status.expiresAt))}</p>}
              {status.paidAt && <p style={{ margin: "7px 0" }}>Verified: {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(status.paidAt))}</p>}
            </div>
          </section>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 540, textAlign: "left" }}>
              <thead><tr style={{ color: "white", background: status.accentColor }}>
                {["Description", "Quantity", "Unit price", "Amount"].map(label => <th key={label} style={{ padding: 11, fontSize: 13 }}>{label}</th>)}
              </tr></thead>
              <tbody>{status.items.map((item, index) => <tr key={`${item.description}-${index}`} style={{ borderBottom: "1px solid #e5eaf1" }}>
                <td style={{ padding: 11, whiteSpace: "pre-line" }}>{item.description}</td>
                <td style={{ padding: 11 }}>{item.quantity}</td>
                <td style={{ padding: 11 }}>{money(item.unitPrice, status.currency)}</td>
                <td style={{ padding: 11 }}>{money(item.amount, status.currency)}</td>
              </tr>)}</tbody>
            </table>
          </div>

          <section style={{ maxWidth: 340, margin: "18px 0 0 auto" }}>
            {[["Subtotal", status.subtotal], ["Discount", -status.discountAmount], ["Tax", status.taxAmount]].map(([label, amount]) =>
              <div key={label as string} style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "7px 0" }}>
                <span>{label}{label === "Discount" && status.discountReason ? ` · ${status.discountReason}` : ""}</span>
                <span>{money(Number(amount), status.currency)}</span>
              </div>)}
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, padding: "12px 0", marginTop: 5, borderTop: "2px solid #dce3ed", fontSize: 18, fontWeight: 700 }}>
              <span>{status.paymentType === "installments" ? "Installment due" : "Total due"}</span><span>{money(status.total, status.currency)}</span>
            </div>
            {status.courseTotal != null && status.paymentType === "installments" && <p style={{ textAlign: "right", color: "#64748b" }}>Full course value: {money(status.courseTotal, status.currency)}</p>}
          </section>

          {status.notes && <section style={{ marginTop: 24 }}><h2 style={{ fontSize: 14 }}>NOTES</h2><p style={{ whiteSpace: "pre-line" }}>{status.notes}</p></section>}
          {status.status === "paid" ? <p style={{ marginTop: 28, padding: 14, borderRadius: 6, color: "#17663d", background: "#e8f7ef", fontWeight: 600 }}>Payment verified. This invoice is paid; no further payment is required.</p>
            : status.status === "expired" ? <p role="status">The payment window has expired. Contact your lead owner for a new invoice.</p>
            : status.status === "pending_review" ? <p role="status">Finance is reviewing the invoice. Payment is unavailable until review is complete.</p>
            : status.status === "sent" && status.paymentUrl ? status.currency === "USD"
              ? <button className="button button-primary" disabled={paying} onClick={async () => {
                setPaying(true); setPaymentError("");
                try {
                  const response = await fetch(`/api/invoice-status/${encodeURIComponent(params.token)}`, { method: "POST", headers: { "Content-Type": "application/json" } });
                  const payload = await response.json();
                  if (!response.ok) throw new Error(payload.error ?? "Checkout is unavailable.");
                  window.location.assign(payload.url);
                } catch (failure) { setPaymentError(failure instanceof Error ? failure.message : "Checkout could not be opened."); }
                finally { setPaying(false); }
              }}>{paying ? "Opening secure checkout..." : "Pay securely with Stripe"}</button>
              : <a className="button button-primary" href={status.paymentUrl}>Pay securely with Razorpay</a>
            : status.status === "sent" && ["loan", "emi"].includes(status.paymentType)
              ? <p>Payment is arranged through {status.paymentType.toUpperCase()} financing. Finance will update this status after verifying the disbursement.</p>
              : <p role="status">Payment is unavailable until the invoice is approved and ready for payment.</p>}
          {paymentError && <p role="alert">{paymentError}</p>}
          <p style={{ marginTop: 18, color: "#64748b", fontSize: 13 }}>This page updates automatically. Payment is marked paid only after verified confirmation.</p>
        </> : <p>Loading invoice…</p>}
      </div>
    </article>
  </main>;
}
