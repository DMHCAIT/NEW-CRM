import { z } from "zod";

const twoDecimals = (value: number) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001;
const money = z.coerce.number().finite().min(0).max(99999999).refine(twoDecimals, "Use at most two decimal places.");
export const invoiceInput = z.object({
  lead_id: z.string().uuid(),
  parent_invoice_id: z.preprocess((value) => value === "" ? undefined : value, z.string().uuid().nullable().optional()),
  description: z.string().trim().min(1).max(500),
  quantity: z.coerce.number().positive().max(10000).refine(twoDecimals, "Use at most two decimal places."),
  unit_price: money,
  tax_amount: money.default(0),
  discount_percent: z.coerce.number().min(0).max(100).default(0).refine(twoDecimals, "Use at most two decimal places."),
  discount_reason: z.string().trim().max(1000).default(""),
  payment_type: z.enum(["one_shot", "emi", "loan", "installments"]).default("one_shot"),
  course_total: money.optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Invalid due date"),
  notes: z.string().trim().max(3000).default(""),
}).superRefine((value, ctx) => {
  if (value.discount_percent > 0 && !value.discount_reason)
    ctx.addIssue({ code: "custom", message: "A discount reason is required.", path: ["discount_reason"] });
  if (value.discount_percent === 0 && value.discount_reason)
    ctx.addIssue({ code: "custom", message: "A discount reason is only used with a discount.", path: ["discount_reason"] });
  if (value.parent_invoice_id && value.payment_type !== "installments")
    ctx.addIssue({ code: "custom", message: "Only installment invoices can be linked to an original invoice.", path: ["payment_type"] });
  const total = value.quantity * value.unit_price * (1 - value.discount_percent / 100) + value.tax_amount;
  if ((value.payment_type === "one_shot" || value.payment_type === "installments") && total < 1)
    ctx.addIssue({ code: "custom", message: "Razorpay Payment Links require an invoice total of at least ₹1.", path: ["unit_price"] });
  if (value.course_total !== undefined && total > value.course_total)
    ctx.addIssue({ code: "custom", message: "Installment cannot exceed the course total.", path: ["course_total"] });
  if (value.quantity * value.unit_price + value.tax_amount > 9999999999.99)
    ctx.addIssue({ code: "custom", message: "Invoice amount is too large.", path: ["unit_price"] });
});

export function invoiceTotals(input: z.infer<typeof invoiceInput>) {
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
  const subtotal = round(input.quantity * input.unit_price);
  const discount = round(subtotal * input.discount_percent / 100);
  const tax = round(input.tax_amount);
  return { subtotal, discount_amount: discount, tax_amount: tax, total: round(subtotal - discount + tax) };
}

export const meetingInput = z.object({
  title: z.string().trim().min(1).max(200),
  lead_id: z.literal("").optional(),
  start_at: z.string().datetime({ offset: true }).refine((value) => new Date(value).getTime() > Date.now(), "Choose a future start time."),
  duration_min: z.coerce.number().int().min(1).max(480),
  provider: z.enum(["internal", "zoom"]),
  agenda: z.string().trim().max(2000).optional().default(""),
  attendee_ids: z.array(z.string().uuid()).max(200).optional().default([]),
  attendee_roles: z.array(z.enum(["counselor", "team_lead", "manager", "admin", "super_admin"])).max(5).optional().default([]),
}).superRefine((value, ctx) => {
  if (value.provider === "zoom" && value.duration_min > 40)
    ctx.addIssue({ code: "custom", message: "Zoom meetings on the free plan can be up to 40 minutes.", path: ["duration_min"] });
  if (!value.attendee_ids.length && !value.attendee_roles.length)
    ctx.addIssue({ code: "custom", message: "Choose at least one staff attendee.", path: ["attendee_ids"] });
});


export const automationInput = z.object({
  name: z.string().trim().min(1).max(200),
  trigger: z.enum(["manual", "followup_overdue"]),
  action: z.enum(["notify_me", "set_followup"]),
  days: z.coerce.number().int().min(1).max(365).default(1),
  is_active: z.boolean().default(false),
});
