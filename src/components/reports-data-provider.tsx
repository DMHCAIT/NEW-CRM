"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { apiRequest } from "@/lib/crm-data";
import type { CurrentUser } from "@/lib/types";
import type { SavedLeadFilter } from "@/lib/lead-filters";
import type { SavedReport } from "@/lib/reports";

type Data = {
  user: CurrentUser; reports: SavedReport[];
  filters: { id: string; name: string; filter_json: SavedLeadFilter }[];
};
type ReportsData = Data & { saveReport: (report: SavedReport) => Promise<void>; deleteReport: (id: string) => Promise<void> };
const Context = createContext<ReportsData | null>(null);

export function ReportsDataProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => { setData(await apiRequest<Data>("/api/reports")); }, []);
  useEffect(() => { void reload().catch((e: Error) => setError(e.message)); }, [reload]);
  if (error) return <div className="panel"><h1>Reports unavailable</h1><p role="alert">{error}</p><button className="button button-secondary" onClick={() => { setError(""); void reload().catch((e: Error) => setError(e.message)); }}>Retry</button></div>;
  if (!data) return <p role="status">Loading reports…</p>;
  return <Context.Provider value={{ ...data,
    saveReport: async (report) => { await apiRequest("/api/reports", { body: report }); await reload(); },
    deleteReport: async (id) => { await apiRequest("/api/reports", { method: "DELETE", body: { id } }); await reload(); },
  }}>{children}</Context.Provider>;
}

export function useReportsData() {
  const value = useContext(Context);
  if (!value) throw new Error("ReportsDataProvider is required.");
  return value;
}
