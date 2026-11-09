import { z } from "zod";

const price = z.coerce.number().finite().min(1).max(99999999)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, "Use at most two decimal places.");
const optionalUrl = z.string().trim().max(2000).refine(value => {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}, "Use a secure HTTPS URL.");
export const invoiceCompanyProfile = z.object({
  billing_email: z.union([z.literal(""), z.string().trim().email().max(254)]).default(""),
  phone: z.string().trim().max(100).default(""),
  website: optionalUrl.default(""),
  refund_policy_url: optionalUrl.default(""),
  bank_accounts: z.array(z.object({
    account_name: z.string().trim().min(1).max(200),
    bank_name: z.string().trim().min(1).max(100),
    account_number: z.string().trim().min(1).max(100),
    ifsc: z.string().trim().max(30).default(""),
    branch: z.string().trim().min(1).max(200),
    swift: z.string().trim().max(30).default(""),
  }).refine(bank => Boolean(bank.ifsc || bank.swift), "Enter an IFSC or SWIFT / BIC code.")).max(4).default([]),
});
export const invoiceDocumentDetails = z.object({
  student_id: z.string().trim().max(100).default(""),
  billing_phone: z.string().trim().max(100).default(""),
  place_of_supply: z.string().trim().max(200).default(""),
  course_details: z.string().trim().max(300).default(""),
  sac_code: z.string().trim().max(30).default(""),
});
export type InvoiceDocumentDetails = z.infer<typeof invoiceDocumentDetails>;
export const courseInput = z.object({
  name: z.string().trim().min(1).max(200), price_inr: price, price_usd: price,
  price_ibmp_usd: z.preprocess(value => value === "" ? null : value, price.nullable()).optional(),
  is_active: z.boolean().default(true),
});
export const companyInput = z.object({
  code: z.enum(["DMHCA", "IBMP"]), legal_name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(2000), tax_id: z.string().trim().max(100).default(""),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  invoice_profile: invoiceCompanyProfile.optional(),
});
export type Course = z.infer<typeof courseInput> & { id: string };
export function coursePrice(course: Course | undefined, company: string, currency: string): number | null {
  if (!course) return null;
  const value = company === "IBMP" ? currency === "USD" ? course.price_ibmp_usd : null
    : currency === "USD" ? course.price_usd : currency === "INR" ? course.price_inr : null;
  return value == null ? null : Number(value);
}
export type BillingCompany = z.infer<typeof companyInput>;
export const legacyCompany: BillingCompany = {
  code: "DMHCA", legal_name: "DMHCA", address: "", tax_id: "", primary_color: "#800020", accent_color: "#f7cbd7",
};
