import { leadIsUntouched } from "@/lib/lead-filters";
import { LEAD_STAGES, type Lead } from "@/lib/types";

const STORAGE_KEY = "dmhca.demo.lead-details";
const CREATED_STORAGE_KEY = "dmhca.demo.created-leads";
export const LEAD_DETAILS_CHANGED_EVENT = "dmhca:lead-details-changed";
export type LeadDetails = Pick<Lead, "name" | "phone" | "email" | "country" | "course" | "qualification" | "source" | "followUp" | "followUpAt" | "lastVisitAt">;
type LeadChanges = Partial<LeadDetails & Pick<Lead, "stage" | "assignee">>;
type LeadDetailsOverride = LeadChanges & Pick<Lead, "modifiedAt" | "modifiedBy" | "hasBeenEdited" | "editedAt">;
const TEXT_FIELDS = ["name", "phone", "email", "country", "course", "qualification", "source", "followUp", "followUpAt", "lastVisitAt", "modifiedAt", "modifiedBy", "assignee"];

function readOverrides(): Record<string, LeadDetailsOverride> {
  const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Saved lead details could not be read.");
  const result: Record<string, LeadDetailsOverride> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Saved lead details are invalid.");
    const fields = Object.entries(value);
    if (!fields.every(([key, value]) => key === "hasBeenEdited" ? typeof value === "boolean" : key === "editedAt" ? Array.isArray(value) && value.every((item) => typeof item === "string" && Number.isFinite(new Date(item).getTime())) : key === "stage" ? LEAD_STAGES.some((stage) => stage === value) : TEXT_FIELDS.includes(key) && typeof value === "string")) throw new Error("Saved lead details contain an invalid field.");
    result[id] = value;
  }
  return result;
}

export function applyDemoLeadDetails(leads: Lead[]): Lead[] {
  if (typeof window === "undefined") return leads;
  const overrides = readOverrides();
  const created = readCreatedLeads();
  const combined = [...leads, ...created.filter((lead) => !leads.some(({ id }) => id === lead.id))];
  return combined.map((lead) => {
    const override = overrides[lead.id];
    if (!override) return lead;
    // Only keep a full edit history when every earlier edit of the base record is known.
    const baseHistory = lead.editedAt ?? (leadIsUntouched(lead) ? [] : undefined);
    const editedAt = override.editedAt && baseHistory ? [...baseHistory, ...override.editedAt] : undefined;
    return { ...lead, ...override, editedAt };
  });
}

export function saveDemoLeadChanges(changes: { id: string; details: LeadChanges }[]) {
  const overrides = readOverrides();
  const modifiedAt = new Date().toISOString();
  for (const { id, details } of changes) {
    const previous = overrides[id];
    // Older saves recorded only the latest edit, so their history stays unknown.
    const editedAt = previous?.hasBeenEdited && !previous.editedAt ? undefined : [...(previous?.editedAt ?? []), modifiedAt];
    overrides[id] = { ...previous, ...details, modifiedAt, modifiedBy: "Jordan Davis", hasBeenEdited: true, ...(editedAt ? { editedAt } : {}) };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  window.dispatchEvent(new Event(LEAD_DETAILS_CHANGED_EVENT));
}

export function saveDemoLeadDetails(id: string, details: LeadChanges = {}) {
  saveDemoLeadChanges([{ id, details }]);
}

function isCreatedLead(value: unknown): value is Lead {
  if (typeof value !== "object" || value === null) return false;
  return ["id", "name", "phone", "email", "country", "course", "qualification", "source", "assignee", "followUp", "createdAt", "modifiedAt"].every((key) => key in value && typeof Reflect.get(value, key) === "string")
    && "stage" in value && LEAD_STAGES.some((stage) => stage === value.stage)
    && "closureFee" in value && typeof value.closureFee === "number";
}

function readCreatedLeads(): Lead[] {
  const parsed: unknown = JSON.parse(localStorage.getItem(CREATED_STORAGE_KEY) ?? "[]");
  if (!Array.isArray(parsed) || !parsed.every(isCreatedLead)) throw new Error("Created lead records could not be read.");
  return parsed;
}

export function saveDemoCreatedLead(lead: Lead) {
  const leads = readCreatedLeads();
  localStorage.setItem(CREATED_STORAGE_KEY, JSON.stringify([lead, ...leads]));
  window.dispatchEvent(new Event(LEAD_DETAILS_CHANGED_EVENT));
}
