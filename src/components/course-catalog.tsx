"use client";

import { useState } from "react";
import { BookOpen, Building2, Plus, RefreshCw, Search } from "lucide-react";
import { OperationFeedback, formValues, useOperationalData } from "@/app/integrations/operational-ui";
import type { BillingCompany, Course } from "@/lib/billing";
import { SectionLoading } from "@/components/section-loading";

const prices = {
  INR: new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }),
  USD: new Intl.NumberFormat("en-IN", { style: "currency", currency: "USD" }),
};

export function CourseCatalog({ leadCourse, onOpenInvoices }: { leadCourse?: string; onOpenInvoices?: () => void }) {
  const state = useOperationalData<{ courses: Course[]; companies: BillingCompany[]; canManage: boolean }>("/api/courses");
  const [editing, setEditing] = useState<Course | "new" | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [view, setView] = useState("catalog");
  const [page, setPage] = useState(0);
  const embedded = Boolean(onOpenInvoices);
  const Heading = embedded ? "h2" : "h1";
  const canManage = !embedded && state.data?.canManage;
  const courses = state.data?.courses ?? [];
  const filtered = courses.filter(course => (!status || course.is_active === (status === "active")) && course.name.toLowerCase().includes(search.trim().toLowerCase()));
  const pageIndex = Math.min(page, Math.max(0, Math.ceil(filtered.length / 25) - 1));
  const visible = filtered.slice(pageIndex * 25, (pageIndex + 1) * 25);
  const price = (value: number, currency: keyof typeof prices) => prices[currency].format(value);
  if (state.loading && !state.data) return <SectionLoading title="Courses" />;
  return <div className={`invoice-workspace course-workspace${embedded ? " invoice-embedded" : ""}`}>
    <header className={embedded ? "invoice-section-heading" : "page-heading invoice-page-heading"}><span className="invoice-heading-icon"><BookOpen size={23} /></span><div><div className="invoice-eyebrow">{embedded ? "RELATED RECORDS" : "PRODUCTS & PRICING"}</div><Heading>{embedded ? "Available courses" : "Courses"}</Heading><p>Standard course fees and invoice company profiles. INR and USD prices are maintained separately.</p></div><div className="heading-actions">
      <button className="button button-secondary" disabled={state.loading || state.busy} onClick={() => void state.refresh()}><RefreshCw size={14} />Refresh</button>
      {canManage && <button className="button button-primary" onClick={() => { setView("catalog"); setEditing("new"); }}><Plus size={16} />Add course</button>}
      {embedded && <button className="button button-primary" onClick={onOpenInvoices}>Open lead invoices</button>}</div>
    </header>
    <OperationFeedback {...state} />
    {embedded && <div className="course-enquiry"><BookOpen size={18} /><div><strong>Course enquiry: {leadCourse || "Not selected"}</strong><p>Catalog prices are a reference, not an enrollment. Confirm the course, currency and billing company when creating an invoice.</p></div></div>}
    {!embedded && <nav className="workspace-view-tabs" aria-label="Course workspace views"><button aria-current={view === "catalog" ? "page" : undefined} onClick={() => setView("catalog")}><BookOpen size={15} />Course catalog<span>{courses.length}</span></button><button aria-current={view === "companies" ? "page" : undefined} onClick={() => setView("companies")}><Building2 size={15} />Invoice companies<span>{state.data?.companies.length ?? 0}</span></button></nav>}
    {editing && canManage && view === "catalog" && <section className="panel course-editor"><div className="panel-heading"><div><h2>{editing === "new" ? "Add course" : "Edit course"}</h2><p>Changes apply to new invoices only.</p></div></div>
      <form key={editing === "new" ? "new" : editing.id} className="operational-form" onSubmit={async event => {
        event.preventDefault();
        const values = formValues(event.currentTarget);
        if (await state.mutate("/api/courses", "POST", { kind: "course", ...(editing === "new" ? {} : { id: editing.id }),
          values: { ...values, is_active: values.is_active === "on" } })) setEditing(null);
      }}><fieldset disabled={state.busy}>
        <label>Course name<input className="form-input" name="name" required maxLength={200} defaultValue={editing === "new" ? "" : editing.name} /></label>
        <label>Standard price (INR)<input className="form-input" name="price_inr" type="number" min={1} max={99999999} step="0.01" required defaultValue={editing === "new" ? "" : editing.price_inr} /></label>
        <label>Standard price (USD)<input className="form-input" name="price_usd" type="number" min={1} max={99999999} step="0.01" required defaultValue={editing === "new" ? "" : editing.price_usd} /></label>
        <label><input name="is_active" type="checkbox" defaultChecked={editing === "new" || editing.is_active} />Available for new invoices</label>
      </fieldset><button className="button button-primary" disabled={state.busy}>Save course</button><button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button></form>
    </section>}
    {view === "catalog" && <section className="panel course-register"><div className="panel-heading"><div><h2>Course catalog</h2><p>{courses.filter(course => course.is_active).length} active courses · Prices before invoice tax and discounts</p></div></div><div className="table-toolbar"><label className="toolbar-search"><Search size={16} /><input type="search" aria-label="Search courses" placeholder="Search course name" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label><label className="course-status-filter">Availability<select value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="active">Active courses</option><option value="">All courses</option><option value="inactive">Inactive courses</option></select></label></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Course</th><th>INR price</th><th>USD price</th><th>Status</th>{canManage && <th>Action</th>}</tr></thead>
      <tbody>{visible.map(course => <tr key={course.id}><td><strong>{course.name}</strong>{embedded && course.name.toLowerCase() === leadCourse?.toLowerCase() && <small className="course-match">Current enquiry</small>}</td><td>{price(Number(course.price_inr), "INR")}</td><td>{price(Number(course.price_usd), "USD")}</td><td><span className={`invoice-status is-${course.is_active ? "paid" : "cancelled"}`}>{course.is_active ? "Active" : "Inactive"}</span></td>{canManage && <td><button className="button button-secondary" onClick={() => setEditing(course)}>Edit</button></td>}</tr>)}</tbody>
    </table></div>{state.data && !filtered.length && <div className="invoice-empty"><BookOpen size={30} /><h3>{courses.length ? "No matching courses" : "No courses yet"}</h3><p>{courses.length ? "Try another name or availability filter." : "An administrator can add standard prices here."}</p></div>}<div className="table-footer workspace-pagination"><span>{filtered.length ? pageIndex * 25 + 1 : 0}–{Math.min((pageIndex + 1) * 25, filtered.length)} of {filtered.length} courses</span><div><button className="button button-secondary" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>Previous</button><button className="button button-secondary" disabled={(pageIndex + 1) * 25 >= filtered.length} onClick={() => setPage(pageIndex + 1)}>Next</button></div></div></section>}
    {!embedded && view === "companies" && <section className="panel course-companies"><div className="panel-heading"><div><h2>Invoice companies</h2><p>Complete the legal name and billing address before issuing. These details and colors are copied to each invoice; later edits do not change historical invoices.</p></div></div><div className="course-company-grid">
      {state.data?.companies.map(company => <form key={JSON.stringify(company)} className="operational-form" onSubmit={async event => {
        event.preventDefault(); await state.mutate("/api/courses", "POST", { kind: "company", values: { ...formValues(event.currentTarget), code: company.code } });
      }}><fieldset disabled={!state.data?.canManage || state.busy}><legend>{company.code}</legend>
        <label>Legal billing name<input className="form-input" name="legal_name" required maxLength={200} defaultValue={company.legal_name} /></label>
        <label>Company billing address<textarea className="form-input" name="address" required rows={3} maxLength={2000} defaultValue={company.address} /></label>
        <label>Tax registration ID (if applicable)<input className="form-input" name="tax_id" maxLength={100} defaultValue={company.tax_id} /></label>
        <label>Primary color<input name="primary_color" type="color" defaultValue={company.primary_color} /></label>
        <label>Accent color<input name="accent_color" type="color" defaultValue={company.accent_color} /></label>
      </fieldset>{state.data?.canManage && <button className="button button-primary" disabled={state.busy}>Save {company.code} profile</button>}</form>)}
    </div></section>}
  </div>;
}
