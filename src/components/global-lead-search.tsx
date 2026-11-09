"use client";

import Link from "next/link";
import { Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { apiRequest, errorMessage } from "@/lib/crm-data";
import { emptyFilter, leadQueryPath, useDebouncedValue } from "@/lib/live-leads-client";
import type { LeadPage } from "@/lib/server/lead-query";

export function GlobalLeadSearch() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ query: string; page: LeadPage } | null>(null);
  const [error, setError] = useState("");
  const search = useDebouncedValue(query.trim());
  const pathname = usePathname();
  const container = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const resultsId = useId();
  useEffect(() => { setOpen(false); }, [pathname]);
  useEffect(() => {
    if (!search || !open) return;
    let active = true;
    setError("");
    const params = new URLSearchParams(leadQueryPath({ ...emptyFilter(), query: search }).split("?")[1]);
    params.set("metadata", "0");
    void apiRequest<LeadPage>(`/api/leads?${params}`, { maxAgeMs: 30000 }).then(page => {
      if (active) setResult({ query: search, page });
    }).catch(failure => {
      if (active) setError(errorMessage(failure, "Could not search leads. Try again."));
    });
    return () => { active = false; };
  }, [search, open]);
  const current = result?.query === query.trim() ? result.page : null;
  const pending = query.trim() !== search || (!current && !error);
  return <div className="global-lead-search" ref={container} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (event.key === "Escape") { setOpen(false); input.current?.focus(); }
    if (event.key === "ArrowDown" && event.target === input.current) {
      event.preventDefault();
      container.current?.querySelector<HTMLAnchorElement>(".global-search-results a")?.focus();
    }
  }}>
    <label className="global-search-input">
      <Search size={16} aria-hidden="true" />
      <input ref={input} type="search" aria-label="Search leads across CRM" placeholder="Search leads..." autoComplete="off" maxLength={500}
        value={query} aria-controls={open && query.trim() ? resultsId : undefined}
        onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setError(""); setOpen(true); }} />
    </label>
    {open && query.trim() && <section id={resultsId} className="global-search-results" aria-label="Lead search results" aria-busy={pending}>
      {pending ? <p role="status">Searching leads...</p> : error ? <p role="alert">{error}</p> : <>
        <ul>{current?.leads.slice(0, 6).map(lead => <li key={lead.id}><Link href={`/leads/${lead.id}`} prefetch={false} onClick={() => setOpen(false)}>
          <strong>{lead.name}</strong><small>{lead.email || lead.phone}{lead.stage ? ` - ${lead.stage}` : ""}</small>
        </Link></li>)}</ul>
        {!current?.leads.length && <p role="status">No matching leads.</p>}
        <Link className="global-search-all" href={`/leads?q=${encodeURIComponent(query.trim())}`} onClick={() => setOpen(false)}>View all matching leads</Link>
      </>}
    </section>}
  </div>;
}
