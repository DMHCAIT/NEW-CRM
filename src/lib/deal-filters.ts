import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !value.startsWith("0000") && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Choose a valid calendar date.");

export const dealFilterSchema = z.object({
  stage: z.enum(["all", "closed_won", "already_enrolled"]).default("all"),
  period: z.enum(["all", "today", "month", "year", "custom"]).default("all"),
  month: z.string().default(""),
  year: z.string().default(""),
  from: z.string().default(""),
  to: z.string().default(""),
}).superRefine((value, context) => {
  if (value.period === "month" && !/^(0[1-9]|1[0-2])$/.test(value.month)) {
    context.addIssue({ code: "custom", message: "Choose a valid month." });
  }
  if ((value.period === "month" || value.period === "year") && !/^(?!0000)\d{4}$/.test(value.year)) {
    context.addIssue({ code: "custom", message: "Enter a four-digit year from 0001 to 9999." });
  }
  if (value.period !== "custom") return;
  if (!date.safeParse(value.from).success || !date.safeParse(value.to).success) {
    context.addIssue({ code: "custom", message: "Choose valid From and To dates." });
  } else if (value.from > value.to) {
    context.addIssue({ code: "custom", message: "From date must be on or before To date." });
  }
});

export type DealFilters = z.infer<typeof dealFilterSchema>;

const querySchema = z.object({
  filters: dealFilterSchema,
  page: z.coerce.number().int().min(1).max(20000).default(1),
});

export function parseDealQuery(search: URLSearchParams) {
  return querySchema.safeParse({
    filters: Object.fromEntries(["stage", "period", "month", "year", "from", "to"].map(key => [key, search.get(key) ?? undefined])),
    page: search.get("page") ?? undefined,
  });
}

export function dealConversionRange(filters: DealFilters, today: string) {
  if (filters.period === "all") return null;
  if (filters.period === "today") return { from: today, to: today };
  if (filters.period === "custom") return { from: filters.from, to: filters.to };
  const from = `${filters.year}-${filters.period === "year" ? "01" : filters.month}-01`;
  const end = new Date(`${from}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + (filters.period === "year" ? 12 : 1), 0);
  return { from, to: end.toISOString().slice(0, 10) };
}

export function dealPageHref(filters: DealFilters, page = 1) {
  const params = new URLSearchParams();
  if (filters.stage !== "all") params.set("stage", filters.stage);
  if (filters.period !== "all") params.set("period", filters.period);
  if (filters.period === "month") params.set("month", filters.month);
  if (filters.period === "month" || filters.period === "year") params.set("year", filters.year);
  if (filters.period === "custom") {
    params.set("from", filters.from);
    params.set("to", filters.to);
  }
  if (page > 1) params.set("page", String(page));
  return `/deals${params.size ? `?${params}` : ""}`;
}
