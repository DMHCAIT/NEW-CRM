"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { useLeadNavigation } from "@/components/lead-filter-state";
import { useCallReminders } from "@/components/call-reminder-popups";
import { notificationLeadPath } from "@/lib/notifications";
import { apiRequest } from "@/lib/crm-data";
import { emptyFilter, leadQueryPath } from "@/lib/live-leads-client";
import type { LeadPage } from "@/lib/server/lead-query";
import type { Lead } from "@/lib/types";
import { finishLeavingLeadAssignments } from "@/lib/lead-stage-assignment";

export function NextLeadButton({ lead, disabled, isSaving }: {
  lead: Lead; disabled: boolean; isSaving: () => boolean;
}) {
  const router = useRouter();
  const navigation = useLeadNavigation();
  const reminders = useCallReminders();
  const nextReminder = reminders?.reminders.find(row => notificationLeadPath(row) !== `/leads/${lead.id}`
    && !reminders.openedReminderIds.includes(row.id));
  const reminderEnd = Boolean(reminders?.queueActive && !nextReminder);
  const [loading, setLoading] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function next() {
    if (pending.current || disabled || reminderEnd || (!reminders?.queueActive && atEnd)) return;
    if (isSaving()) {
      setError("Wait for lead changes to finish saving before opening the next lead.");
      return;
    }
    pending.current = true;
    setLoading(true); setError("");
    try {
      if (reminders?.queueActive && nextReminder) {
        const path = notificationLeadPath(nextReminder);
        if (!path) throw new Error("The next call reminder has no valid lead link.");
        await finishLeavingLeadAssignments(path);
        if (!mounted.current) return;
        reminders.open(nextReminder);
        return;
      }
      if (!lead.createdAt) throw new Error("Cannot find the next lead: this lead has no creation date.");
      const selection = navigation?.current;
      const path = leadQueryPath(selection?.filter ?? emptyFilter(), {
        dashboard: selection?.dashboard ?? false, pageSize: 10,
        cursor: { id: lead.id, createdAt: lead.createdAt },
      });
      const page = await apiRequest<LeadPage>(`${path}&metadata=0`, { maxAgeMs: 0 });
      if (!mounted.current) return;
      if (isSaving()) throw new Error("Wait for lead changes to finish saving before opening the next lead.");
      const nextLead = page.leads[0];
      if (!nextLead) setAtEnd(true);
      else {
        await finishLeavingLeadAssignments(`/leads/${nextLead.id}`);
        if (mounted.current) router.push(`/leads/${nextLead.id}`);
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Could not open the next lead.");
    } finally {
      pending.current = false;
      if (mounted.current) setLoading(false);
    }
  }

  return <div className="lead-next-navigation">
    {error && <span className="form-error" role="alert">{error}</span>}
    {(reminderEnd || (!reminders?.queueActive && atEnd)) && <span role="status">{reminders?.queueActive ? "No more call reminder leads." : "No more leads match these filters."}</span>}
    <button type="button" className="button lead-navigation-button" aria-label="Next lead" disabled={disabled || loading || reminderEnd || (!reminders?.queueActive && atEnd)} onClick={() => void next()}>{loading ? "Loading..." : "Next"}<ArrowRight size={14} aria-hidden="true" /></button>
  </div>;
}
