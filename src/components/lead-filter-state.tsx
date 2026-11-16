"use client";

import { createContext, useContext, useRef, type ReactNode } from "react";
import type { SavedLeadFilter } from "@/lib/lead-filters";

const LeadFilterStateContext = createContext<Map<string, SavedLeadFilter> | null>(null);
type LeadNavigation = { filter: SavedLeadFilter; dashboard: boolean };
const LeadNavigationContext = createContext<{ current: LeadNavigation | null } | null>(null);

export function LeadFilterStateProvider({ children }: { children: ReactNode }) {
  const filters = useRef(new Map<string, SavedLeadFilter>());
  const navigation = useRef<LeadNavigation | null>(null);
  return <LeadFilterStateContext.Provider value={filters.current}><LeadNavigationContext.Provider value={navigation}>{children}</LeadNavigationContext.Provider></LeadFilterStateContext.Provider>;
}

export function useLeadFilterState() {
  return useContext(LeadFilterStateContext);
}

export function useLeadNavigation() {
  return useContext(LeadNavigationContext);
}
