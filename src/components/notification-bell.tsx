"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { apiRequest, errorMessage, subscribeApiWrites } from "@/lib/crm-data";
import type { NotificationData } from "@/lib/notifications";
import { useCallReminders } from "@/components/call-reminder-popups";

export function NotificationBell({ userId }: { userId: string }) {
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");
  const pathname = usePathname();
  const receive = useCallReminders()?.receive;
  function prepare() {
    void apiRequest<NotificationData>("/api/notifications", { maxAgeMs: 15000 })
      .catch(failure => setError(errorMessage(failure, "Notifications could not be loaded.")));
  }
  useEffect(() => {
    let active = true;
    let pending = false;
    let generation = 0;
    async function refresh() {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      const requestGeneration = ++generation;
      try {
        const data = await apiRequest<NotificationData>("/api/notifications", { maxAgeMs: 15000 });
        if (active && requestGeneration === generation) { setUnread(data.unread); receive?.(data); setError(""); }
      } catch (failure) {
        if (active && requestGeneration === generation) setError(errorMessage(failure, "Notifications could not be loaded."));
      } finally { if (requestGeneration === generation) pending = false; }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15000);
    const visible = () => void refresh();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("crm-notifications-changed", visible);
    const unsubscribe = subscribeApiWrites(() => { generation++; pending = false; void refresh(); }, "completed");
    return () => {
      active = false; window.clearInterval(interval); unsubscribe();
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("crm-notifications-changed", visible);
    };
  }, [userId, pathname, receive]);
  return <div className="notification-bell">
    <Link className="icon-button topbar-icon" href="/notifications" prefetch={true}
      onMouseEnter={prepare} onFocus={prepare} onTouchStart={prepare}
      aria-label={unread ? `Notifications (${unread} unread)` : "Notifications"}>
      <Bell size={19} />
      {unread > 0 && <span className="notification-badge">{unread > 99 ? "99+" : unread}</span>}
    </Link>
    {error && <span className="notification-load-error" role="alert" title={error}>Notifications unavailable</span>}
  </div>;
}
