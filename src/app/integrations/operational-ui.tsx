"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/crm-data";

export type LeadOption = { id: string; name: string };
export type Configuration = { configured: boolean; missing: string[]; required: string[] };

export async function operationRequest<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  return apiRequest<T>(url, { method, body });
}

export function useOperationalData<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const refresh = useCallback(async () => {
    setError("");
    try { setData(await operationRequest<T>(url)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to load data."); }
    finally { setLoading(false); }
  }, [url]);
  useEffect(() => { setLoading(true); void refresh(); }, [refresh]);
  async function mutate(endpoint: string, method: string, body?: unknown) {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await operationRequest<{ message?: string; emailed?: number; emailError?: string }>(endpoint, method, body);
      setMessage(result.emailed !== undefined ? "Meeting saved; " + result.emailed + " invitation" + (result.emailed === 1 ? "" : "s") + " emailed." + (result.emailError ? " Email warning: " + result.emailError : "") : result.message ?? "Saved.");
      await refresh();
      return true;
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Request failed."); return false; }
    finally { setBusy(false); }
  }
  return { data, error, loading, busy, message, refresh, mutate };
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
