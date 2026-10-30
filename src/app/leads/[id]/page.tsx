"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CalendarClock, Clock3, Eye, FileText, GitMerge, Mail, Phone, UserRound, X } from "lucide-react";
import { LeadInlineField } from "@/components/lead-inline-field";
import { StageBadge, initials } from "@/components/lead-helpers";
import { apiRequest, formatDateTime, type StageRow } from "@/lib/crm-data";
import type { CurrentUser, Lead, Profile } from "@/lib/types";
import { useLiveLeadData, type LeadDraft } from "@/lib/live-leads-client";
import type { LeadConfiguration } from "@/lib/live-leads";
import { leadCallNumber } from "@/lib/lead-phone";
import { InvoiceWorkspace } from "@/components/invoice-workspace";

type Timeline = { id: string; content?: string; description?: string; type?: string; created_at: string; user_id: string | null; meta?: { actor_name?: string; changes?: Record<string, { before: unknown; after: unknown; before_label?: string; after_label?: string }> } };
type DuplicateOwner = { assignee: string; merge_target_id: string | null };
type DetailData = {
  lead: Lead & { customFields: Record<string, string> }; stages: StageRow[]; profiles: Profile[]; user: CurrentUser; configuration: LeadConfiguration;
  notes: Timeline[]; activities: Timeline[];
  emails: { id: string; subject: string; body: string; status: string; from_email: string | null; to_email: string; direction: string; created_at: string; user_id: string | null }[];
  mailbox: { email: string } | null;
  scheduledCalls: { id: string; user_id: string; scheduled_at: string; status: string; created_at: string }[];
  duplicates: DuplicateOwner[];
  canScheduleCall: boolean;
};
export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, error, loading, reload, setError } = useLiveLeadData<DetailData>(`/api/leads/${id}`);
  const saves = useRef<Promise<void>>(Promise.resolve());
  const pendingSaves = useRef(0);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [noteContent, setNoteContent] = useState("");
  const [emailContent, setEmailContent] = useState("");
  const [subject, setSubject] = useState("");
  const [notice, setNotice] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const [viewDuplicates, setViewDuplicates] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeSearch, setMergeSearch] = useState("");
  const [tab, setTab] = useState("overview");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [callDate, setCallDate] = useState("");
  const [callError, setCallError] = useState("");
  const [scheduling, setScheduling] = useState(false);
  const [callNow, setCallNow] = useState(() => Date.now());
  const [rescheduleId, setRescheduleId] = useState("");
  const [overviewTab, setOverviewTab] = useState<"overview" | "timeline">("overview");
  const scheduleRef = useRef<HTMLDialogElement>(null);
  const schedulingRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setCallNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const dialog = scheduleRef.current;
    if (!dialog) return;
    if (scheduleOpen && !dialog.open) dialog.showModal();
    if (!scheduleOpen && dialog.open) dialog.close();
  }, [scheduleOpen]);
  const can = (permission: string) => data?.user.permissions.some((p) => p === permission) ?? false;
  async function act(callback: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await callback(); } catch (e) { setError(e instanceof Error ? e.message : "Action failed."); } finally { setBusy(false); }
  }
  async function save(patch: Partial<LeadDraft>) {
    pendingSaves.current++; setSaving(true);
    const operation = saves.current.then(async () => {
      await apiRequest(`/api/leads/${id}`, { method: "PATCH", body: patch });
      await reload();
    });
    // A failed field remains visibly unsaved without blocking later field saves.
    saves.current = operation.catch(() => {});
    try { await operation; } finally { pendingSaves.current--; setSaving(pendingSaves.current > 0); }
  }
  async function scheduleCall() {
    if (schedulingRef.current) return;
    if (!rescheduleId && data?.canScheduleCall === false) { setCallError("Update this lead or change an existing call before scheduling another."); return; }
    const date = new Date(callDate);
    if (!callDate || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) { setCallError("Choose a future date and time for the call."); return; }
    schedulingRef.current = true; setScheduling(true); setCallError(""); setNotice("");
    try {
      await apiRequest(`/api/leads/${id}/actions`, { body: rescheduleId ? { action: "update_call", callId: rescheduleId, status: "scheduled", scheduledAt: date.toISOString() } : { action: "schedule_call", scheduledAt: date.toISOString() } });
      setScheduleOpen(false); setCallDate("");
      setNotice(`Call ${rescheduleId ? "rescheduled" : "scheduled"} for ${formatDateTime(date.toISOString())}.`);
      await reload().catch(() => {});
    } catch (reason) { setCallError(reason instanceof Error ? reason.message : "Could not schedule the call."); }
    finally { schedulingRef.current = false; setScheduling(false); }
  }
  if (!data) return <section className="panel live-panel"><Link href="/leads">Back to leads</Link>{loading ? <p role="status">Loading lead…</p> : <><p role="alert">{error}</p><button className="button button-secondary" onClick={() => void reload().catch(() => {})}>Retry</button></>}</section>;
  const lead = data.lead;
  const callNumber = leadCallNumber(lead.phone, lead.countryCode);
  const scheduledCalls = (data.scheduledCalls ?? []).filter(call => call.status === "scheduled").sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  const upcomingCalls = scheduledCalls.filter(call => new Date(call.scheduled_at).getTime() >= callNow);
  const pastDueCalls = scheduledCalls.filter(call => new Date(call.scheduled_at).getTime() < callNow).reverse();
  const nextCall = upcomingCalls[0];
  const scheduleLocked = data.canScheduleCall === false;
  const scheduleLockMessage = "Update a lead field, or reschedule, complete or cancel an existing call before scheduling another.";
  function openSchedule() {
    if (scheduleLocked) return;
    setRescheduleId(""); setCallError(""); setCallDate(""); setScheduleOpen(true);
  }
  function updateCall(callId: string, status: "completed" | "cancelled") {
    if (!confirm(status === "completed" ? "Mark this call as completed?" : "Cancel this scheduled call?")) return;
    void act(async () => {
      await apiRequest(`/api/leads/${id}/actions`, { body: { action: "update_call", callId, status } });
      setNotice(status === "completed" ? "Call marked completed." : "Call cancelled.");
      await reload();
    });
  }
  const duplicates = data.duplicates ?? [];
  const mergeTargets = duplicates.filter(item => item.merge_target_id !== null);
  const canMergeDuplicates = can("leads.merge") && mergeTargets.length > 0;
  const mailboxMatchesLogin = Boolean(data.mailbox?.email && data.user.email && data.mailbox.email.toLowerCase() === data.user.email.toLowerCase());
  const tabs = [
    { id: "overview", label: "Overview", icon: UserRound, count: null },
    { id: "note", label: "Notes", icon: FileText, count: data.notes.length },
    { id: "email", label: "Emails", icon: Mail, count: data.emails.length },
    { id: "calls", label: "Calls", icon: Phone, count: scheduledCalls.length },
    ...(can("invoices.view") ? [{ id: "invoices", label: "Invoices", icon: FileText, count: null }] : []),
  ];
  function selectTab(value: string) { setTab(value); setOverviewTab("overview"); }
  const sectionLabel = tabs.find(item => item.id === tab)?.label ?? "Overview";
  const overviewHistory = data.activities.filter(row => !["note", "email", "email_sent", "call"].includes(row.type ?? ""));
  const field = (key: keyof Omit<LeadDraft, "customFields">, label: string, value: string, options?: { value: string; label: string }[], type: "text" | "email" | "tel" | "number" | "datetime-local" = "text") =>
    <LeadInlineField key={key} label={label} value={value} type={type} options={options} readOnly={!can("leads.edit") || (key === "assigneeId" && (!can("leads.assign") || !["team_lead", "manager", "admin", "super_admin"].includes(data.user.profile.role)))}
      required={key === "name" || key === "phone"} maxLength={key === "email" ? 254 : key === "phone" || key === "altPhone" ? 30 : 200}
      onSave={async next => {
        if (key === "assigneeId" && next !== value && !confirm("Transfer this lead? You may lose access if it leaves your reporting scope.")) throw new Error("Transfer cancelled. Select the current owner to discard this change.");
        await save({ [key]: key === "closureFee" ? Number(next) : key === "followUpAt" ? next ? new Date(next).toISOString() : null : ["stageId", "assigneeId"].includes(key) ? next || null : next });
      }} />;
  const picklist = (key: "countryCode" | "country" | "course" | "qualification" | "category" | "source", label: string) =>
    field(key, label, lead[key] ?? "", [...new Set(["", ...data.configuration.picklists[key], lead[key] ?? ""])].map(value => ({ value, label: value || "Not provided" })));
  const history = (rows: Timeline[], empty: string) => <div className="timeline-list">
    {!rows.length && <p className="empty-notes">{empty}</p>}
    {rows.map((row, index) => <div className="lead-timeline-entry" key={row.id}>
      {(index === 0 || new Date(row.created_at).toDateString() !== new Date(rows[index - 1].created_at).toDateString()) && <div className="lead-timeline-day">{new Intl.DateTimeFormat("en-IN", { dateStyle: "full" }).format(new Date(row.created_at))}</div>}
      <article className={`timeline-item lead-event-${row.type ?? (row.content ? "note" : "activity")}`}><span className="timeline-dot" /><div className="lead-event-card">
      <div className="lead-event-heading"><span className="lead-event-category">{row.content ? "Note" : row.type === "call" ? "Call activity" : "Record activity"}</span><time dateTime={row.created_at}>{formatDateTime(row.created_at)}</time></div>
      <strong className="timeline-title">{row.meta?.actor_name || data.profiles.find(profile => profile.id === row.user_id)?.fullName || (row.user_id ? "User name unavailable (legacy record)" : "System")}</strong>
      <p>{row.content ? "Added a note" : row.description}</p>{row.content && <p>{row.content}</p>}
      {row.meta?.changes && <ul className="lead-change-list">{Object.entries(row.meta.changes).filter(([, change]) => JSON.stringify(change.before) !== JSON.stringify(change.after)).flatMap(([key, change]) => {
        if (key === "custom_fields") {
          const before = isRecord(change.before) ? change.before : {}, after = isRecord(change.after) ? change.after : {};
          return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]).map(name => <li key={`${key}-${name}`}><strong>{name}</strong><span>{changeValue(name, before[name])}</span><span aria-label="changed to"> → </span><span>{changeValue(name, after[name])}</span></li>);
        }
        return <li key={key}><strong>{fieldLabel(key)}</strong><span>{change.before_label ?? changeValue(key, change.before)}</span><span aria-label="changed to"> → </span><span>{change.after_label ?? changeValue(key, change.after)}</span></li>;
      })}</ul>}
      {row.type === "updated" && !row.meta?.changes && <p className="lead-legacy-history">Field-level values were not recorded for this older change.</p>}
    </div></article></div>)}
  </div>;
  const sectionIntro = (title: string, description: string, icon: typeof UserRound) => {
    const Icon = icon;
    return <div className="lead-section-intro"><span className="lead-section-symbol"><Icon size={21} /></span><div><div className="lead-section-eyebrow">{lead.name} / {sectionLabel}</div><h2>{title}</h2><p>{description}</p></div></div>;
  };
  function changeValue(key: string, value: unknown): string {
    if (value === null || value === undefined || value === "") return "Not set";
    if (key === "stage_id" && typeof value === "string") return data!.stages.find(stage => stage.id === value)?.name ?? "Former stage";
    if (key === "assignee_id" && typeof value === "string") return data!.profiles.find(profile => profile.id === value)?.fullName ?? "Former owner";
    if (["next_followup_at", "scheduled_at"].includes(key) && typeof value === "string") return formatDateTime(value);
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return <>
    <div className="detail-back"><Link href="/leads"><ArrowLeft size={13} />Back to leads</Link></div>
    <section className="panel lead-header-panel lead-record-header"><div className="lead-header-main"><span className="lead-large-avatar">{initials(lead.name)}</span><div className="lead-main-copy"><div className="lead-record-eyebrow">LEAD DETAILS</div><h1>{lead.name}</h1><span>{lead.course || "No course"} · {lead.assignee || "Unassigned"}</span></div><StageBadge stage={lead.stage || "No stage"} /><div className="heading-actions lead-header-actions">
      {duplicates.length > 0 && <>
        <button className="button button-secondary" aria-expanded={viewDuplicates} aria-controls="lead-duplicate-owners" onClick={() => { setViewDuplicates(!viewDuplicates); setMergeOpen(false); setMergeSearch(""); setMergeTargetId(""); }}><Eye size={14} />View duplicates ({duplicates.length})</button>
        <button className="button button-secondary" disabled={!canMergeDuplicates || busy || saving || scheduling} title={canMergeDuplicates ? "Merge duplicate leads within your bucket" : "Both leads must be within your merge bucket and merge permission is required."} onClick={() => { setViewDuplicates(true); setMergeOpen(!mergeOpen); setMergeTargetId(""); setMergeSearch(""); }}><GitMerge size={14} />{mergeOpen ? "Cancel merge" : "Merge duplicates"}</button>
      </>}
    </div></div><div className="lead-record-actionbar"><div className="lead-communication-actions">
      {can("leads.edit") && <>
        {callNumber ? <a className="button lead-call-button" href={`tel:${callNumber}`} title={`Open your phone app to call ${callNumber}`}><Phone size={16} />Click to call</a> : <button className="button lead-call-button" disabled title="Add a valid phone number to call this lead."><Phone size={16} />Click to call</button>}
        <button className="button lead-schedule-button" disabled={busy || saving || scheduling || scheduleLocked} title={scheduleLocked ? scheduleLockMessage : undefined} onClick={openSchedule}><CalendarClock size={16} />Schedule a call</button>
      </>}
    </div><span className="lead-call-caption">{scheduleLocked ? scheduleLockMessage : "Calls open in your device's phone app"}</span></div><div className="lead-contact-row"><span><Phone size={13} /><strong>Phone</strong> {callNumber || lead.phone}</span><span><Mail size={13} /><strong>Email</strong> {lead.email || "Not provided"}</span><span><strong>Source</strong> {lead.source}</span></div></section>
    {error && <p className="helper-banner" role="alert">{error}</p>}{notice && <div className="helper-banner lead-record-notice"><span role="status">{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice("")}><X size={15} /></button></div>}
    {scheduledCalls.length > 0 && <section className="panel lead-call-summary" aria-label="Call summary"><span className="lead-call-card-icon"><CalendarClock size={18} /></span><div className="lead-next-call"><span>Next scheduled call</span>{nextCall ? <><time dateTime={nextCall.scheduled_at}>{formatDateTime(nextCall.scheduled_at)}</time><span>{data.profiles.find(profile => profile.id === nextCall.user_id)?.fullName ?? "CRM user"}</span></> : <strong>No upcoming calls</strong>}</div><div className="lead-call-summary-counts"><span>{upcomingCalls.length} upcoming</span>{pastDueCalls.length > 0 && <span className="is-overdue">{pastDueCalls.length} past due</span>}</div><button type="button" className="button button-secondary" onClick={() => selectTab("calls")}>View all calls ({scheduledCalls.length})</button></section>}
    {viewDuplicates && duplicates.length > 0 && <section id="lead-duplicate-owners" className="panel live-panel lead-duplicates-panel" aria-label="Duplicate assignees"><div className="detail-section-heading"><div><h2>Duplicate leads</h2><p>A phone number or email matches. Only the existing assignee names are shown.</p></div><button className="button button-secondary" aria-label="Close duplicates" onClick={() => { setViewDuplicates(false); setMergeOpen(false); }}><X size={16} /></button></div>
      <div className="live-toolbar"><input type="search" aria-label="Search duplicate assignees" placeholder="Search assignee" value={mergeSearch} onChange={event => setMergeSearch(event.target.value)} /></div>
      <ul className="lead-duplicate-list">{duplicates.filter(item => item.assignee.toLowerCase().includes(mergeSearch.toLowerCase())).map((item, index) => <li key={item.merge_target_id ?? `${item.assignee}-${index}`}><span><UserRound size={15} />{item.assignee}</span>{mergeOpen && canMergeDuplicates && item.merge_target_id && <button className="button button-secondary" aria-pressed={mergeTargetId === item.merge_target_id} disabled={busy || saving || scheduling} onClick={() => setMergeTargetId(item.merge_target_id ?? "")}>{mergeTargetId === item.merge_target_id ? "Selected destination" : "Select for merge"}</button>}</li>)}</ul>
      {!duplicates.some(item => item.assignee.toLowerCase().includes(mergeSearch.toLowerCase())) && <p>No matching assignees.</p>}
      {mergeOpen && canMergeDuplicates && <><p>The selected destination retains its field values. Related notes, activity, emails, calls, scheduled calls, meetings, invoices and integration records move to it. This lead is archived with a merge link. This cannot be undone in the UI.</p>
        <button className="button button-primary" disabled={busy || saving || scheduling || !mergeTargets.some(item => item.merge_target_id === mergeTargetId)} onClick={() => {
          const destination = mergeTargets.find(item => item.merge_target_id === mergeTargetId);
          if (destination && confirm(`Merge "${lead.name}" into the duplicate assigned to "${destination.assignee}"? The source will be archived and all related records moved. Destination field values are kept.`)) void act(async () => {
            const result = await apiRequest<{ id: string }>(`/api/leads/${id}/merge`, { body: { targetId: mergeTargetId } });
            router.push(`/leads/${result.id}`);
          });
        }}>{busy ? "Merging…" : "Confirm merge"}</button>
      </>}
    </section>}
    <div className="lead-detail-layout lead-refined-workspace"><nav className="panel detail-sidebar" aria-label="Lead sections"><div className="detail-sidebar-title">LEAD WORKSPACE</div>{tabs.map(item => <button key={item.id} id={`lead-section-${item.id}`} aria-controls={`lead-panel-${item.id}`} className={`detail-nav-item${tab === item.id ? " selected" : ""}`} aria-current={tab === item.id ? "page" : undefined} onClick={() => selectTab(item.id)}><item.icon size={15} />{item.label}{item.count !== null && <span>{item.count}</span>}</button>)}<p className="detail-sidebar-hint">Lead details and history reflect your authorized access.</p></nav>
    <section className="panel detail-content">
    <div id={`lead-panel-${tab}`} role="region" aria-labelledby={`lead-section-${tab}`} className="detail-tab-content">
      <div className="detail-tabs lead-overview-tabs" role="tablist" aria-label={`${sectionLabel} views`} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "overview" : event.key === "End" ? "timeline" : overviewTab === "overview" ? "timeline" : "overview";
        setOverviewTab(next);
        event.currentTarget.querySelector<HTMLButtonElement>(`#lead-${tab}-tab-${next}`)?.focus();
      }}>
        {(["overview", "timeline"] as const).map(view => <button key={view} id={`lead-${tab}-tab-${view}`} type="button" role="tab" aria-selected={overviewTab === view} aria-controls={`lead-${tab}-panel-${view}`} tabIndex={overviewTab === view ? 0 : -1} className={overviewTab === view ? "selected" : ""} onClick={() => setOverviewTab(view)}>{view === "overview" ? sectionLabel : "Timeline"}</button>)}
      </div>
      <div id={`lead-${tab}-panel-${overviewTab}`} role="tabpanel" aria-labelledby={`lead-${tab}-tab-${overviewTab}`}>
    {tab === "overview" && <>
      {overviewTab === "overview" ?
      <section className="detail-overview"><div className="detail-section-heading">{sectionIntro("Lead information", can("leads.edit") ? "Edit any field below. Text saves when you leave the field; selections save immediately." : "Contact information and admissions details", UserRound)}<span className="lead-autosave-badge" role="status">{saving ? "Saving changes..." : can("leads.edit") ? "Autosave enabled" : "Read only"}</span></div>
        <div className="lead-inline-grid">
          {field("name", "Lead name", lead.name)}{field("email", "Email", lead.email, undefined, "email")}
          {picklist("countryCode", "Country code")}{field("phone", "Phone", lead.phone, undefined, "tel")}
          {field("altPhone", "Alternate phone", lead.altPhone ?? "", undefined, "tel")}{picklist("country", "Country")}
          {picklist("course", "Course")}{picklist("qualification", "Qualification")}{picklist("category", "Category")}{picklist("source", "Source")}
          {field("stageId", "Stage", lead.stageId ?? "", data.stages.map(stage => ({ value: stage.id, label: stage.name })))}
          {field("assigneeId", "Lead owner", lead.assigneeId ?? "", [{ value: "", label: "Unassigned" }, ...data.profiles.map(profile => ({ value: profile.id, label: profile.fullName }))])}
          {field("closureFee", "Closure fee", String(lead.closureFee), undefined, "number")}
          {field("followUpAt", "Next follow-up", lead.followUpAt ? localDate(lead.followUpAt) : "", undefined, "datetime-local")}
          {data.configuration.fields.filter(item => item.active).map(item => <LeadInlineField key={item.name} label={item.name} value={lead.customFields[item.name] ?? ""} readOnly={!can("leads.edit")} maxLength={2000}
            options={item.type === "dropdown" ? [...new Set(["", ...item.options, lead.customFields[item.name] ?? ""])].map(value => ({ value, label: value || "Not provided" })) : undefined}
            onSave={value => save({ customFields: { [item.name]: value } })} />)}
        </div>
        <dl className="lead-record-meta">{[["Created", lead.createdAt], ["Last modified", lead.modifiedAt]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ? new Date(value).toLocaleString() : "Not available"}</dd></div>)}<div><dt>Modified by</dt><dd>{lead.modifiedBy || "Not available"}</dd></div></dl>
      </section> :
      <section aria-label="Overview timeline" className="lead-section-history"><div className="detail-history-heading">{sectionIntro("Overview timeline", "Record changes and activity, newest first", UserRound)}</div>{history(overviewHistory, "No detail changes yet.")}</section>}
    </>}
    {tab === "calls" && overviewTab === "overview" && <section className="detail-overview lead-calls-workspace" aria-label="Scheduled calls"><div className="detail-section-heading">{sectionIntro("Scheduled calls", scheduleLocked ? scheduleLockMessage : "All call appointments in one place. Upcoming calls are shown earliest first.", Phone)}{can("leads.edit") && <button className="button button-primary" disabled={busy || saving || scheduling || scheduleLocked} onClick={openSchedule}><CalendarClock size={15} />Schedule a call</button>}</div>
      {!scheduledCalls.length ? <div className="lead-calls-empty"><CalendarClock size={30} /><h3>No calls scheduled yet</h3><p>Schedule your next conversation with this lead. Appointments will appear here.</p></div> :
        <div className="lead-calls-scroll" role="region" aria-label="Call appointments" tabIndex={0}>{[{ title: "Upcoming", calls: upcomingCalls, overdue: false }, { title: "Past due", calls: pastDueCalls, overdue: true }].map(group => <section key={group.title} className="lead-call-group" aria-label={`${group.title} calls`}><h3>{group.title}<span>{group.calls.length}</span></h3>{!group.calls.length ? <p className="lead-call-group-empty">{group.overdue ? "No past-due calls." : "No upcoming calls."}</p> : <ol>{group.calls.map(call => <li className="lead-call-row" key={call.id}><span className="lead-call-card-icon"><Phone size={16} /></span><div className="lead-call-row-copy"><time dateTime={call.scheduled_at}>{formatDateTime(call.scheduled_at)}</time><span>{data.profiles.find(profile => profile.id === call.user_id)?.fullName ?? "CRM user"}</span></div><span className={`lead-call-chip${group.overdue ? " is-overdue" : ""}`}><Clock3 size={12} />{group.overdue ? "Past due" : "Scheduled"}</span>{can("leads.edit") && <div className="lead-call-row-actions"><button className="button button-secondary" disabled={busy || saving || scheduling} onClick={() => { setRescheduleId(call.id); setCallDate(localDate(call.scheduled_at)); setCallError(""); setScheduleOpen(true); }}>Reschedule</button><button className="button button-secondary" disabled={busy || saving || scheduling} onClick={() => updateCall(call.id, "completed")}>Complete</button><button className="button button-secondary" disabled={busy || saving || scheduling} onClick={() => updateCall(call.id, "cancelled")}>Cancel call</button></div>}</li>)}</ol>}</section>)}</div>}
      <p className="lead-calls-footnote">Appointments use your local time zone. Scheduling does not automatically place a call or send a reminder.</p>
    </section>}
    {tab === "calls" && overviewTab === "timeline" && <section aria-label="Calls timeline" className="lead-section-history"><div className="detail-history-heading">{sectionIntro("Calls timeline", "Scheduling, rescheduling and outcomes, newest first", Phone)}</div>{history(data.activities.filter(row => row.type === "call"), "No recorded call changes yet. Older appointments may not have a change log.")}</section>}
    {tab === "invoices" && can("invoices.view") && <InvoiceWorkspace key={id} leadId={id} timelineOnly={overviewTab === "timeline"} />}
    {["note", "email"].includes(tab) && overviewTab === "overview" && !can("leads.edit") && <section className="detail-overview"><h2>{sectionLabel}</h2><p>Read only. Open Timeline to view this lead&apos;s {tab === "note" ? "notes" : "email history"}.</p></section>}
    {["note", "email"].includes(tab) && overviewTab === "overview" && can("leads.edit") && <section className={`detail-overview lead-compose-section lead-compose-${tab}`}>{sectionIntro(tab === "note" ? "Add a note" : "Compose email", tab === "note" ? "Capture your conversation, decisions and next steps. Notes stay with this lead." : "Write to this lead from your connected Google Workspace mailbox.", tab === "note" ? FileText : Mail)}<form onSubmit={(e) => { e.preventDefault(); const action = tab; void act(async () => {
      await apiRequest(`/api/leads/${id}/actions`, { body: { action, subject: action === "email" ? subject : "", content: action === "email" ? emailContent : noteContent } });
      if (action === "email") { setEmailContent(""); setSubject(""); } else setNoteContent("");
      await reload(); setNotice(action === "email" ? "Gmail accepted your email. This does not confirm recipient delivery." : "Note added."); setOverviewTab("timeline");
    }); }} className="live-update-form">
      {tab === "email" && <><div className="lead-email-envelope"><div className="lead-email-addresses"><p><strong>From</strong> {data.user.email}</p><p><strong>To</strong> {lead.email || "No lead email address"}</p></div><div className="lead-mailbox-control"><span className={`lead-mailbox-state${mailboxMatchesLogin ? " is-connected" : ""}`}>{mailboxMatchesLogin ? "Gmail connected" : "Mailbox not connected"}</span><button type="button" className="button button-secondary" disabled={busy} onClick={() => void act(async () => {
        const result = await apiRequest<{ url: string }>("/api/integrations/gmail/connect", { method: "POST" }); window.location.assign(result.url);
      })}>{data.mailbox ? "Reconnect Gmail" : "Connect Gmail"}</button></div></div><p className="lead-compose-hint">{mailboxMatchesLogin ? "Your Google Workspace mailbox is connected. Emails are sent from your CRM login address." : `Authorize Google Workspace for ${data.user.email} once to send from your login address. CRM sign-in alone does not grant mailbox access.`} No shared SMTP sender is used.</p><label className="form-field">Subject<input value={subject} maxLength={200} required placeholder="Add a subject" onChange={e => setSubject(e.target.value)} /></label></>}
      <label className="form-field">{tab === "email" ? "Message" : "Note"}<textarea required maxLength={tab === "email" ? 20000 : 10000} rows={5} value={tab === "email" ? emailContent : noteContent} onChange={e => tab === "email" ? setEmailContent(e.target.value) : setNoteContent(e.target.value)} /></label>
      {tab === "email" && (!lead.email || !mailboxMatchesLogin) && <p className="lead-compose-warning" role="alert">{!lead.email ? "Add an email address to the lead before sending." : data.mailbox ? `The connected account (${data.mailbox.email}) does not match your login. Reconnect Gmail using ${data.user.email}.` : `Connect Gmail using ${data.user.email} before sending.`}</p>}
      <div className="lead-compose-footer"><span>{(tab === "email" ? emailContent : noteContent).length.toLocaleString()} / {tab === "email" ? "20,000" : "10,000"} characters</span><button className="button button-primary" disabled={busy || !(tab === "email" ? emailContent : noteContent).trim() || (tab === "email" && (!subject.trim() || !lead.email || !mailboxMatchesLogin))}>{busy ? tab === "email" ? "Sending..." : "Saving..." : tab === "email" ? "Send email" : "Add note"}</button></div>
    </form></section>}
    {tab === "note" && overviewTab === "timeline" && <section aria-label="Notes timeline" className="lead-section-history"><div className="detail-history-heading">{sectionIntro("Notes timeline", "Notes and conversations, newest first", FileText)}</div>{history(data.notes, "No notes yet. Open Notes to add your first note.")}</section>}
    {overviewTab === "timeline" && <>
    {tab === "email" && <section aria-label="Email timeline" className="lead-section-history"><div className="detail-history-heading">{sectionIntro("Email timeline", "Incoming and outgoing messages, newest first", Mail)}</div><div className="timeline-list">
      {!data.emails.length && <p className="empty-notes">No email history yet.</p>}
      {data.emails.map((email, index) => <div className="lead-timeline-entry" key={email.id}>
        {(index === 0 || new Date(email.created_at).toDateString() !== new Date(data.emails[index - 1].created_at).toDateString()) && <div className="lead-timeline-day">{new Intl.DateTimeFormat("en-IN", { dateStyle: "full" }).format(new Date(email.created_at))}</div>}
        <article className="timeline-item lead-event-email"><span className="timeline-dot" /><div className="lead-email-record lead-event-card">
          <div className="lead-event-heading"><span className="lead-event-category">{email.direction === "inbound" ? "Incoming email" : "Outgoing email"}</span><time dateTime={email.created_at}>{formatDateTime(email.created_at)}</time></div>
          <div className="lead-email-record-heading"><strong>{email.subject || "(No subject)"}</strong><span className={`lead-email-status status-${email.status}`}>{email.direction === "inbound" ? "Received" : email.status === "sent" ? "Accepted by provider" : email.status}</span></div>
          <p><strong>{email.direction === "inbound" ? `Received from ${email.from_email || "unknown sender"}` : `${data.profiles.find(profile => profile.id === email.user_id)?.fullName || email.from_email || "Sender unavailable (legacy record)"} — Email ${email.status === "sent" ? "sent" : email.status}`}</strong></p>
          <p>From: {email.from_email || "Sender not recorded (legacy email)"}<br />To: {email.to_email}</p><details><summary>View message</summary><p>{email.body}</p></details>
        </div></article>
      </div>)}
    </div></section>}
    </>}
      </div>
    </div></section></div>
    <dialog ref={scheduleRef} className="panel modal bulk-action-modal lead-bulk-dialog lead-schedule-dialog" aria-labelledby="schedule-call-title" onCancel={event => { if (scheduling) event.preventDefault(); else setScheduleOpen(false); }}>
      {scheduleOpen && <form onSubmit={event => { event.preventDefault(); void scheduleCall(); }}>
        <div className="panel-heading"><div className="lead-bulk-dialog-heading"><span className="lead-bulk-dialog-icon"><CalendarClock size={22} /></span><div><h2 id="schedule-call-title">{rescheduleId ? "Reschedule call" : "Schedule a call"}</h2><p>Plan your next conversation with {lead.name}</p></div></div><button type="button" className="button button-quiet" aria-label="Close schedule" disabled={scheduling} onClick={() => setScheduleOpen(false)}><X size={18} /></button></div>
        <div className="modal-body"><div className="lead-schedule-contact"><Phone size={16} /><div><strong>{lead.name}</strong><span>{callNumber || lead.phone}</span></div></div>
          <label className="form-field"><span>Call date and time <span className="lead-bulk-required">*</span></span><input type="datetime-local" required value={callDate} min={localDate(new Date(Date.now() + 60000).toISOString())} disabled={scheduling} onChange={event => setCallDate(event.target.value)} /></label>
          <p className="lead-bulk-help">Time zone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Scheduled for you ({data.user.profile.fullName}). This saves a CRM appointment; it does not place an automatic call or send a reminder.</p>
          {callError && <p role="alert" className="lead-field-error">{callError}</p>}
        </div><div className="modal-footer"><button type="button" className="button button-secondary" disabled={scheduling} onClick={() => setScheduleOpen(false)}>Cancel</button><button className="button button-primary" disabled={scheduling || !callDate || (!rescheduleId && scheduleLocked)}>{scheduling ? "Saving..." : rescheduleId ? "Save new time" : "Schedule call"}</button></div>
      </form>}
    </dialog>
  </>;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fieldLabel(key: string) {
  const labels: Record<string, string> = { assignee_id: "Lead owner", stage_id: "Stage", next_followup_at: "Next follow-up", scheduled_at: "Call date and time", alt_phone: "Alternate phone", closure_fee: "Closure fee" };
  return labels[key] ?? key.replaceAll("_", " ").replace(/^./, char => char.toUpperCase());
}
function localDate(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
