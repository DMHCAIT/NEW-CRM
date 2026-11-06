"use client";

import { useState } from "react";
import { BookOpen, Plus } from "lucide-react";
import { OperationFeedback, formValues, useOperationalData } from "@/app/integrations/operational-ui";
import type { BillingCompany, Course } from "@/lib/billing";

export default function CoursesPage() {
  const state = useOperationalData<{ courses: Course[]; companies: BillingCompany[]; canManage: boolean }>("/api/courses");
  const [editing, setEditing] = useState<Course | "new" | null>(null);
  return <div className="invoice-workspace">
    <header className="page-heading"><div><h1><BookOpen size={24} /> Courses</h1><p>Standard course fees and invoice company profiles. INR and USD prices are maintained separately.</p></div>
      {state.data?.canManage && <button className="button button-primary" onClick={() => setEditing("new")}><Plus size={16} />Add course</button>}
    </header>
    <OperationFeedback {...state} />
    {editing && state.data?.canManage && <section className="panel"><h2>{editing === "new" ? "Add course" : "Edit course"}</h2>
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
    <section className="panel"><h2>Course catalog</h2><div className="table-wrap"><table className="data-table"><thead><tr><th>Course</th><th>INR price</th><th>USD price</th><th>Status</th>{state.data?.canManage && <th>Action</th>}</tr></thead>
      <tbody>{state.data?.courses.map(course => <tr key={course.id}><td>{course.name}</td><td>{Number(course.price_inr).toFixed(2)} INR</td><td>{Number(course.price_usd).toFixed(2)} USD</td><td>{course.is_active ? "Active" : "Inactive"}</td>{state.data?.canManage && <td><button className="button button-secondary" onClick={() => setEditing(course)}>Edit</button></td>}</tr>)}</tbody>
    </table></div>{state.data && !state.data.courses.length && <p>No courses yet. An administrator can add standard prices here.</p>}</section>
    <section className="panel"><h2>Invoice companies</h2><p>Complete the legal name and billing address before issuing. These details and colors are copied to each invoice; later edits do not change historical invoices.</p>
      {state.data?.companies.map(company => <form key={JSON.stringify(company)} className="operational-form" onSubmit={async event => {
        event.preventDefault(); await state.mutate("/api/courses", "POST", { kind: "company", values: { ...formValues(event.currentTarget), code: company.code } });
      }}><fieldset disabled={!state.data?.canManage || state.busy}><legend>{company.code}</legend>
        <label>Legal billing name<input className="form-input" name="legal_name" required maxLength={200} defaultValue={company.legal_name} /></label>
        <label>Company billing address<textarea className="form-input" name="address" required rows={3} maxLength={2000} defaultValue={company.address} /></label>
        <label>Tax registration ID (if applicable)<input className="form-input" name="tax_id" maxLength={100} defaultValue={company.tax_id} /></label>
        <label>Primary color<input name="primary_color" type="color" defaultValue={company.primary_color} /></label>
        <label>Accent color<input name="accent_color" type="color" defaultValue={company.accent_color} /></label>
      </fieldset>{state.data?.canManage && <button className="button button-primary" disabled={state.busy}>Save {company.code} profile</button>}</form>)}
    </section>
  </div>;
}
