"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest, getPreparedApiRead } from "@/lib/crm-data";

export type LeadOption = { id: string; name: string };
export type Configuration = { configured: boolean; missing: string[]; required: string[] };

export async function operationRequest<T>(url: string, method = "GET", body?: unknown, usePrefetched = false): Promise<T> {
  return apiRequest<T>(url, { method, body, usePrefetched });
}

export function useOperationalData<T>(url: string) {
  const [data, setData] = useState<T | null>(() => getPreparedApiRead<T>(url) ?? null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(() => getPreparedApiRead<T>(url) === undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loadedUrl, setLoadedUrl] = useState(url);
  const requestId = useRef(0);
  const refresh = useCallback(async (usePrefetched = false) => {
    const current = ++requestId.current;
    setError("");
    try {
      const next = await operationRequest<T>(url, "GET", undefined, usePrefetched);
      if (current === requestId.current) setData(next);
    }
    catch (failure) {
      if (current === requestId.current) setError(failure instanceof Error ? failure.message : "Unable to load data.");
    }
    finally {
      if (current === requestId.current) { setLoadedUrl(url); setLoading(false); }
    }
  }, [url]);
  useEffect(() => {
    const sequence = requestId;
    const prepared = getPreparedApiRead<T>(url);
    setData(prepared ?? null); setLoading(prepared === undefined); void refresh(true);
    return () => { sequence.current++; };
  }, [refresh, url]);
  async function mutate(endpoint: string, method: string, body?: unknown) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await operationRequest<{ message?: string; warning?: string; emailed?: number; emailError?: string }>(endpoint, method, body);
      setMessage(result.warning ? "" : result.emailed !== undefined ? "Meeting saved; " + result.emailed + " invitation" + (result.emailed === 1 ? "" : "s") + " emailed." + (result.emailError ? " Email warning: " + result.emailError : "") : result.message ?? "Saved.");
      await refresh();
      if (result.warning) setError(result.warning);
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Request failed."); return false; }
    finally { setBusy(false); }
  }
  return { data: loadedUrl === url ? data : null, error, loading: loading || loadedUrl !== url, busy, message, refresh, mutate };
}

export function OperationFeedback({ error, message, loading }: { error: string; message: string; loading: boolean }) {
  return <>{loading && <p className="loading-state" role="status">Loading live records…</p>}{error && <div className="helper-banner" role="alert">{error}</div>}{message && <div className="helper-banner form-success" role="status">{message}</div>}</>;
}

export function LeadSelect({ leads, required = false, name = "lead_id" }: { leads: LeadOption[]; required?: boolean; name?: string }) {
  return <label>Lead<select name={name} required={required} className="form-input"><option value="">Select an accessible lead</option>{leads.map((lead) => <option key={lead.id} value={lead.id}>{lead.name}</option>)}</select></label>;
}

export function formValues(form: HTMLFormElement) {
  return Object.fromEntries(new FormData(form).entries());
}
