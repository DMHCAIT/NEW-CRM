"use client";

import { useState } from "react";
import { BookOpen, Check, Plus, RefreshCw, Search } from "lucide-react";
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
    <header className={embedded ? "invoice-section-heading" : "page-heading invoice-page-heading"}><span className="invoice-heading-icon"><BookOpen size={23} /></span><div><div className="invoice-eyebrow">{embedded ? "RELATED RECORDS" : "PRODUCTS & PRICING"}</div><Heading>{embedded ? "Available courses" : "Courses"}</Heading><p>Manage your course catalog and standard fees. INR and USD prices are maintained separately.</p></div><div className="heading-actions">
      <button className="button button-secondary" disabled={state.loading || state.busy} onClick={() => void state.refresh()}><RefreshCw size={14} />Refresh</button>
      {canManage && <button className="button button-primary" onClick={() => setEditing("new")}><Plus size={16} />Add course</button>}
      {embedded && <button className="button button-primary" onClick={onOpenInvoices}>Open lead invoices</button>}</div>
    </header>
    <OperationFeedback {...state} />
    {embedded && <div className="course-enquiry"><BookOpen size={18} /><div><strong>Course enquiry: {leadCourse || "Not selected"}</strong><p>Catalog prices are a reference, not an enrollment. Confirm the course, currency and billing company when creating an invoice.</p></div></div>}
    {editing && canManage && <section className="panel course-editor" aria-labelledby="course-editor-title"><div className="panel-heading"><div className="course-editor-heading"><span className="course-editor-icon" aria-hidden="true"><BookOpen size={20} /></span><div><h2 id="course-editor-title">{editing === "new" ? "Add course" : "Edit course"}</h2><p>Set course availability and pricing for new invoices.</p></div></div><span className="course-editor-tag">Course setup</span></div>
      <form key={editing === "new" ? "new" : editing.id} className="course-edit-form" onSubmit={async event => {
        event.preventDefault();
        const values = formValues(event.currentTarget);
        if (await state.mutate("/api/courses", "POST", { kind: "course", ...(editing === "new" ? {} : { id: editing.id }),
          values: { ...values, is_active: values.is_active === "on" } })) setEditing(null);
      }}><fieldset className="course-details-fields" disabled={state.busy}><legend>Course details</legend>
        <label className="course-name-field">Course name <span className="course-required">Required</span><input className="form-input" name="name" required maxLength={200} placeholder="Enter the full course name" defaultValue={editing === "new" ? "" : editing.name} /></label>
        <label className="course-availability"><input name="is_active" type="checkbox" defaultChecked={editing === "new" || editing.is_active} /><span><strong>Available for new invoices</strong><small>Inactive courses remain on existing invoices.</small></span></label>
      </fieldset><fieldset className="course-pricing-fields" disabled={state.busy}><legend>Standard pricing</legend>
        <label><span className="course-price-label">DMHCA price (INR)<span>INR</span></span><input className="form-input" name="price_inr" type="number" min={1} max={99999999} step="0.01" required defaultValue={editing === "new" ? "" : editing.price_inr} /><small>Domestic course fee</small></label>
        <label><span className="course-price-label">DMHCA price (USD)<span>USD</span></span><input className="form-input" name="price_usd" type="number" min={1} max={99999999} step="0.01" required defaultValue={editing === "new" ? "" : editing.price_usd} /><small>International course fee</small></label>
        <label><span className="course-price-label">IBMP price (USD)<span>USD</span></span><input className="form-input" name="price_ibmp_usd" type="number" min={1} max={99999999} step="0.01" defaultValue={editing === "new" ? "" : editing.price_ibmp_usd ?? ""} /><small>Optional. Leave blank to disable new IBMP invoices.</small></label>
      </fieldset><div className="course-editor-footer"><p>Changes apply to new invoices only.</p><div><button type="button" className="button button-secondary" disabled={state.busy} onClick={() => setEditing(null)}>Cancel</button><button className="button button-primary" disabled={state.busy}><Check size={15} />{state.busy ? "Saving..." : "Save course"}</button></div></div></form>
    </section>}
    <section className="panel course-register"><div className="panel-heading"><div><h2>Course catalog</h2><p>{courses.filter(course => course.is_active).length} active courses · Prices before invoice tax and discounts</p></div></div><div className="table-toolbar"><label className="toolbar-search"><Search size={16} /><input type="search" aria-label="Search courses" placeholder="Search course name" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label><label className="course-status-filter">Availability<select value={status} onChange={event => { setStatus(event.target.value); setPage(0); }}><option value="active">Active courses</option><option value="">All courses</option><option value="inactive">Inactive courses</option></select></label></div><div className="table-wrap"><table className="data-table"><thead><tr><th>Course</th><th>DMHCA INR</th><th>DMHCA USD</th><th>IBMP USD</th><th>Status</th>{canManage && <th>Action</th>}</tr></thead>
      <tbody>{visible.map(course => <tr key={course.id}><td><strong>{course.name}</strong>{embedded && course.name.toLowerCase() === leadCourse?.toLowerCase() && <small className="course-match">Current enquiry</small>}</td><td>{price(Number(course.price_inr), "INR")}</td><td>{price(Number(course.price_usd), "USD")}</td><td>{course.price_ibmp_usd == null ? "Not configured" : price(Number(course.price_ibmp_usd), "USD")}</td><td><span className={`invoice-status is-${course.is_active ? "paid" : "cancelled"}`}>{course.is_active ? "Active" : "Inactive"}</span></td>{canManage && <td><button className="button button-secondary" onClick={() => setEditing(course)}>Edit</button></td>}</tr>)}</tbody>
    </table></div>{state.data && !filtered.length && <div className="invoice-empty"><BookOpen size={30} /><h3>{courses.length ? "No matching courses" : "No courses yet"}</h3><p>{courses.length ? "Try another name or availability filter." : "An administrator can add standard prices here."}</p></div>}<div className="table-footer workspace-pagination"><span>{filtered.length ? pageIndex * 25 + 1 : 0}–{Math.min((pageIndex + 1) * 25, filtered.length)} of {filtered.length} courses</span><div><button className="button button-secondary" disabled={pageIndex === 0} onClick={() => setPage(pageIndex - 1)}>Previous</button><button className="button button-secondary" disabled={(pageIndex + 1) * 25 >= filtered.length} onClick={() => setPage(pageIndex + 1)}>Next</button></div></div></section>
  </div>;
}
