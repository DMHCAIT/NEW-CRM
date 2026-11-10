export type NotificationRow = {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  lead_id: string | null;
  is_read: boolean;
  created_at: string;
};

export type NotificationData = { notifications: NotificationRow[]; unread: number };

export function notificationLeadPath(notification: NotificationRow) {
  const id = notification.lead_id ?? notification.payload?.lead_id;
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? `/leads/${id}` : undefined;
}
