"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiRequest, errorMessage, formatDateTime } from "@/lib/crm-data";
import { notificationLeadPath, type NotificationData, type NotificationRow } from "@/lib/notifications";

export function NotificationsWorkspace() {
  const [data, setData] = useState<NotificationData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let active = true, pending = false;
    async function refresh() {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const result = await apiRequest<NotificationData>("/api/notifications");
        if (active) { setData(result); setError(""); }
      } catch (failure) { if (active) setError(errorMessage(failure, "Could not load notifications.")); }
      finally { pending = false; }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  async function markRead(row: NotificationRow) {
    if (row.is_read || busy) return;
    setBusy(row.id);
    try {
      await apiRequest("/api/notifications", { method: "PATCH", body: { id: row.id } });
      setData(previous => previous ? { unread: Math.max(0, previous.unread - 1), notifications: previous.notifications.map(item => item.id === row.id ? { ...item, is_read: true } : item) } : previous);
      window.dispatchEvent(new Event("crm-notifications-changed"));
    } catch (failure) { setError(errorMessage(failure, "Could not mark notification as read.")); }
    finally { setBusy(""); }
  }
  return <><div className="page-heading"><div><h1>Notifications</h1><p>Your latest 100 updates. Select an update to open its lead.</p></div></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="panel"><div className="panel-heading"><h2>Recent notifications{data ? ` (${data.unread} unread)` : ""}</h2></div>
      {!data && !error && <p className="loading-state" role="status">Loading notifications...</p>}
      <ul className="notification-list">{data?.notifications.map(row => {
        const href = notificationLeadPath(row);
        const content = <><strong>{typeof row.payload?.message === "string" ? row.payload.message : "New CRM activity"}</strong><span>{row.type.replaceAll("_", " ")} · {row.is_read ? "Read" : "Unread"}</span><time dateTime={row.created_at}>{formatDateTime(row.created_at)}</time></>;
        return <li key={row.id} className={row.is_read ? "" : "notification-unread"}>
          {href ? <Link href={href} prefetch={false}>{content}</Link> : <div>{content}</div>}
          {!row.is_read && <button className="button button-secondary button-small" disabled={Boolean(busy)} onClick={() => void markRead(row)}>{busy === row.id ? "Saving..." : "Mark read"}</button>}
        </li>;
      })}</ul>
      {data && !data.notifications.length && <p className="loading-state">No notifications yet.</p>}
    </section></>;
}
