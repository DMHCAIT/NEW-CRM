import type { SupabaseClient } from "@supabase/supabase-js";
import { reportCsv, type SavedReport } from "@/lib/reports";
import { fetchLeadPage, type LeadQuery } from "@/lib/server/lead-query";

export async function leadCsvResponse(client: SupabaseClient, query: LeadQuery, report: SavedReport, filename: string, signal: AbortSignal) {
  let page = await fetchLeadPage(client, query, 100);
  const encoder = new TextEncoder();
  let first = true;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (cancelled || signal.aborted) { controller.error(new Error("Export cancelled.")); return; }
        while (!page.leads.length && page.hasMore) {
          if (!page.nextCursor) throw new Error("The export cursor is missing. Please retry the export.");
          page = await fetchLeadPage(client, { ...query, cursor: page.nextCursor }, 100);
          if (cancelled || signal.aborted) { controller.error(new Error("Export cancelled.")); return; }
        }
        if (!first && !page.leads.length) { controller.close(); return; }
        const csv = reportCsv(report, page.leads, "list");
        controller.enqueue(encoder.encode(first ? `\uFEFF${csv}` : `\r\n${csv.slice(csv.indexOf("\r\n") + 2)}`));
        first = false;
        if (!page.hasMore) { controller.close(); return; }
        if (!page.nextCursor) throw new Error("The export cursor is missing. Please retry the export.");
        page = await fetchLeadPage(client, { ...query, cursor: page.nextCursor }, 100);
      } catch (error) {
        console.error("Lead CSV export failed", error);
        controller.error(error);
      }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store",
  } });
}
