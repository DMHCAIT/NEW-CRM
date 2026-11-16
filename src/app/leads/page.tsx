import Link from "next/link";
import { redirect } from "next/navigation";
import LeadsWorkspace from "@/components/leads-workspace";
import { readDashboardFilter } from "@/lib/dashboard";
import { requirePageUser } from "@/lib/server/auth";
import { fetchLeadListData } from "@/lib/server/lead-list";
import { DEFAULT_FILTER, queryParameters } from "@/lib/server/lead-query";

export const dynamic = "force-dynamic";

export default async function LeadsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = await searchParams;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  if (first(search.create) === "1") redirect("/leads/new");
  const { supabase, user } = await requirePageUser("leads.view");
  const dashboard = first(search.dashboard);
  const query = first(search.q) ?? "";
  let filter = { ...DEFAULT_FILTER, query };
  if (dashboard !== undefined) {
    try {
      filter = readDashboardFilter(dashboard);
    } catch (error) {
      return <section className="panel live-panel"><h1>Leads</h1><p className="form-error" role="alert">{error instanceof Error ? error.message : "Could not load the dashboard filter."}</p><Link className="button button-secondary" href="/">Return to Dashboard</Link></section>;
    }
  }
  const params = new URLSearchParams({ filter: JSON.stringify(filter), dashboard: dashboard !== undefined ? "1" : "0" });
  const data = await fetchLeadListData(supabase, user, queryParameters(params), 100);
  const initialData = { data, updatedAt: Date.now() };
  const workspace = <LeadsWorkspace key={`${user.id}:${dashboard ?? `all-leads:${query}`}`} initialFilter={filter} dashboard={dashboard !== undefined} initialData={initialData} />;
  if (dashboard === undefined && first(search.reassigned) === "1") return <>
    <p className="helper-banner" role="status">Stage saved. The lead was reassigned and is no longer within your access.</p>
    {workspace}
  </>;
  return workspace;
}
