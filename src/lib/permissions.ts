import type { CrmRole, Permission } from "@/lib/types";

export function isCrmRole(value: string): value is CrmRole {
  return value === "counselor"
    || value === "team_lead"
    || value === "manager"
    || value === "admin"
    || value === "super_admin";
}

export function canDownloadReports(role: CrmRole) {
  return role === "manager" || role === "admin" || role === "super_admin";
}

export function canExportLeadData(role: CrmRole) {
  return role === "admin" || role === "super_admin";
}

export const DEFAULT_ROLE_PERMISSIONS: Record<CrmRole, Permission[]> = {
  counselor: [
    "dashboard.view", "leads.view", "leads.create", "leads.edit", "leads.merge", "pipeline.view",
    "meetings.view", "meetings.manage", "invoices.view", "invoices.create", "reports.view",
  ],
  team_lead: [
    "dashboard.view", "leads.view", "leads.create", "leads.edit", "leads.assign", "leads.merge",
    "pipeline.view", "meetings.view", "meetings.manage", "invoices.view", "invoices.create",
    "reports.view",
  ],
  manager: [
    "dashboard.view", "leads.view", "leads.create", "leads.edit", "leads.assign", "leads.delete", "leads.merge",
    "pipeline.view", "automations.view", "automations.manage", "meetings.view", "meetings.manage",
    "invoices.view", "invoices.create", "reports.view", "reports.export",
  ],
  admin: [
    "dashboard.view", "leads.view", "leads.create", "leads.edit", "leads.assign", "leads.delete", "leads.merge",
    "pipeline.view", "automations.view", "automations.manage", "integrations.view", "integrations.manage",
    "meetings.view", "meetings.manage", "invoices.view", "invoices.create", "invoices.approve",
    "reports.view", "reports.export", "users.view", "access.manage", "settings.manage", "leads.import",
  ],
  super_admin: [
    "dashboard.view", "leads.view", "leads.create", "leads.edit", "leads.assign", "leads.delete", "leads.merge",
    "pipeline.view", "automations.view", "automations.manage", "integrations.view", "integrations.manage",
    "meetings.view", "meetings.manage", "invoices.view", "invoices.create", "invoices.approve",
    "reports.view", "reports.export", "users.view", "users.manage", "access.manage", "settings.manage", "leads.import",
  ],
};
