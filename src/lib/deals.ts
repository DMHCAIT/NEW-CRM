import { z } from "zod";
import { dealConversionRange, type DealFilters } from "@/lib/deal-filters";

export const dealPageSize = 50;
export const dealRecordSchema = z.object({
  id: z.string(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(),
  course: z.string().nullable(), stage_id: z.string(), created_at: z.string().datetime({ offset: true }),
});
export type DealRecord = z.infer<typeof dealRecordSchema>;
export type DealStage = { id: string; name: string };
export type DealSnapshotRecord = DealRecord & { converted_at: string | null };
export type DealPageResult = { leads: DealRecord[]; counts: { stage_id: string; total: number }[] };
export type DealWorkspaceData = {
  result: DealPageResult; snapshot: DealSnapshotRecord[] | null; stages: DealStage[];
  filters: DealFilters; page: number; timezone: string; today: string; loadedAt: number;
};

export function filterDealSnapshot(
  snapshot: DealSnapshotRecord[], stages: DealStage[], filters: DealFilters,
  page: number, today: string, timezone: string,
): DealPageResult {
  const selected = stages.filter(stage => ["closed won", "already enrolled"].includes(stage.name.toLowerCase())
    && (filters.stage === "all" || stage.name.toLowerCase() === filters.stage.replaceAll("_", " ")));
  const totals = new Map(selected.map(stage => [stage.id, 0]));
  const dates = dealConversionRange(filters, today);
  const formatter = dates ? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }) : null;
  const matching = snapshot.filter(lead => {
    if (!totals.has(lead.stage_id)) return false;
    if (dates && formatter) {
      if (!lead.converted_at) return false;
      const parts = formatter.formatToParts(new Date(lead.converted_at));
      const day = ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value.padStart(type === "year" ? 4 : 2, "0")).join("-");
      if (day < dates.from || day > dates.to) return false;
    }
    totals.set(lead.stage_id, totals.get(lead.stage_id)! + 1);
    return true;
  }).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id.localeCompare(a.id));
  const offset = (page - 1) * dealPageSize;
  return {
    leads: matching.slice(offset, offset + dealPageSize + 1),
    counts: [...totals].map(([stage_id, total]) => ({ stage_id, total })),
  };
}
