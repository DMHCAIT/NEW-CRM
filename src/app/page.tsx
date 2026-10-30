import Link from "next/link";
import { requireUser } from "@/lib/server/auth";
import { fetchStages } from "@/lib/crm-data";
import { BarChart3, CalendarClock, CheckCircle2, Users, UserPlus } from "lucide-react";
import { CONVERSION_STAGES, dashboardCriterion as criterion, dashboardLink } from "@/lib/dashboard";
import { fetchDashboardSummary } from "@/lib/server/dashboard-summary";
import { DashboardBarChart } from "@/components/dashboard-bar-chart";
import "./dashboard.css";

export const dynamic = "force-dynamic";

const chartColors = {
  blue: "#7187a3",
  teal: "#70968c",
  lavender: "#9185a1",
  sand: "#b19b73",
  rose: "#ae8b94",
  steel: "#7f9aa6",
  olive: "#969c78",
  clay: "#a68e7d",
};

export default async function DashboardPage() {
  const { supabase, user } = await requireUser("dashboard.view");
  const [summary, stages] = await Promise.all([
    fetchDashboardSummary(supabase),
    fetchStages(supabase, { includeInactive: true }),
  ]);
  const total = summary.total;
  const today = new Date().toISOString().slice(0, 10);
  const terminal = new Set(stages.filter((stage) => stage.is_terminal).map((stage) => stage.name));
  const due = summary.overdue + summary.dueToday;
  const daily = Array.from({ length: 7 }, (_, index) => {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() - 6 + index);
    const key = day.toISOString().slice(0, 10);
    return { key, label: day.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }), count: summary.daily[key] ?? 0 };
  });
  const maximum = Math.max(2, ...daily.map(day => day.count));
  const convertedCriteria = [criterion("stage", "in", CONVERSION_STAGES.join("\n"))];
  const converted = summary.converted;
  const combinations = summary.combinations;
  const dueCriteria = [criterion("followUpAt", "on_or_before", today), ...(terminal.size ? [criterion("stage", "not_in", [...terminal].join("\n"))] : [])];
  const scopeLabel = user.profile.role === "counselor" ? "My leads" : user.profile.role === "team_lead" ? "My team" : user.profile.role === "manager" ? "My reporting hierarchy" : "Entire organization";
  const stageNames = [...new Set([...stages.map(stage => stage.name), ...summary.stages.map(stage => stage.stage_name)])];
  const palette = Object.values(chartColors);
  const stageColor = (name: string) => palette[Math.max(0, stageNames.indexOf(name)) % palette.length];
  const conversionRate = total ? converted / total * 100 : 0;
  function breakdown(field: "course" | "country") {
    const groups = summary[field].map(group => ({ ...group, rate: group.total ? group.converted / group.total * 100 : 0, stages: new Map(Object.entries(group.stages)) }));
    const title = field === "course" ? "Course" : "Country";
    const groupCriteria = (name: string) => [criterion(field, name ? "is" : "is_empty", name)];
    const ranking = summary[field === "course" ? "courseLeaders" : "countryLeaders"].map(group => ({ ...group, rate: group.converted / group.total * 100 }));
    return <>
      <section className="panel dashboard-breakdown"><div className="panel-heading"><div><h2>Leads by {field}</h2><p>Top 30 by lead count · Current stages · {scopeLabel}</p></div><span className="dashboard-panel-count">{groups.length} {field === "course" ? "courses" : "countries"}</span></div>
        <DashboardBarChart label={`Leads by ${field} and stage`} emptyMessage="No leads available in your scope. Chart updates when leads are added." categories={groups.map(group => ({
          label: group.name || "Not specified",
          href: dashboardLink(groupCriteria(group.name), `${title}: ${group.name || "Not specified"}`),
          segments: [...group.stages].map(([stage, count]) => ({
            label: stage || "No stage", value: count, color: stageColor(stage),
            href: dashboardLink([...groupCriteria(group.name), criterion("stage", stage ? "is" : "is_empty", stage)], `${group.name || "Not specified"} / ${stage || "No stage"}`),
          })),
        }))} legend={stageNames.filter(stage => summary.stages.some(group => group.stage_name === stage && group.total > 0)).map(stage => ({
          label: stage || "No stage", color: stageColor(stage),
          href: dashboardLink([criterion("stage", stage ? "is" : "is_empty", stage)], `${stage || "No stage"} leads`),
        }))} />
      </section>
      <section className="panel dashboard-ranking"><div className="panel-heading"><div><h2>{title} conversion leaders</h2><p>Ranked by conversion rate, then converted lead count</p></div></div>
        <DashboardBarChart label={`${title} conversion leaders`} percent emptyMessage="No conversions recorded yet." categories={ranking.slice(0, 8).map(group => {
          const href = dashboardLink([...groupCriteria(group.name), ...convertedCriteria], `${group.name || "Not specified"} conversions`);
          return { label: group.name || "Not specified", detail: `${group.converted} / ${group.total} leads`, href,
            segments: [{ label: "Converted", value: group.rate, color: chartColors.teal, href }] };
        })} />
        <p className="dashboard-conversion-note">Converted = Closed Won + Already Enrolled. Rate = converted ÷ total leads; all time.</p>
      </section>
    </>;
  }
  return <div className="dashboard-workspace">
    <div className="page-heading dashboard-heading"><div><div className="dashboard-eyebrow"><BarChart3 size={15} aria-hidden="true" />Admissions overview <span>{scopeLabel}</span></div><h1>Welcome, {user.profile.fullName}</h1><p>Live admissions activity for records you can access.</p></div>
    </div>
    <div className="kpi-grid dashboard-kpis">{[
      { label: "Accessible leads", value: total, icon: Users, detail: scopeLabel, href: dashboardLink() },
      { label: "New today (UTC)", value: summary.newToday, icon: UserPlus, detail: "Created since midnight UTC", href: dashboardLink([criterion("createdAt", "is", today)], "New today (UTC)") },
      { label: "Follow-ups due", value: due, icon: CalendarClock, detail: "Due today or overdue (UTC)", href: dashboardLink(dueCriteria, "Follow-ups due") },
      { label: "Converted leads", value: converted, icon: CheckCircle2, detail: `${conversionRate.toFixed(1)}% overall conversion`, href: dashboardLink(convertedCriteria, "Converted leads") },
    ].map(({ label, value, icon: Icon, detail, href }) => <Link href={href} className="panel kpi-card" key={label}><div className="kpi-head"><span>{label}</span><span className="kpi-icon"><Icon size={16} /></span></div><div className="kpi-value">{value}</div><div className="kpi-trend">{detail}</div></Link>)}</div>
    <div className="overview-grid">
      <section className="panel chart-panel"><div className="panel-heading"><div><h2>Lead activity</h2><p>New accessible leads over the last seven days (UTC)</p></div><Link href={dashboardLink([criterion("createdAt", "on_or_after", daily[0].key), criterion("createdAt", "on_or_before", today)], "Last seven days (UTC)")} className="chart-total">{daily.reduce((sum, day) => sum + day.count, 0)} leads</Link></div>
        <div className="chart-area live-trend-chart"><div className="chart-legend"><span><i className="legend-dot" />New leads</span></div><div className="chart"><div className="chart-y"><span>{maximum}</span><span>{maximum / 2}</span><span>0</span></div><div className="chart-main"><div className="chart-lines"><div className="chart-bars">{daily.map(day => <div className="bar-group" key={day.key}><Link href={dashboardLink([criterion("createdAt", "is", day.key)], `${day.label} new leads`)} className="bar main" style={{ height: `${Math.max(2, day.count / maximum * 100)}%` }} title={`${day.label}: ${day.count} leads`}><span className="visually-hidden">{day.label}: {day.count} leads</span></Link></div>)}</div></div><div className="chart-x">{daily.map(day => <Link href={dashboardLink([criterion("createdAt", "is", day.key)], `${day.label} new leads`)} key={day.key}>{day.label}</Link>)}</div></div></div>{daily.every(day => day.count === 0) && <p className="chart-empty">No leads created in the last seven days.</p>}</div>
      </section>
      <section className="panel"><div className="panel-heading"><div><h2>Leads by stage</h2><p>Distribution across your accessible leads</p></div>{user.permissions.includes("pipeline.view") && <Link href="/pipeline">Open pipeline</Link>}</div>
        <div className="stage-summary">{stages.map((stage) => {
          const count = summary.stages.find(group => group.stage_id === stage.id)?.total ?? 0;
          return <Link href={dashboardLink([criterion("stage", "is", stage.name)], `${stage.name} leads`)} className="stage-row dashboard-stage-row" key={stage.id}><span>{stage.name}</span><div className="stage-bar-track" aria-hidden="true"><div className="stage-bar" style={{ width: `${total ? count / total * 100 : 0}%`, background: stageColor(stage.name) }} /></div><strong className="stage-count">{count}</strong></Link>;
        })}{!stages.length && <p className="empty-state">No active stages configured.</p>}</div>
      </section>
    </div>
    <div className="dashboard-analytics-grid">{breakdown("course")}{breakdown("country")}</div>
    <section className="panel dashboard-combination-panel"><div className="panel-heading"><div><h2>Country + course conversion</h2><p>Top 30 country and course combinations by conversion rate · {scopeLabel}</p></div><span className="dashboard-panel-count">{combinations.length} combinations</span></div>
      <DashboardBarChart label="Country + course conversion" percent emptyMessage="No leads available in your scope. Chart updates when leads are added." categories={combinations.map(group => {
        const label = `${group.country || "Not specified"} / ${group.course || "Not specified"}`;
        const criteria = [criterion("country", group.country ? "is" : "is_empty", group.country), criterion("course", group.course ? "is" : "is_empty", group.course)];
        return { label, detail: `${group.converted} / ${group.total} leads`, href: dashboardLink(criteria, label),
          segments: [{ label: "Converted", value: group.rate, color: chartColors.teal, href: dashboardLink([...criteria, ...convertedCriteria], `${label} conversions`) }] };
      })} />
      <p className="dashboard-conversion-note">Converted = Closed Won + Already Enrolled. Rate = converted leads in this country and course ÷ total leads in the same combination; all time. Includes combinations with 0% conversion.</p>
    </section>
    <div className="bottom-grid"><section className="panel"><div className="panel-heading"><div><h2>Conversion overview</h2><p>Converted versus other leads in your scope</p></div></div>
      <div className="dashboard-donut-layout"><svg className="dashboard-donut" viewBox="0 0 42 42" aria-label={`${converted} converted of ${total} leads`}>
        <circle cx="21" cy="21" r="15.9155" fill="none" stroke="#edf2f7" strokeWidth="6" />
        {total > converted && <a href={dashboardLink([criterion("stage", "not_in", CONVERSION_STAGES.join("\n"))], "Other leads")} aria-label={`${total - converted} other leads`}><circle cx="21" cy="21" r="15.9155" fill="none" stroke={chartColors.blue} strokeWidth="6" pathLength="100" strokeDasharray={`${100 - conversionRate} ${conversionRate}`} strokeDashoffset={-conversionRate} transform="rotate(-90 21 21)"><title>{`${total - converted} other leads`}</title></circle></a>}
        {converted > 0 && <a href={dashboardLink(convertedCriteria, "Converted leads")} aria-label={`${converted} converted leads`}><circle cx="21" cy="21" r="15.9155" fill="none" stroke={chartColors.teal} strokeWidth="6" pathLength="100" strokeDasharray={`${conversionRate} ${100 - conversionRate}`} transform="rotate(-90 21 21)"><title>{`${converted} converted leads`}</title></circle></a>}
        <text x="21" y="20.5" textAnchor="middle" className="dashboard-donut-value">{conversionRate.toFixed(1)}%</text><text x="21" y="25" textAnchor="middle" className="dashboard-donut-caption">conversion</text>
      </svg><div className="dashboard-donut-legend"><Link href={dashboardLink(convertedCriteria, "Converted leads")}><i style={{ background: chartColors.teal }} />Converted<strong>{converted}</strong></Link><Link href={dashboardLink([criterion("stage", "not_in", CONVERSION_STAGES.join("\n"))], "Other leads")}><i style={{ background: chartColors.blue }} />Other leads<strong>{total - converted}</strong></Link></div></div>
      <p className="dashboard-conversion-note">Converted = Closed Won + Already Enrolled. All-time conversion rate.</p>
    </section><section className="panel"><div className="panel-heading"><div><h2>Follow-ups needing attention</h2><p>Due today and overdue leads (UTC), excluding terminal stages</p></div></div>
      <div className="dashboard-followup-chart">{[
        { label: "Overdue", operator: "before" as const, count: summary.overdue, color: chartColors.clay },
        { label: "Due today", operator: "is" as const, count: summary.dueToday, color: chartColors.blue },
      ].map(item => <Link className="dashboard-followup-row" key={item.label} href={dashboardLink([criterion("followUpAt", item.operator, today), ...dueCriteria.slice(1)], item.label)} aria-label={`${item.label}: ${item.count} leads`}><span>{item.label}</span><div className="dashboard-followup-track"><i style={{ width: `${due ? item.count / due * 100 : 0}%`, background: item.color }} /></div><strong>{item.count}</strong></Link>)}{!due && <p className="empty-state">No follow-ups due.</p>}</div>
    </section></div>
  </div>;
}
