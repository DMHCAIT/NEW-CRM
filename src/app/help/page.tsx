import { CircleHelp, FileText, MessageCircle } from "lucide-react";
import Link from "next/link";

export default function HelpPage() {
  return <>
    <div className="page-heading"><div><h1>Help & support</h1><p>Find guidance for using the admissions CRM.</p></div></div>
    <div className="integration-grid">
      <section className="panel integration-card"><div className="integration-card-head"><div className="integration-logo"><FileText size={17} /></div><h3>CRM guide</h3></div><p>Learn about leads, follow-ups, pipeline stages and role-based visibility.</p><Link className="text-link" href="/leads">Open Leads</Link></section>
      <section className="panel integration-card"><div className="integration-card-head"><div className="integration-logo"><CircleHelp size={17} /></div><h3>Admin configuration</h3></div><p>Administrators can configure role access, stages, duplicate behavior and CRM defaults.</p><Link className="text-link" href="/settings/access">Open access control</Link></section>
      <section className="panel integration-card"><div className="integration-card-head"><div className="integration-logo"><MessageCircle size={17} /></div><h3>Support</h3></div><p>Contact your system administrator for account, access or integration assistance.</p></section>
    </div>
  </>;
}
