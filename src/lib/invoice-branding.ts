import type { BillingCompany } from "@/lib/billing";

export function invoiceBranding(company: BillingCompany) {
  const ibmp = company.code === "IBMP";
  return {
    ...company,
    primary_color: ibmp ? "#091b3c" : "#1c1d4e",
    accent_color: ibmp ? "#188574" : "#a91e2c",
    logo: ibmp ? "/IBMP-logo.png" : "/DMHCA-Logo.webp",
  };
}
