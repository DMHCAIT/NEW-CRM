import type { BillingCompany } from "@/lib/billing";

export function invoiceBranding(company: BillingCompany) {
  return {
    ...company,
    code: "DMHCA" as const,
    legal_name: "NEWDELHI MEDICAL HEALTH CARE PVT. LTD.",
    primary_color: "#1c1d4e",
    accent_color: "#c44754",
    logo: "/DMHCA-invoice-wordmark.png",
  };
}
