import type { Lead, LeadStage } from "@/lib/types";

function dateOffset(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function followUpLabel(days: number | null, time = "") {
  if (days === null) return "—";
  const date = new Date(`${dateOffset(days)}T12:00:00`);
  const dayLabel = days === 0 ? "Today" : days === 1 ? "Tomorrow" : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  return `${dayLabel}, ${time}`;
}

export const leads: Lead[] = [
  { id: "LD-24081", name: "Aarav Mehta", phone: "+91 98765 43210", email: "aarav.mehta@example.com", country: "United Kingdom", course: "MBA", qualification: "Bachelor's degree", stage: "Warm", source: "Website form", assignee: "Priya Sharma", followUp: followUpLabel(0, "2:30 PM"), followUpAt: dateOffset(0), createdAt: dateOffset(-3), modifiedAt: dateOffset(0), modifiedBy: "Priya Sharma", lastVisitAt: dateOffset(0), closureFee: 0 },
  { id: "LD-24080", name: "Sana Khan", phone: "+91 98220 11440", email: "sana.khan@example.com", country: "Canada", course: "MSc Data Science", qualification: "Bachelor's degree", stage: "Prospect", source: "WhatsApp", assignee: "Rohan Patel", followUp: followUpLabel(0, "4:00 PM"), followUpAt: dateOffset(0), createdAt: dateOffset(-4), modifiedAt: dateOffset(0), modifiedBy: "Rohan Patel", lastVisitAt: dateOffset(-1), closureFee: 0 },
  { id: "LD-24079", name: "Ishaan Verma", phone: "+91 98111 03030", email: "ishaan.verma@example.com", country: "Australia", course: "Bachelor of IT", qualification: "High school", stage: "Follow-Up", source: "Google Ads", assignee: "Priya Sharma", followUp: followUpLabel(1, "10:00 AM"), followUpAt: dateOffset(1), createdAt: dateOffset(-5), modifiedAt: dateOffset(-1), modifiedBy: "Priya Sharma", lastVisitAt: dateOffset(-2), closureFee: 0 },
  { id: "LD-24078", name: "Maya Iyer", phone: "+91 98989 20110", email: "maya.iyer@example.com", country: "United States", course: "MS Computer Science", qualification: "Bachelor's degree", stage: "Fresh", source: "Chatbot", assignee: "Arjun Rao", followUp: followUpLabel(1, "11:00 AM"), followUpAt: dateOffset(1), createdAt: dateOffset(-6), modifiedAt: dateOffset(-2), modifiedBy: "Arjun Rao", lastVisitAt: dateOffset(-4), closureFee: 0 },
  { id: "LD-24077", name: "Kabir Desai", phone: "+91 98444 88220", email: "kabir.desai@example.com", country: "United Kingdom", course: "MBA", qualification: "Bachelor's degree", stage: "Closed Won", source: "Referral", assignee: "Rohan Patel", followUp: followUpLabel(null), createdAt: dateOffset(-12), modifiedAt: dateOffset(-1), modifiedBy: "Rohan Patel", lastVisitAt: dateOffset(-1), closureFee: 185000 },
  { id: "LD-24076", name: "Ananya Bose", phone: "+91 98001 55660", email: "ananya.bose@example.com", country: "Ireland", course: "MSc Finance", qualification: "Bachelor's degree", stage: "Interested – No Course", source: "Website form", assignee: "Arjun Rao", followUp: followUpLabel(1, "3:00 PM"), followUpAt: dateOffset(1), createdAt: dateOffset(-14), modifiedAt: dateOffset(0), modifiedBy: "Arjun Rao", lastVisitAt: dateOffset(-3), closureFee: 0 },
];

export const stages: { name: LeadStage; color: string }[] = [
  { name: "Fresh", color: "blue" },
  { name: "Fresh Not Answered", color: "blue" },
  { name: "Follow-Up", color: "blue" },
  { name: "Follow-Up Not Answered", color: "blue" },
  { name: "Not Answering", color: "blue" },
  { name: "Warm", color: "violet" },
  { name: "Hot", color: "red" },
  { name: "Prospect", color: "violet" },
  { name: "Closed Won", color: "green" },
  { name: "Closed Lost", color: "red" },
  { name: "Future Prospect", color: "amber" },
  { name: "DND", color: "red" },
  { name: "General Enquiry", color: "blue" },
  { name: "Reactivated", color: "violet" },
  { name: "Junk", color: "red" },
  { name: "Not Interested", color: "red" },
  { name: "Already Enrolled", color: "green" },
  { name: "Cold", color: "blue" },
  { name: "Cold Not Answered", color: "blue" },
  { name: "Interested – No Course", color: "violet" },
  { name: "Interested – No Centre", color: "violet" },
  { name: "Not Eligible", color: "amber" },
  { name: "Test Lead", color: "blue" },
];

export const activityFeed = [
  { title: "Lead assigned to Priya Sharma", detail: "Aarav Mehta · Website form", time: "12 min ago", type: "assignment" },
  { title: "Follow-up completed", detail: "Sana Khan · Call connected · 8 min", time: "34 min ago", type: "call" },
  { title: "Lead stage updated", detail: "Kabir Desai · Updated by Rohan Patel", time: "1 hr ago", type: "stage" },
  { title: "New enquiry received", detail: "Maya Iyer · Chatbot", time: "2 hrs ago", type: "new" },
];

export const permissionGroups: {
  group: string;
  permissions: { key: string; label: string; description: string }[];
}[] = [
  {
    group: "Lead management",
    permissions: [
      { key: "leads.view", label: "View leads", description: "Open lead lists and details within assigned data scope." },
      { key: "leads.create", label: "Create leads", description: "Create leads manually and from permitted channels." },
      { key: "leads.edit", label: "Edit lead details", description: "Update lead information, notes and follow-ups." },
      { key: "leads.assign", label: "Reassign leads", description: "Change the lead owner within the permitted hierarchy." },
      { key: "leads.delete", label: "Delete leads", description: "Delete permitted lead records; counselors and team leads cannot delete leads." },
      { key: "leads.merge", label: "Merge duplicate leads", description: "Merge records within the user's role-based scope." },
    ],
  },
  {
    group: "Operations",
    permissions: [
      { key: "pipeline.view", label: "View pipeline", description: "View permitted leads on the pipeline board." },
      { key: "meetings.manage", label: "Manage meetings", description: "Schedule and update meetings for permitted leads." },
      { key: "invoices.create", label: "Create invoices", description: "Prepare invoices and submit discount requests." },
      { key: "invoices.approve", label: "Approve discounts", description: "Approve, edit or reject invoice discounts." },
    ],
  },
  {
    group: "Administration",
    permissions: [
      { key: "reports.export", label: "Export reports", description: "Download role-scoped reports and lead data." },
      { key: "automations.manage", label: "Manage automations", description: "Create, edit and activate automation rules." },
      { key: "integrations.manage", label: "Manage integrations", description: "Configure service connections and webhook sources." },
      { key: "access.manage", label: "Manage access", description: "Configure role permissions and per-user exceptions." },
      { key: "users.manage", label: "Manage users", description: "Create, deactivate and administer user accounts." },
    ],
  },
];
