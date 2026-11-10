"use client";

import Link from "next/link";
import { ArrowUpRight, Bell, BellRing, Check, CheckCheck, Clock3, Phone } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { apiRequest, errorMessage, formatDateTime, getCachedApiRead, subscribeApiWrites } from "@/lib/crm-data";
import { notificationLeadPath, type NotificationData, type NotificationRow } from "@/lib/notifications";

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function NotificationsWorkspace() {
  const [snapshot, setData] = useState<NotificationData | null>(() => getCachedApiRead<NotificationData>("/api/notifications", 15000) ?? null);
  // Cached client data must not replace the server's loading markup during hydration.
  const hydrated = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  const data = hydrated ? snapshot : null;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let active = true, pending = false, generation = 0;
    async function refresh() {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      const requestGeneration = ++generation;
      try {
        const result = await apiRequest<NotificationData>("/api/notifications", { maxAgeMs: 15000 });
        if (active && requestGeneration === generation) { setData(result); setError(""); }
      } catch (failure) { if (active && requestGeneration === generation) setError(errorMessage(failure, "Could not load notifications.")); }
      finally { if (requestGeneration === generation) pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    document.addEventListener("visibilitychange", refresh);
    const unsubscribe = subscribeApiWrites(() => { generation++; pending = false; void refresh(); }, "completed");
    return () => { active = false; window.clearInterval(timer); unsubscribe(); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  async function markRead(row: NotificationRow) {
    if (row.is_read || busy) return;
    setBusy(row.id);
    try {
      await apiRequest("/api/notifications", { method: "PATCH", body: { id: row.id } });
      setData(previous => previous && previous.notifications.some(item => item.id === row.id)
        ? { unread: Math.max(0, previous.unread - 1), notifications: previous.notifications.filter(item => item.id !== row.id) } : previous);
      window.dispatchEvent(new Event("crm-notifications-changed"));
    } catch (failure) { setError(errorMessage(failure, "Could not mark notification as read.")); }
    finally { setBusy(""); }
  }
  return <div className="notifications-workspace"><header className="page-heading notifications-heading"><span className="notifications-heading-icon" aria-hidden="true"><Bell size={23} /></span><div><h1>Notifications</h1><p>Your unread scheduled-call reminders. Select a reminder to open its lead.</p></div><span className="notifications-summary"><span aria-hidden="true" />{data ? `${data.unread} unread` : "Checking reminders"}</span></header>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="panel notifications-panel" aria-labelledby="notifications-list-title"><div className="panel-heading"><div><h2 id="notifications-list-title">Recent notifications{data ? ` (${data.unread} unread)` : ""}</h2><p>Stay on top of your scheduled follow-ups.</p></div><span className="notifications-scope"><Phone size={13} aria-hidden="true" />Scheduled calls only</span></div>
      {!data && !error && <div className="notifications-loading" role="status"><BellRing size={24} aria-hidden="true" /><p>Loading notifications...</p></div>}
      {Boolean(data?.notifications.length) && <ul className="notification-list">{data?.notifications.map(row => {
        const href = notificationLeadPath(row);
        const content = <><span className="notification-call-icon" aria-hidden="true"><Phone size={18} /></span><div className="notification-copy"><span className="notification-kind">Scheduled call · Unread</span><strong>{typeof row.payload?.message === "string" ? row.payload.message : "Scheduled call reminder"}</strong><time dateTime={row.created_at}><Clock3 size={12} aria-hidden="true" />{formatDateTime(row.created_at)}</time></div>{href && <ArrowUpRight className="notification-open-icon" size={17} aria-hidden="true" />}</>;
        return <li key={row.id} className={row.is_read ? "" : "notification-unread"}>
          {href ? <Link href={href} prefetch={false}>{content}</Link> : <div>{content}</div>}
          {!row.is_read && <button className="button button-secondary button-small" disabled={Boolean(busy)} onClick={() => void markRead(row)} aria-label={`Mark reminder as read: ${typeof row.payload?.message === "string" ? row.payload.message : "Scheduled call reminder"}`}><Check size={14} aria-hidden="true" />{busy === row.id ? "Saving..." : "Mark read"}</button>}
        </li>;
      })}</ul>}
      {data && !data.notifications.length && <div className="notifications-empty"><span className="notifications-empty-icon" aria-hidden="true"><CheckCheck size={32} /></span><h3>You&apos;re all caught up</h3><p>No unread scheduled-call reminders.</p><span>When a scheduled call is due, its reminder will appear here.</span></div>}
      <footer className="notifications-footer"><Bell size={14} aria-hidden="true" /><span>Reminders clear when marked as read or when the related lead is updated.</span></footer>
    </section></div>;
}
