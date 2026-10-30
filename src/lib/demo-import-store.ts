import type { Lead, LeadStage } from "@/lib/types";

export type DemoImportBatch = {
  id: string;
  fileName: string;
  importedAt: string;
  assignee: string;
  stage: LeadStage;
  leads: Lead[];
};

const IMPORT_BATCHES_KEY = "northstar.demo.import-batches";

export function readDemoImportBatches(): DemoImportBatch[] {
  if (typeof window === "undefined") return [];
  try {
    const batches = JSON.parse(localStorage.getItem(IMPORT_BATCHES_KEY) ?? "[]") as DemoImportBatch[];
    return Array.isArray(batches) ? batches.filter((batch) => Array.isArray(batch.leads)) : [];
  } catch {
    return [];
  }
}

export function saveDemoImportBatches(batches: DemoImportBatch[]) {
  if (typeof window !== "undefined") {
    localStorage.setItem(IMPORT_BATCHES_KEY, JSON.stringify(batches));
    window.dispatchEvent(new CustomEvent("northstar:demo-imports-changed"));
  }
}

export function readDemoImportedLeads() {
  return readDemoImportBatches().flatMap((batch) => batch.leads);
}