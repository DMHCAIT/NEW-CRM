export type CrmRole =
  | "counselor"
  | "team_lead"
  | "manager"
  | "admin"
  | "super_admin";

export type Permission =
  | "dashboard.view"
  | "leads.view"
  | "leads.create"
  | "leads.edit"
  | "leads.assign"
  | "leads.delete"
  | "leads.merge"
  | "leads.import"
  | "pipeline.view"
  | "automations.view"
  | "automations.manage"
  | "integrations.view"
  | "integrations.manage"
  | "meetings.view"
  | "meetings.manage"
  | "invoices.view"
  | "invoices.create"
  | "invoices.approve"
  | "reports.view"
  | "reports.export"
  | "users.view"
  | "users.manage"
  | "access.manage"
  | "settings.manage";

export const LEAD_STAGES = [
  "Fresh",
  "Fresh Not Answered",
  "Follow-Up",
  "Follow-Up Not Answered",
  "Not Answering",
  "Warm",
  "Hot",
  "Prospect",
  "Closed Won",
  "Closed Lost",
  "Future Prospect",
  "DND",
  "General Enquiry",
  "Reactivated",
  "Junk",
  "Not Interested",
  "Already Enrolled",
  "Cold",
  "Cold Not Answered",
  "Interested – No Course",
  "Interested – No Centre",
  "Not Eligible",
  "Test Lead",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export interface Lead {
  id: string;
  name: string;
  phone: string;
  countryCode?: string;
  altPhone?: string;
  email: string;
  country: string;
  course: string;
  qualification: string;
  category?: string;
  /** Stage name; stages are configurable in the lead_stages table. */
  stage: string;
  stageId?: string;
  source: string;
  assignee: string;
  assigneeId?: string;
  followUp: string;
  followUpAt?: string;
  createdAt?: string;
  modifiedAt?: string;
  modifiedBy?: string;
  lastVisitAt?: string;
  hasBeenEdited?: boolean;
  /** ISO timestamps of every recorded edit, oldest first. */
  editedAt?: string[];
  mergedIntoId?: string;
  isArchived?: boolean;
  closureFee: number;
}

export interface Profile {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  role: CrmRole;
  reportingTo: string | null;
  status: "active" | "inactive";
  ivrExtension: string;
  deletedAt: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  profile: Profile;
  permissions: Permission[];
}
