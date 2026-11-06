import { z } from "zod";

const price = z.coerce.number().finite().min(1).max(99999999)
  .refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, "Use at most two decimal places.");
export const courseInput = z.object({
  name: z.string().trim().min(1).max(200), price_inr: price, price_usd: price, is_active: z.boolean().default(true),
});
export const companyInput = z.object({
  code: z.enum(["DMHCA", "IBMP"]), legal_name: z.string().trim().min(1).max(200),
  address: z.string().trim().min(1).max(2000), tax_id: z.string().trim().max(100).default(""),
  primary_color: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export type Course = z.infer<typeof courseInput> & { id: string };
export type BillingCompany = z.infer<typeof companyInput>;
export const legacyCompany: BillingCompany = {
  code: "DMHCA", legal_name: "DMHCA", address: "", tax_id: "", primary_color: "#800020", accent_color: "#f7cbd7",
};
