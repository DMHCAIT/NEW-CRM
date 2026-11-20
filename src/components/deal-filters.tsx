"use client";

import { useState } from "react";
import { CalendarDays, SlidersHorizontal } from "lucide-react";
import { dealFilterSchema, type DealFilters } from "@/lib/deal-filters";

const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function DealFiltersForm({ filters, timezone, today, onApply, pending = false }: {
  filters: DealFilters; timezone: string; today: string; onApply: (filters: DealFilters) => void; pending?: boolean;
}) {
  const [period, setPeriod] = useState(filters.period);
  const [error, setError] = useState("");
  const active = filters.stage !== "all" || filters.period !== "all";
  function applyFilters(next: DealFilters) {
    setError("");
    onApply(next);
  }
  return <div className="deals-filter-workspace">
    <div className="deals-filter-heading">
      <div className="deals-filter-title"><span className="deals-filter-icon"><SlidersHorizontal size={17} aria-hidden="true" /></span><div><h3>Filter deals</h3><p>Find conversions by stage, month or year.</p></div></div>
      <span className="deals-timezone"><CalendarDays size={13} aria-hidden="true" />{timezone}</span>
    </div>
    <form className="deals-filter-form" action="/deals" method="get" aria-label="Filter deals" aria-busy={pending} onSubmit={event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      const parsed = dealFilterSchema.safeParse({
        stage: values.get("stage"), period: values.get("period"),
        month: values.get("month") ?? "", year: values.get("year") ?? "",
        from: values.get("from") ?? "", to: values.get("to") ?? "",
      });
      if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(" ")); return; }
      applyFilters(parsed.data);
    }}>
      <label><span>Stage</span><select name="stage" defaultValue={filters.stage}>
        <option value="all">All deals</option><option value="closed_won">Closed Won</option><option value="already_enrolled">Already Enrolled</option>
      </select></label>
      <label><span>Converted date</span><select name="period" value={period} onChange={event => {
        const value = event.target.value;
        if (value === "all" || value === "today" || value === "month" || value === "year" || value === "custom") setPeriod(value);
      }}>
        <option value="all">All time</option><option value="today">Today</option><option value="month">By month</option><option value="year">By year</option><option value="custom">Custom date range</option>
      </select></label>
      {period === "month" && <label><span>Month</span><select name="month" defaultValue={filters.month || today.slice(5, 7)}>
        {months.map((month, index) => <option key={month} value={String(index + 1).padStart(2, "0")}>{month}</option>)}
      </select></label>}
      {(period === "month" || period === "year") && <label><span>Year</span><input name="year" type="number" min="1" max="9999" step="1" required placeholder="YYYY" defaultValue={filters.year || today.slice(0, 4)} /></label>}
      {period === "custom" && <>
        <label><span>From</span><input name="from" type="date" required defaultValue={filters.from} /></label>
        <label><span>To</span><input name="to" type="date" required defaultValue={filters.to} /></label>
      </>}
      <div className="deals-filter-actions"><button className="button button-primary" type="submit" disabled={pending}>{pending ? "Applying..." : "Apply filters"}</button>
        {active && <button className="button button-secondary" type="button" disabled={pending}
          onClick={() => applyFilters({ ...filters, stage: "all", period: "all" })}>Clear filters</button>}
      </div>
    </form>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="deals-filter-footer"><p className="deals-filter-help">Your selection updates both the list and the totals above.</p>
      <details className="deals-filter-note"><summary>About conversion dates</summary><p>Dates use {timezone} and the latest recorded entry into the current stage. Leads without a recorded conversion date appear only in All time.</p></details>
    </div>
    {active && <p className="deals-filter-status" role="status">Showing filtered deals. Summary totals match these filters.</p>}
  </div>;
}
