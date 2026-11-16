"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUpRight, GripHorizontal, Phone, X } from "lucide-react";
import { apiRequest, errorMessage, formatDateTime } from "@/lib/crm-data";
import { notificationLeadPath, type NotificationData, type NotificationRow } from "@/lib/notifications";

type ReminderContext = {
  receive: (data: NotificationData) => void;
  queueActive: boolean;
  reminders: NotificationRow[];
  openedReminderIds: string[];
  open: (row: NotificationRow) => void;
};
const CallReminderContext = createContext<ReminderContext | null>(null);

export function useCallReminders() {
  return useContext(CallReminderContext);
}

export function CallReminderProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [reminders, setReminders] = useState<NotificationRow[]>([]);
  const [queueActive, setQueueActive] = useState(false);
  const [busy, setBusy] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [openedReminderIds, setOpenedReminderIds] = useState<string[]>([]);
  const dismissed = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const failedReminder = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const receive = useCallback((data: NotificationData) => {
    setReminders(data.notifications.filter(row => row.type === "call_due" && !row.is_read
      && notificationLeadPath(row) && !dismissed.current.has(row.id)));
    if (failedReminder.current && !data.notifications.some(row => row.id === failedReminder.current && !row.is_read)) {
      failedReminder.current = null;
      setError("");
    }
  }, []);

  const dismiss = useCallback(async (row: NotificationRow) => {
    if (pending.current.has(row.id) || dismissed.current.has(row.id)) return;
    pending.current.add(row.id);
    setBusy(previous => [...previous, row.id]);
    setError("");
    try {
      await apiRequest("/api/notifications", { method: "PATCH", body: { id: row.id } });
      dismissed.current.add(row.id);
      if (mounted.current) {
        setReminders(previous => previous.filter(item => item.id !== row.id));
        window.dispatchEvent(new Event("crm-notifications-changed"));
      }
    } catch (failure) {
      if (mounted.current) {
        failedReminder.current = row.id;
        setError(errorMessage(failure, "Could not dismiss the call reminder. Please retry using X."));
      }
    } finally {
      pending.current.delete(row.id);
      if (mounted.current) setBusy(previous => previous.filter(id => id !== row.id));
    }
  }, []);

  useEffect(() => {
    if (!/^\/leads\/[0-9a-f-]{36}$/i.test(pathname)) {
      setQueueActive(false);
      setOpenedReminderIds([]);
    }
  }, [pathname]);

  function open(row: NotificationRow) {
    const href = notificationLeadPath(row);
    if (!href) return;
    setQueueActive(true);
    setOpenedReminderIds(previous => [...new Set([...previous, row.id,
      ...reminders.filter(item => notificationLeadPath(item) === href).map(item => item.id)])]);
    if (href !== pathname) router.push(href);
  }

  return <CallReminderContext.Provider value={{ receive, queueActive, reminders, openedReminderIds, open }}>
    {children}
    <ReminderWindow reminders={reminders} busy={busy} error={error} open={open} dismiss={row => void dismiss(row)} />
  </CallReminderContext.Provider>;
}

function ReminderWindow({ reminders, busy, error, open, dismiss }: {
  reminders: NotificationRow[]; busy: string[]; error: string;
  open: (row: NotificationRow) => void; dismiss: (row: NotificationRow) => void;
}) {
  const [ready, setReady] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const visible = reminders.length > 0 || Boolean(error);
  useEffect(() => { setReady(true); }, []);
  useLayoutEffect(() => {
    if (!ready || !visible) return;
    const fit = () => {
      const element = panel.current;
      if (!element) return;
      const { width, height } = element.getBoundingClientRect();
      setPosition(previous => ({
        left: Math.max(8, Math.min(previous?.left ?? (window.innerWidth - width) / 2, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(previous?.top ?? (window.innerHeight - height) / 2, window.innerHeight - height - 8)),
      }));
    };
    fit();
    window.addEventListener("resize", fit);
    const observer = new ResizeObserver(fit);
    if (panel.current) observer.observe(panel.current);
    return () => { observer.disconnect(); window.removeEventListener("resize", fit); };
  }, [ready, visible]);
  useEffect(() => { if (!visible) setPosition(null); }, [visible]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !panel.current) return;
    const rect = panel.current.getBoundingClientRect();
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId || !panel.current) return;
    const rect = panel.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(current.left + event.clientX - current.x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(current.top + event.clientY - current.y, window.innerHeight - rect.height - 8)),
    });
  }
  function stopDrag() { drag.current = null; }

  if (!ready || !visible) return null;
  return createPortal(<div ref={panel} className="call-reminder-popup" role="region" aria-label="Scheduled call reminders"
    style={position ? { left: position.left, top: position.top } : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}>
    <div className="call-reminder-drag-handle" onPointerDown={startDrag} onPointerMove={moveDrag}
      onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
      <Phone size={17} aria-hidden="true" /><strong>Scheduled calls ({reminders.length})</strong>
      <GripHorizontal size={20} aria-hidden="true" /><span>Drag to move</span>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="call-reminder-popup-list" aria-live="polite" aria-relevant="additions removals">
      {reminders.map(row => <div className="call-reminder-popup-item" key={row.id}>
        <button type="button" className="call-reminder-open" onClick={() => open(row)}>
          <strong>{typeof row.payload?.message === "string" ? row.payload.message : "Scheduled call is due"}</strong>
          <time dateTime={row.created_at}>{formatDateTime(row.created_at)}</time>
          <span>Open lead<ArrowUpRight size={14} aria-hidden="true" /></span>
        </button>
        <button type="button" className="icon-button call-reminder-dismiss" disabled={busy.includes(row.id)}
          aria-label={`Dismiss call reminder: ${typeof row.payload?.message === "string" ? row.payload.message : "Scheduled call is due"}`}
          onClick={() => dismiss(row)}><X size={18} aria-hidden="true" /></button>
      </div>)}
    </div>
    <p className="call-reminder-popup-footer">Open any lead, then use Next for the remaining call reminders.</p>
  </div>, document.body);
}
