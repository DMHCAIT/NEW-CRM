import type { CurrentUser, Lead, Profile } from "@/lib/types";
import { criterionError, filterLeads, isSavedLeadFilter, type FilterCriterion, type SavedLeadFilter } from "@/lib/lead-filters";

export const CONVERSION_STAGES = ["Closed Won", "Already Enrolled"];

export function isDashboardConversion(lead: Lead) {
  return CONVERSION_STAGES.some(stage => stage.toLowerCase() === lead.stage.trim().toLowerCase());
}

export function dashboardCombinationGroups(leads: Lead[]) {
  const groups = new Map<string, { country: string; course: string; total: number; converted: number; rate: number }>();
  for (const lead of leads) {
    const country = lead.country.trim();
    const course = lead.course.trim();
    const key = JSON.stringify([country.toLocaleLowerCase(), course.toLocaleLowerCase()]);
    const group = groups.get(key) ?? { country, course, total: 0, converted: 0, rate: 0 };
    group.total++;
    if (isDashboardConversion(lead)) group.converted++;
    group.rate = group.converted / group.total * 100;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.rate - a.rate || b.converted - a.converted || b.total - a.total || a.country.localeCompare(b.country) || a.course.localeCompare(b.course));
}

export function dashboardScope(user: CurrentUser, leads: Lead[], profiles: Profile[]) {
  if (user.profile.role === "admin" || user.profile.role === "super_admin") return leads;
  const owners = new Set([user.id]);
  if (user.profile.role !== "counselor") {
    let changed = true;
    while (changed) {
      changed = false;
      for (const profile of profiles) {
        if (profile.status === "active" && !profile.deletedAt && profile.reportingTo && owners.has(profile.reportingTo) && !owners.has(profile.id)) {
          owners.add(profile.id);
          changed = true;
        }
      }
    }
  }
  return leads.filter((lead) => lead.assigneeId && owners.has(lead.assigneeId));
}

export function dashboardCriterion(field: FilterCriterion["field"], operator: FilterCriterion["operator"], value: string): FilterCriterion {
  return { id: `${field}-${operator}`, field, operator, value };
}

export function dashboardLink(criteria: FilterCriterion[] = [], name = "Dashboard leads") {
  const filter: SavedLeadFilter = { id: "", name, criteria, matchMode: "all", query: "", quickView: "All accessible leads" };
  return `/leads?dashboard=${encodeURIComponent(JSON.stringify(filter))}`;
}

export function readDashboardFilter(value: string): SavedLeadFilter {
  const filter: unknown = JSON.parse(value);
  if (!isSavedLeadFilter(filter) || filter.criteria.some(criterionError)) throw new Error("The dashboard lead filter is invalid. Return to Dashboard and open the metric again.");
  return filter;
}

export function filterDashboardLeads(leads: Lead[], filter: SavedLeadFilter, userId: string) {
  const utcDay = (value: string | undefined) => {
    if (!value) return value;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : value;
  };
  const matches = new Set(filterLeads(leads.map((lead) => ({
    ...lead, createdAt: utcDay(lead.createdAt), followUpAt: utcDay(lead.followUpAt),
  })), filter, new Date(), { currentUserId: userId }).map(lead => lead.id));
  return leads.filter(lead => matches.has(lead.id));
}

export function dashboardGroups(leads: Lead[], field: "course" | "country") {
  const groups = new Map<string, { name: string; total: number; converted: number; rate: number; stages: Map<string, number> }>();
  for (const lead of leads) {
    const name = lead[field].trim();
    const key = name.toLocaleLowerCase();
    const group = groups.get(key) ?? { name, total: 0, converted: 0, rate: 0, stages: new Map<string, number>() };
    group.total++;
    if (isDashboardConversion(lead)) group.converted++;
    group.rate = group.converted / group.total * 100;
    const stage = lead.stage.trim();
    group.stages.set(stage, (group.stages.get(stage) ?? 0) + 1);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
