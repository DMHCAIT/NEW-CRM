import { LEAD_STAGES, type Lead, type LeadStage } from "@/lib/types";
import { applyDemoLeadDetails, saveDemoLeadDetails } from "@/lib/demo-lead-details-store";

const LEAD_STAGES_STORAGE_KEY = "northstar.demo.lead-stages";
const LEAD_STAGES_CHANGED_EVENT = "northstar:demo-lead-stages-changed";

function isLeadStage(value: unknown): value is LeadStage {
  return typeof value === "string" && LEAD_STAGES.some((stage) => stage === value);
}

export function readDemoLeadStageOverrides(): Record<string, LeadStage> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(LEAD_STAGES_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const overrides: Record<string, LeadStage> = {};
    for (const [leadId, stage] of Object.entries(parsed)) {
      if (isLeadStage(stage)) overrides[leadId] = stage;
    }
    return overrides;
  } catch {
    return {};
  }
}

export function applyDemoLeadStageOverrides(leads: Lead[]): Lead[] {
  const overrides = readDemoLeadStageOverrides();
  return applyDemoLeadDetails(leads.map((lead) => overrides[lead.id] ? { ...lead, stage: overrides[lead.id] } : lead));
}

export function saveDemoLeadStageOverride(leadId: string, stage: LeadStage) {
  saveDemoLeadDetails(leadId, { stage });
  window.dispatchEvent(new CustomEvent(LEAD_STAGES_CHANGED_EVENT));
}

export { LEAD_STAGES_CHANGED_EVENT };
