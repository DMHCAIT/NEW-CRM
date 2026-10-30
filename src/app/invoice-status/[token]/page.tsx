"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type PaymentStatus = { invoiceNo: string; course: string | null; total: number; currency: string; status: string; paidAt: string | null };

export default function InvoiceStatusPage() {
  const params = useParams<{ token: string }>();
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!params.token) return;
    fetch(`/api/invoice-status/${encodeURIComponent(params.token)}`, { cache: "no-store" })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "Status unavailable.");
        setStatus(payload);
      })
      .catch(() => setError("This invoice status link is invalid or unavailable."));
  }, [params.token]);

  return <main style={{ maxWidth: 560, margin: "10vh auto", padding: 28, background: "white", borderRadius: 12, boxShadow: "0 12px 40px #10204018" }}>
    <p style={{ color: "#53637b", letterSpacing: 1 }}>DMHCA · PAYMENT STATUS</p>
    <h1 style={{ marginBottom: 24 }}>Invoice payment status</h1>
    {error ? <p>{error}</p> : status ? <section>
      <p><strong>Invoice</strong><br />{status.invoiceNo}</p>
      {status.course && <p><strong>Course</strong><br />{status.course}</p>}
      <p><strong>Total</strong><br />{new Intl.NumberFormat("en-IN", { style: "currency", currency: status.currency }).format(status.total)}</p>
      <p><strong>Status</strong><br /><strong>{status.status === "paid" ? "Paid" : status.status === "sent" ? "Awaiting payment" : status.status.replaceAll("_", " ")}</strong></p>
      {status.paidAt && <p>Verified on {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(status.paidAt))}</p>}
      <p>Payment status is updated only after verified confirmation.</p>
    </section> : <p>Loading secure invoice status…</p>}
  </main>;
}
