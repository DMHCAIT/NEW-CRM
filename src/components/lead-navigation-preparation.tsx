"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { errorMessage } from "@/lib/crm-data";
import { getCachedLeadDetail, loadLeadDetailData } from "@/lib/live-leads-client";
import { prepareLeadLinks } from "@/lib/section-preparation";
import type { Lead } from "@/lib/types";

export function LeadNavigationPreparation({ leads, enabled = true }: { leads: Lead[]; enabled?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const ids = enabled ? [...new Set(leads.map(lead => lead.id))].slice(0, 4).join(",") : "";
  useEffect(() => {
    setError("");
    if (!ids) return;
    let task: ReturnType<typeof prepareLeadLinks> | undefined;
    const timer = window.setTimeout(() => {
      task = prepareLeadLinks(ids.split(","), async href => {
        const path = `/api${href}?section=overview`;
        if (getCachedLeadDetail(path) !== undefined) return;
        router.prefetch(href, { kind: PrefetchKind.FULL });
        await loadLeadDetailData(path, { maxAgeMs: 30000 });
      }, {
        isVisible: () => document.visibilityState === "visible",
        onError: failure => setError(errorMessage(failure, "Could not prepare lead details. Open the lead to retry.")),
      });
    }, 0);
    return () => { window.clearTimeout(timer); task?.cancel(); };
  }, [ids, router]);
  return error ? <p className="form-error" role="alert">{error}</p> : null;
}
