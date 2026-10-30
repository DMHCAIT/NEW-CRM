"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { ArrowLeft, UserPlus } from "lucide-react";
import { apiRequest } from "@/lib/crm-data";
import { LeadForm, leadDraft, useLiveLeadData, type LeadDraft } from "@/lib/live-leads-client";

export default function NewLeadPage() {
  const router = useRouter();
  const { data, loading, error, setError } = useLiveLeadData("/api/leads?metadata=only");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const initial = useMemo(() => ({
    ...leadDraft(),
    assigneeId: data?.user.id ?? null,
    stageId: data?.stages.find((stage) => stage.name.toLocaleLowerCase() === "fresh")?.id ?? data?.stages[0]?.id ?? null,
  }), [data]);

  async function saveLead(draft: LeadDraft) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      let created: { id: string };
      try { created = await apiRequest<{ id: string }>("/api/leads", { body: draft }); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Duplicate warning:")) throw error;
        if (!confirm(`${error.message}\nCreate this duplicate lead?`)) return;
        created = await apiRequest<{ id: string }>("/api/leads", { body: { ...draft, duplicateOverride: true } });
      }
      router.push(`/leads/${created.id}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not create the lead. Please try again.");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  if (!data) return <section className="panel live-panel"><h1>New lead</h1><p role={error ? "alert" : "status"}>{error || (loading ? "Loading lead configuration..." : "Lead configuration is unavailable.")}</p><Link href="/leads" className="button button-secondary">Back to leads</Link></section>;
  if (!data.user.permissions.includes("leads.create")) return <section className="panel live-panel"><h1>New lead</h1><p role="alert">You do not have permission to create leads.</p><Link href="/leads" className="button button-secondary">Back to leads</Link></section>;

  return <div className="leads-workspace lead-create-workspace">
    <header className="page-heading leads-heading">
      <div className="leads-heading-copy"><span className="leads-module-icon"><UserPlus size={21} aria-hidden="true" /></span><h1>New lead</h1></div>
      <Link href="/leads" className="button button-secondary"><ArrowLeft size={15} aria-hidden="true" />Back to leads</Link>
    </header>
    {error && <p className="helper-banner" role="alert">{error}</p>}
    <section className="panel live-panel" aria-label="New lead form">
      <LeadForm initial={initial} stages={data.stages} profiles={data.profiles} fields={data.configuration.fields} picklists={data.configuration.picklists} canAssign={data.user.permissions.includes("leads.assign")} onSave={saveLead} busy={busy} submitLabel="Create lead" newLead />
    </section>
  </div>;
}
