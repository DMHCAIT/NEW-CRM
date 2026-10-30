"use client";

import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock, Search } from "lucide-react";
import { Configuration, OperationFeedback, useOperationalData } from "../integrations/operational-ui";

type StaffRole = "counselor" | "team_lead" | "manager" | "admin" | "super_admin";
type Staff = { id: string; name: string; email: string; role: StaffRole };
type Attendee = { id: string; name: string; role: StaffRole };
type Meeting = { id: string; title: string; host_id: string; join_url: string | null; start_at: string; duration_min: number; status: string; zoom_meeting_id: string | null; attendees: Attendee[]; isAttendee: boolean };
type Data = { meetings: Meeting[]; staff: Staff[]; userId: string; canManage: boolean; canAdminManage?: boolean; zoom: Configuration };
const roles: { id: StaffRole; chip: string }[] = [
  { id: "counselor", chip: "All counselors" }, { id: "team_lead", chip: "All team leads" },
  { id: "manager", chip: "All managers" }, { id: "admin", chip: "All admins" },
];

export default function MeetingsPage() {
  const state = useOperationalData<Data>("/api/meetings");
  const [showForm, setShowForm] = useState(false);
  const [date, setDate] = useState("");
  const [reschedule, setReschedule] = useState<Meeting | null>(null);
  const [localError, setLocalError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<StaffRole[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const data = state.data;
  const userId = data?.userId;
  const canManage = data?.canManage ?? false;
  const canAdminManage = data?.canAdminManage ?? false;
  const dateKey = (day: Date) => day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0");
  const calendarDays = Array.from({ length: 42 }, (_, index) => new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index - calendarMonth.getDay() + 1));
  const meetingCounts = new Map<string, number>();
  for (const meeting of data?.meetings ?? []) {
    const key = dateKey(new Date(meeting.start_at));
    meetingCounts.set(key, (meetingCounts.get(key) ?? 0) + 1);
  }
  const meetings = data?.meetings.filter(meeting => !date || dateKey(new Date(meeting.start_at)) === date) ?? [];
  const filteredStaff = (data?.staff ?? []).filter(person => (person.name + " " + person.email + " " + person.role).toLowerCase().includes(search.toLowerCase()));
  const selectionCount = new Set([...(data?.staff ?? []).filter(person => selectedRoles.includes(person.role)).map(person => person.id), ...selectedIds]).size;
  const toggleRole = (role: StaffRole) => setSelectedRoles(current => {
    if (role === "admin") return current.includes("admin") ? current.filter(item => item !== "admin" && item !== "super_admin") : [...current, "admin", "super_admin"];
    return current.includes(role) ? current.filter(item => item !== role) : [...current, role];
  });
  const toggleStaff = (id: string) => {
    const person = data?.staff.find(item => item.id === id);
    if (person && selectedRoles.includes(person.role)) {
      setSelectedRoles(current => current.filter(role => role !== person.role));
      setSelectedIds(current => [...new Set([...current.filter(item => item !== id), ...(data?.staff ?? []).filter(item => item.role === person.role && item.id !== id).map(item => item.id)])]);
    } else setSelectedIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  };
  return <>
    <div className="page-heading"><div><h1>Meetings</h1><p>Schedule internal staff meetings and share invitations with attendees.</p></div><div className="heading-actions"><button className="button button-secondary" onClick={() => void state.refresh()}>Refresh</button>{data?.canManage && <button className="button button-primary" onClick={() => { setShowForm(!showForm); setSelectedIds([]); setSelectedRoles([]); }}>Schedule meeting</button>}</div></div>
    <OperationFeedback {...state} error={localError || state.error} />
    {data && !data.zoom.configured && <div className="helper-banner">Zoom requires {data.zoom.missing.join(", ")}. Internal meetings are available without Zoom; no video link will be generated.</div>}
    {showForm && data?.canManage && <section className="panel"><div className="panel-heading"><div><h2>Schedule internal meeting</h2><p>Invite counselors and staff to an internal meeting.</p></div><button type="button" className="button button-secondary button-small" onClick={() => setShowForm(false)}>Cancel</button></div><form className="operational-form" onSubmit={async event => {
      event.preventDefault(); setLocalError("");
      const form = event.currentTarget;
      const input = Object.fromEntries(new FormData(form).entries());
      if (!input.start_at || !Number.isFinite(new Date(String(input.start_at)).getTime())) { setLocalError("Choose a valid start time."); return; }
      if (!selectedIds.length && !selectedRoles.length) { setLocalError("Choose at least one attendee."); return; }
      const saved = await state.mutate("/api/meetings", "POST", { ...input, duration_min: Number(input.duration_min), start_at: new Date(String(input.start_at)).toISOString(), attendee_ids: selectedIds, attendee_roles: selectedRoles });
      if (saved) { setShowForm(false); setSelectedIds([]); setSelectedRoles([]); }
    }}>
      <label>Title<input className="form-input" name="title" required maxLength={200} /></label>
      <label>Start (local time)<input className="form-input" type="datetime-local" name="start_at" required /></label>
      <label>Duration (minutes)<input className="form-input" name="duration_min" type="number" min={1} max={40} defaultValue={30} required /><span className="field-hint">Free Zoom plan: up to 40 minutes</span></label>
      <label>Meeting type<select className="form-input" name="provider"><option value="internal">Internal &mdash; no video link</option><option value="zoom" disabled={!data.zoom.configured}>Zoom &mdash; create live meeting</option></select></label>
      <label>Agenda (optional)<textarea className="form-input" name="agenda" maxLength={2000} rows={3} /></label>
      <fieldset className="attendee-picker"><legend>Attendees <span aria-live="polite">({selectionCount} selected)</span></legend><div className="heading-actions attendee-role-chips">{roles.map(role => <button type="button" key={role.id} className={selectedRoles.includes(role.id) ? "button button-primary button-small" : "button button-secondary button-small"} aria-pressed={selectedRoles.includes(role.id)} onClick={() => toggleRole(role.id)}>{role.chip}</button>)}</div><label className="attendee-search"><span className="sr-only">Search staff</span><Search size={16} aria-hidden="true" /><input className="form-input" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search staff by name, email or role" /></label><div className="attendee-options" role="group" aria-label="Individual staff attendees">{filteredStaff.map(person => <label className="attendee-option" key={person.id}><input type="checkbox" checked={selectedIds.includes(person.id) || selectedRoles.includes(person.role)} onChange={() => toggleStaff(person.id)} aria-label={"Invite " + person.name + ", " + person.role.replaceAll("_", " ")} /><span><strong>{person.name}</strong><small>{person.role.replaceAll("_", " ")} &middot; {person.email}</small></span></label>)}{!filteredStaff.length && <p className="empty-state">No staff match this search.</p>}</div></fieldset>
      <button className="button button-primary" disabled={state.busy}>Create meeting</button>
    </form></section>}
    {reschedule && <section className="panel"><form className="operational-form" onSubmit={async event => {
      event.preventDefault();
      const value = String(new FormData(event.currentTarget).get("start_at"));
      if (await state.mutate("/api/meetings/" + reschedule.id, "PATCH", { action: "reschedule", start_at: new Date(value).toISOString() })) setReschedule(null);
    }}><label>Reschedule {reschedule.title}<input className="form-input" type="datetime-local" name="start_at" required /></label><button className="button button-primary" disabled={state.busy}>Save new time</button><button type="button" className="button button-secondary" onClick={() => setReschedule(null)}>Dismiss</button></form></section>}
    {data && <div className="meeting-layout"><section className="panel calendar-panel meeting-calendar" aria-label="Meeting calendar"><div className="panel-heading"><div><h2><CalendarDays size={17} /> {calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2><p>Select a date to view its meetings.</p></div><div className="heading-actions"><button className="button button-secondary button-small" aria-label="Previous month" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}><ChevronLeft size={16} /></button><button className="button button-secondary button-small" onClick={() => { const now = new Date(); setCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1)); setDate(dateKey(now)); }}>Today</button><button className="button button-secondary button-small" aria-label="Next month" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}><ChevronRight size={16} /></button></div></div><div className="calendar-grid">
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => <div className="calendar-day-label" key={day}>{day}</div>)}
      {calendarDays.map(day => { const key = dateKey(day); const count = meetingCounts.get(key) ?? 0; const dayLabel = day.toLocaleDateString(undefined, { dateStyle: "full" }) + ", " + count + " meetings"; return <button type="button" key={key} className={"calendar-cell calendar-date" + (day.getMonth() !== calendarMonth.getMonth() ? " outside-month" : "") + (date === key ? " selected" : "")} aria-pressed={date === key} aria-label={dayLabel} onClick={() => setDate(key)}><span>{day.getDate()}</span>{count > 0 && <span className="calendar-meeting-count">{count}<span className="calendar-meeting-label"> meeting{count === 1 ? "" : "s"}</span></span>}</button>; })}
    </div><div className="calendar-legend"><span><i className="calendar-event-dot" />Scheduled activity</span><span>Local timezone</span></div></section>
    <section className="panel"><div className="panel-heading"><div><h2>{date ? "Selected day" : "Meeting agenda"}</h2><p>{meetings.length} meetings{date ? " on " + date : " across all dates"}</p></div>{date && <button className="button button-quiet button-small" onClick={() => setDate("")}>All dates</button>}</div><div className="agenda-list">{[...meetings].sort((a, b) => a.start_at.localeCompare(b.start_at)).slice(0, 6).map(meeting => <article className="agenda-item" key={meeting.id}><div className="agenda-time"><Clock size={13} />{new Date(meeting.start_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</div><div className="agenda-details"><strong>{meeting.title}</strong><span>{(meeting.attendees ?? []).map(person => person.name).join(", ") || "No staff attendees"} &middot; {meeting.duration_min} min</span><div className="agenda-status"><span className={"status-pill " + (meeting.status === "completed" ? "pill-green" : meeting.status === "cancelled" ? "pill-red" : "pill-blue")}>{meeting.status.replaceAll("_", " ")}</span>{meeting.join_url && ["scheduled", "in_progress"].includes(meeting.status) && <a className="text-link" href={meeting.join_url} target="_blank" rel="noopener noreferrer">Join</a>}</div></div></article>)}{!meetings.length && <p className="empty-state">No meetings for this selection.</p>}</div></section></div>}
    <section className="panel"><div className="panel-heading"><div><h2>{date ? "Meetings on selected date" : "All meetings"}</h2><p>{meetings.length} matching meetings</p></div></div><div className="table-toolbar"><label>Filter date (local time) <input type="date" value={date} onChange={event => setDate(event.target.value)} /></label><button className="button button-secondary" onClick={() => setDate("")}>All dates</button></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>Meeting</th><th>Attendees</th><th>Start</th><th>Status</th><th>Actions</th></tr></thead><tbody>{meetings.map(meeting => <tr key={meeting.id}><td>{meeting.title}<span className="table-sub">{meeting.duration_min} min &middot; {meeting.zoom_meeting_id ? "Zoom" : "Internal"}</span></td><td>{(meeting.attendees ?? []).length ? meeting.attendees.map(person => person.name).join(", ") : <>&mdash;</>}</td><td>{new Date(meeting.start_at).toLocaleString()}</td><td><span className={"status-pill " + (meeting.status === "completed" ? "pill-green" : meeting.status === "cancelled" ? "pill-red" : "pill-blue")}>{meeting.status.replaceAll("_", " ")}</span></td><td><div className="heading-actions">{meeting.join_url && ["scheduled", "in_progress"].includes(meeting.status) && <a className="button button-secondary button-small" href={meeting.join_url} target="_blank" rel="noopener noreferrer">Join</a>}{(meeting.host_id === userId || canAdminManage) && (canManage || canAdminManage) && meeting.status === "scheduled" && <><button className="button button-secondary button-small" disabled={state.busy} onClick={() => setReschedule(meeting)}>Reschedule</button>{!meeting.zoom_meeting_id && <button className="button button-secondary button-small" disabled={state.busy} onClick={() => void state.mutate("/api/meetings/" + meeting.id, "PATCH", { action: "complete" })}>Complete</button>}<button className="button button-secondary button-small" disabled={state.busy} onClick={() => { if (confirm("Cancel this meeting?")) void state.mutate("/api/meetings/" + meeting.id, "PATCH", { action: "cancel" }); }}>Cancel</button></>}</div></td></tr>)}</tbody></table></div>
      {!state.loading && !meetings.length && <p style={{ padding: 20 }}>No accessible meetings match this date.</p>}
      <div className="table-footer">Latest 200 accessible internal meetings. Invitations are emailed to active staff attendees when SMTP is configured.</div>
    </section>
  </>;
}
