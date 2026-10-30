export type LeadFieldType = "text" | "dropdown";

export const STANDARD_LEAD_FIELDS: { name: string; type: LeadFieldType; required?: boolean }[] = [
  { name: "Name", type: "text", required: true },
  { name: "Email", type: "text", required: true },
  { name: "Country code", type: "dropdown", required: true },
  { name: "Phone", type: "text", required: true },
  { name: "Country", type: "dropdown", required: true },
  { name: "Qualification", type: "dropdown", required: true },
  { name: "Category", type: "dropdown", required: true },
  { name: "Course", type: "dropdown", required: true },
  { name: "Source", type: "dropdown", required: true },
  { name: "Stage", type: "dropdown", required: true },
  { name: "Assignee", type: "dropdown" },
  { name: "Closure Fee", type: "text" },
  { name: "Alternate phone", type: "text" },
  { name: "Next follow-up", type: "text" },
];
