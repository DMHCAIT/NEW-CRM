import { DealsWorkspace } from "@/components/deals-workspace";
import { requirePageUser } from "@/lib/server/auth";
import { fetchDealWorkspace } from "@/lib/server/deal-workspace";

export const dynamic = "force-dynamic";

export default async function DealsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { supabase, user } = await requirePageUser("deals.view");
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) search.set(key, first);
  }
  const data = await fetchDealWorkspace(supabase, user, search);
  return <DealsWorkspace key={`${user.id}:${user.profile.role}:${user.permissions.join(",")}`} initialData={data} />;
}
