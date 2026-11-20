"use client";

import Link from "next/link";
import { Handshake, Mail, Phone } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DealFiltersForm } from "@/components/deal-filters";
import { initials, StageBadge } from "@/components/lead-helpers";
import { apiRequest, errorMessage } from "@/lib/crm-data";
import { dealPageHref, parseDealQuery, type DealFilters } from "@/lib/deal-filters";
import { dealPageSize, filterDealSnapshot, type DealWorkspaceData } from "@/lib/deals";

export function DealsWorkspace({ initialData }: { initialData: DealWorkspaceData }) {
  const [data, setData] = useState(initialData);
  const [view, setView] = useState({ filters: initialData.filters, page: initialData.page });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const currentData = useRef(data);
  const currentView = useRef(view);
  const requestedView = useRef(view);
  const sequence = useRef(0);
  const refreshing = useRef(false);
  currentData.current = data;
  currentView.current = view;

  const update = useCallback(async (filters: DealFilters, page = 1, mode: "push" | "pop" | "refresh" = "push") => {
    const previous = currentData.current;
    const href = dealPageHref(filters, page);
    const fresh = Date.now() - previous.loadedAt < 30000;
    if (mode === "push" && href === dealPageHref(currentView.current.filters, currentView.current.page) && fresh) return;
    const request = ++sequence.current;
    const nextView = { filters, page };
    const changeHistory = mode === "push" || mode === "refresh"
      && href !== dealPageHref(currentView.current.filters, currentView.current.page);
    requestedView.current = nextView;
    const show = () => {
      currentView.current = nextView;
      setView(nextView);
      if (changeHistory && `${window.location.pathname}${window.location.search}` !== href) window.history.pushState(null, "", href);
    };
    setError("");
    if (previous.snapshot) show();
    if (previous.snapshot && fresh && mode !== "refresh") {
      refreshing.current = false;
      setLoading(false);
      return;
    }
    refreshing.current = true;
    setLoading(true);
    try {
      const next = await apiRequest<DealWorkspaceData>(href.replace("/deals", "/api/deals"), {
        maxAgeMs: 30000, forceFresh: mode === "refresh",
      });
      if (request !== sequence.current) return;
      currentData.current = next;
      setData(next);
      show();
    } catch (failure) {
      if (request === sequence.current) setError(errorMessage(failure, "Deals could not be refreshed. Please retry."));
    } finally {
      if (request === sequence.current) { refreshing.current = false; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    sequence.current++;
    refreshing.current = false;
    currentData.current = initialData;
    const selection = { filters: initialData.filters, page: initialData.page };
    currentView.current = selection;
    requestedView.current = selection;
    setData(initialData); setView(selection); setLoading(false); setError("");
  }, [initialData]);
  useEffect(() => {
    const back = () => {
      if (window.location.pathname !== "/deals") return;
      const parsed = parseDealQuery(new URLSearchParams(window.location.search));
      if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join(" ")); return; }
      void update(parsed.data.filters, parsed.data.page, "pop");
    };
    const refresh = () => {
      if (!refreshing.current && document.visibilityState === "visible" && Date.now() - currentData.current.loadedAt >= 30000) {
        const selected = currentView.current;
        void update(selected.filters, selected.page, "refresh");
      }
    };
    const revision = sequence;
    window.addEventListener("popstate", back);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      revision.current++;
      window.removeEventListener("popstate", back);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [update]);

  const { filters, page } = view;
  const result = useMemo(() => data.snapshot
    ? filterDealSnapshot(data.snapshot, data.stages, filters, page, data.today, data.timezone)
    : data.result, [data, filters, page]);
  const names = new Map(data.stages.map(stage => [stage.id, stage.name]));
  const countStage = (name: string) => result.counts.reduce((sum, count) =>
    sum + (names.get(count.stage_id)?.toLowerCase() === name ? count.total : 0), 0);
  const closedWon = countStage("closed won"), enrolled = countStage("already enrolled");
  const visible = result.leads.slice(0, dealPageSize);
  const pending = loading && !data.snapshot;
  return <>
    <div className="page-heading deals-heading"><div className="deals-title"><span className="deals-symbol"><Handshake size={24} aria-hidden="true" /></span><div><h1>Deals</h1><p>Your converted leads, ready for the next step.</p></div></div></div>
    <section className="panel deals-panel" aria-labelledby="deals-title" aria-busy={pending}><div className="panel-heading"><div><h2 id="deals-title">Converted leads</h2><p>Successful admissions at a glance. Click a lead name to view its record.</p></div>
      <dl className="deals-summary" aria-label="Deal totals">
        <div><dt>Total deals</dt><dd>{(closedWon + enrolled).toLocaleString("en-IN")}</dd></div>
        <div><dt>Closed Won</dt><dd>{closedWon.toLocaleString("en-IN")}</dd></div>
        <div><dt>Already Enrolled</dt><dd>{enrolled.toLocaleString("en-IN")}</dd></div>
      </dl></div>
      <DealFiltersForm key={dealPageHref(filters)} filters={filters} timezone={data.timezone} today={data.today} pending={pending}
        onApply={next => { void update(next); }} />
      {loading && <p className="loading-state" role="status">{data.snapshot ? "Checking the latest deals. Filters remain available." : "Updating deals. Existing results remain visible until loading finishes."}</p>}
      {error && <div className="helper-banner" role="alert">{error} <button type="button" className="text-link"
        onClick={() => {
          const requested = requestedView.current;
          void update(requested.filters, requested.page, "refresh");
        }}>Retry update</button></div>}
      <div className="table-wrap"><table className="data-table deals-table"><caption className="sr-only">Converted leads and their contact, course and stage details</caption><thead><tr><th scope="col">Lead</th><th scope="col">Contact details</th><th scope="col">Course</th><th scope="col">Stage</th></tr></thead>
        <tbody>{visible.map(lead => <tr key={lead.id}>
          <td><Link className="deal-name-link" href={`/leads/${lead.id}`} prefetch={false}><span className="avatar deal-avatar" aria-hidden="true">{initials(lead.name)}</span><span>{lead.name}</span></Link></td>
          <td><div className="deal-contact"><span><Mail size={13} aria-hidden="true" />{lead.email || "No email provided"}</span><span><Phone size={13} aria-hidden="true" />{lead.phone || "No phone provided"}</span></div></td>
          <td className="deal-course">{lead.course || "No course selected"}</td><td><StageBadge stage={names.get(lead.stage_id) ?? "Unknown stage"} /></td>
        </tr>)}</tbody></table></div>
      {!result.leads.length && <div className="empty-state deals-empty"><Handshake size={32} aria-hidden="true" /><h3>No deals on this page</h3><p>{filters.stage !== "all" || filters.period !== "all" ? "No converted leads match these filters on this page. Try another date range or clear the filters." : "Converted leads appear here when their stage is Closed Won or Already Enrolled."}</p></div>}
      <div className="table-footer workspace-pagination"><span>Page {page} &middot; {visible.length} {visible.length === 1 ? "deal" : "deals"} shown</span><div>
        {page > 1 && <button className="button button-secondary" type="button" disabled={pending} onClick={() => { void update(filters, page - 1); }}>Previous</button>}
        {result.leads.length > dealPageSize && <button className="button button-secondary" type="button" disabled={pending} onClick={() => { void update(filters, page + 1); }}>Next</button>}
      </div></div>
    </section>
  </>;
}
