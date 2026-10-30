import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/server/auth";
import { formatDateTime } from "@/lib/crm-data";
import { RevokeSession } from "@/components/revoke-session";

export const dynamic = "force-dynamic";

export default async function LoginActivityPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { supabase, user } = await requireUser();
  if (user.profile.role !== "admin" && user.profile.role !== "super_admin") notFound();
  const query = await searchParams;
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const { data, error, count } = await supabase.from("login_sessions")
    .select("session_id,user_id,email,device,signed_in_at,last_seen_at,expires_at,signed_out_at", { count: "exact" })
    .is("signed_out_at", null).gt("expires_at", new Date().toISOString())
    .order("signed_in_at", { ascending: false }).range((page - 1) * 50, page * 50 - 1);
  if (error) throw error;
  return <>
    <div className="page-heading"><div><h1>Login activity</h1><p>Currently signed-in devices and last-used time. Signed-out and expired sessions are hidden.</p></div><Link className="button button-secondary" href="/admin/login-activity">Refresh</Link></div>
    <p className="helper-banner">Last used updates while the CRM tab is visible (at most once per minute). Device labels are approximate, not unique hardware identifiers. {user.profile.role === "super_admin" ? "You can revoke any active device session, including your current one." : "Only Super Admin can sign out device sessions."}</p>
    <section className="panel"><div className="table-wrap"><table className="data-table">
      <thead><tr><th>User</th><th>Signed in</th><th>Last used</th><th>Device</th><th>Status</th>{user.profile.role === "super_admin" && <th>Actions</th>}</tr></thead>
      <tbody>{data?.map((session) => <tr key={session.session_id}>
        <td>{session.email}</td><td>{formatDateTime(session.signed_in_at)}</td><td>{formatDateTime(session.last_seen_at)}</td>
        <td>{session.device}</td>
        <td>{session.signed_out_at ? `Signed out ${formatDateTime(session.signed_out_at)}` : new Date(session.expires_at) < new Date() ? "Expired" : "Signed in"}</td>
        {user.profile.role === "super_admin" && <td>{!session.signed_out_at && new Date(session.expires_at) > new Date() ? <RevokeSession sessionId={session.session_id} email={session.email} device={session.device} /> : "—"}</td>}
      </tr>)}</tbody>
    </table>{!data?.length && <p style={{ padding: 24 }}>No active device sessions on this page.</p>}</div>
    <div className="table-footer"><span>{count ?? 0} active sessions · Page {page}</span><div className="heading-actions">{page > 1 && <Link className="button button-secondary button-small" href={`/admin/login-activity?page=${page - 1}`}>Previous</Link>}{page * 50 < (count ?? 0) && <Link className="button button-secondary button-small" href={`/admin/login-activity?page=${page + 1}`}>Next</Link>}</div></div></section>
  </>;
}
