"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import LeadsWorkspace from "@/components/leads-workspace";
import { SectionLoading } from "@/components/section-loading";
import { readDashboardFilter } from "@/lib/dashboard";
import { emptyFilter } from "@/lib/live-leads-client";

export default function LeadsPage() {
  const search = useSearchParams();
  const router = useRouter();
  const create = search.get("create") === "1";
  useEffect(() => { if (create) router.replace("/leads/new"); }, [create, router]);
  if (create) return <SectionLoading title="New lead" />;
  const dashboard = search.get("dashboard");
  if (dashboard !== null) {
    try {
      return <LeadsWorkspace key={dashboard} initialFilter={readDashboardFilter(dashboard)} dashboard />;
    } catch (error) {
      return <section className="panel live-panel"><h1>Leads</h1><p className="form-error" role="alert">{error instanceof Error ? error.message : "Could not load the dashboard filter."}</p><Link className="button button-secondary" href="/">Return to Dashboard</Link></section>;
    }
  }
  const query = search.get("q") ?? "";
  return <LeadsWorkspace key={`all-leads:${query}`} initialFilter={{ ...emptyFilter(), query }} />;
}
