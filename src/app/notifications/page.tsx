import { requireUser } from "@/lib/server/auth";
import { formatDateTime } from "@/lib/crm-data";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.from("notifications").select("id,type,payload,created_at")
    .order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  return <><div className="page-heading"><div><h1>Notifications</h1><p>Your latest 100 recorded notifications.</p></div></div>
    <section className="panel"><div className="panel-heading"><div><h2>Recent notifications</h2><p>{data?.length ?? 0} recorded updates</p></div></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Type</th><th>Message</th><th>Created</th></tr></thead><tbody>
      {data?.map((notification) => <tr key={notification.id}><td><span className="status-pill pill-blue">{notification.type}</span></td><td className="notification-message">{typeof notification.payload?.message === "string" ? notification.payload.message : "New CRM activity"}</td><td>{formatDateTime(notification.created_at)}</td></tr>)}
    </tbody></table>{!data?.length && <p style={{ padding: 24 }}>No notifications yet.</p>}</div></section></>;
}
