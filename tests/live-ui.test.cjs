const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, mkdirSync, writeFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const root = path.join(__dirname, "..");
const id = "10000000-0000-4000-8000-000000000001";
const profile = { id, fullName: "Admissions Administrator", email: "admin@example.com", role: "super_admin", status: "active", reportingTo: null, phone: "", ivrExtension: "" };
const permissions = ["dashboard.view", "leads.view", "leads.create", "leads.edit", "leads.assign", "leads.delete", "leads.merge", "leads.import", "pipeline.view", "reports.view", "reports.export", "users.view", "users.manage", "settings.manage", "access.manage", "meetings.view", "invoices.view", "automations.view", "integrations.view"];
const user = { id, email: profile.email, profile, permissions };
const stages = [{ id: "stage-1", name: "New enquiry", color: "#3d75cb", is_terminal: false }, { id: "stage-2", name: "Application under review", color: "#7357a5", is_terminal: false }, { id: "stage-3", name: "Enrolled", color: "#159447", is_terminal: true }];
const lead = { id: "lead-1", name: "Alex Morgan", phone: "+919876543210", altPhone: "", email: "alex@example.com", country: "India", course: "Clinical research", qualification: "Graduate", source: "Website", stage: stages[0].name, stageId: stages[0].id, assignee: profile.fullName, assigneeId: id, followUp: "21 Oct 2026", followUpAt: "2020-01-01T09:00:00Z", createdAt: "2026-10-21T09:00:00Z", modifiedAt: "2026-10-21T09:00:00Z", modifiedBy: profile.fullName, closureFee: 25000, customFields: {} };
const manyScheduledCalls = Array.from({ length: 30 }, (_, index) => ({ id: `scheduled-${index}`, user_id: id, scheduled_at: new Date(Date.UTC(index < 20 ? 2099 : 2020, 11, index + 1, 10)).toISOString(), status: "scheduled" }));
const configuration = {
  fields: [
    { name: "Preferred campus", active: true, type: "dropdown", options: ["Delhi", "Dubai"] },
    { name: "Counselor note", active: true, type: "text", options: [] },
  ],
  duplicateFields: "phone_email",
  creationPolicy: "block",
  picklists: {
    countryCode: ["India (+91)"],
    country: ["India"],
    qualification: ["MBBS"],
    category: ["Certificate"],
    course: ["Clinical cardiology"],
    source: ["Website"],
  },
};
const filter = { id: "filter-1", name: "All accessible leads", criteria: [], matchMode: "all", query: "", quickView: "All accessible leads" };
const live = { user, leads: [lead], profiles: [profile], stages, configuration, filters: [{ id: filter.id, name: filter.name, filter_json: filter }], columns: null };
const report = { id: "report-1", name: "Admissions overview", filter, columns: ["name", "email", "stage"], savedAt: "2026-10-21T09:00:00Z" };
const session = { session_id: "10000000-0000-4000-8000-000000000099", user_id: id, email: profile.email, signed_in_at: "2026-10-21T09:00:00Z", last_seen_at: "2026-10-21T09:30:00Z", expires_at: "2030-01-01T00:00:00Z", device: "Windows computer" };
const configured = { configured: true, missing: [], required: ["PROVIDER_CLIENT_ID"] };
const unconfigured = { configured: false, missing: ["PROVIDER_CLIENT_ID"], required: ["PROVIDER_CLIENT_ID"] };
const Link = ({ children, ...props }) => React.createElement("a", props, children);
let currentPath = "/users";

function load(relative, overrides = {}) {
  const filename = path.join(root, relative);
  const api = {};
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function("exports", "require", output)(api, (name) => {
    if (name.endsWith(".css")) return {};
    if (name in overrides) return overrides[name];
    if (name === "@/lib/server/dashboard-summary") return { fetchDashboardSummary: async () => {
      const source = overrides["@/lib/crm-data"] ?? crm;
      const actor = await (overrides["@/lib/server/auth"] ?? server).requireUser();
      return dashboardSummary(await source.fetchLeads(), actor.user);
    } };
    if (name === "next/link") return { __esModule: true, default: Link };
    if (name === "next/navigation") return { usePathname: () => currentPath, useParams: () => ({ id: "report-1", mode: "list" }), useRouter: () => ({ push() {}, replace() {}, prefetch() {} }), notFound() { throw new Error("Not found"); } };
    if (name.startsWith("@/")) {
      const base = name.replace("@/", "src\\").replaceAll("/", "\\");
      return load(`${base}${existsSync(path.join(root, `${base}.ts`)) ? ".ts" : ".tsx"}`, overrides);
    }
    if (name.startsWith(".")) {
      const resolved = path.relative(root, path.resolve(path.dirname(filename), `${name}.tsx`));
      return load(resolved, overrides);
    }
    return require(name);
  });
  return api;
}

function hookStates(values) {
  let index = 0;
  return { ...React, useState: (initial) => [index < values.length ? values[index++] : typeof initial === "function" ? initial() : initial, () => {}], useEffect() {} };
}
const crm = {
  formatDateTime: (value) => value ? new Date(value).toLocaleString("en-IN") : "",
  apiRequest: async () => ({}), errorMessage: (error) => error.message,
  getCachedApiRead: () => undefined,
  fetchLeads: async () => [lead], fetchStages: async () => stages,
  fetchProfiles: async () => [profile],
};
const actualLeads = load("src\\lib\\live-leads-client.tsx", { "@/lib/crm-data": crm });
const op = load("src\\app\\integrations\\operational-ui.tsx");
const integrationDefinitions = load("src\\lib\\integration-definitions.ts").integrationDefinitions;
const integrationSettings = integrationDefinitions.map(definition => ({
  provider: definition.id, source: "crm", revision: "10000000-0000-4000-8000-000000000011",
  values: Object.fromEntries(definition.fields.filter(field => !field.secret).map(field => [field.key, ({
    SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "finance@example.com", SMTP_FROM: "Finance <finance@example.com>", SMTP_SECURE: "false",
    GOOGLE_CLIENT_ID: "web-client.apps.googleusercontent.com", GOOGLE_REDIRECT_URI: "https://crm.example/api/auth/gmail/callback",
    FACEBOOK_APP_ID: "123456", FACEBOOK_GRAPH_VERSION: "v25.0",
  })[field.key] ?? "configured-value"])),
  saved: Object.fromEntries(definition.fields.map(field => [field.key, true])),
  testedAt: null, testStatus: null, testMessage: null,
}));
const operational = (data) => ({ data, error: "", message: "", loading: false, busy: false, refresh() {}, mutate() {} });
const shell = load("src\\components\\app-shell.tsx", { "@/lib/crm-data": crm }).AppShell;
const baseline = { "@/lib/crm-data": crm };

async function renderPage(file, { states, overrides = {}, shellUser = user } = {}) {
  const all = { ...baseline, ...overrides, ...(states ? { react: hookStates(states) } : {}) };
  const Component = load(file, all).default;
  const content = Component.constructor.name === "AsyncFunction" ? await Component({ searchParams: Promise.resolve({}) }) : React.createElement(Component);
  return renderToStaticMarkup(React.createElement(shell, { user: shellUser }, content));
}

const operations = {
  "/api/meetings": { meetings: [{ id: "meeting-1", title: "Admissions consultation", lead_id: lead.id, host_id: id, join_url: null, start_at: "2026-10-21T09:00:00Z", duration_min: 30, status: "scheduled", zoom_meeting_id: null }], leads: [lead], userId: id, canManage: true, zoom: unconfigured },
  "/api/invoices": { invoices: [{ id: "invoice-1", invoice_no: "DMHCA-2026-001", lead_id: lead.id, created_by: id, subtotal: 25000, total: 25000, tax_amount: 0, discount_amount: 0, discount_percent: 0, payment_type: "one_shot", course_total: 25000, parent_invoice_id: null, payment_verified_by: null, razorpay_short_url: null, razorpay_payment_link_id: null, email_message_id: null, email_lock_at: null, status: "pending_approval", created_at: "2026-10-21T09:00:00Z", due_date: "2026-11-01", invoice_items: [{ description: "Clinical research admission", quantity: 1, unit_price: 25000, amount: 25000 }], invoice_approvals: [] }], leads: [lead], profiles: [{ id, full_name: profile.fullName }], userId: id, canCreate: true, canApprove: true, razorpay: unconfigured, smtp: configured },
  "/api/automations": { automations: [{ id: "rule-1", name: "Follow-up reminder", trigger_config: { type: "manual" }, actions_json: [{ type: "notify_me", days: 1 }], is_active: true }], logs: [], leads: [lead], canManage: true, canEditLeads: true },
  "/api/integrations": { integrations: integrationDefinitions.map(definition => ({ ...configured, id: definition.id, name: definition.name, detail: definition.detail })), unsupported: [], note: "Saved configuration is not proof of a working connection." },
  "/api/integrations/settings": { canManage: true, settings: integrationSettings, appUrl: "https://crm.example" },
  "/api/integrations/facebook-pages": { pages: [{ page_id: "12345678", page_name: "Admissions India", is_active: true, tokenConfigured: true, tokenMask: "********", created_at: "2026-10-23T09:00:00Z", updated_at: "2026-10-23T09:00:00Z" }] },
  "/api/integrations/sources": { sources: [{ id: "source-1", name: "Website enquiry", is_active: true, allowed_origins: [], intake_source_settings: { channel: "website", owner_id: id, stage_id: "stage-1", facebook_page_id: null, facebook_form_id: null } }], owners: [{ id, full_name: profile.fullName }], stages, canManage: true },
  "/api/integrations/gmail": { connection: null, messages: [], canManage: true, canConnect: true },
};
const opMock = { ...op, useOperationalData: (url) => operational(operations[url]) };
const emptyIntegrationOperations = {
  ...operations,
  "/api/integrations/facebook-pages": { pages: [] },
  "/api/integrations/sources": { ...operations["/api/integrations/sources"], sources: [] },
};
const emptyIntegrationMock = { ...op, useOperationalData: url => operational(emptyIntegrationOperations[url]) };
const liveMock = { ...actualLeads, useDebouncedValue: value => value, useLiveLeadData: () => ({ data: live, loading: false, error: "", reload() {}, setError() {} }) };
function dashboardSummary(records, actor) {
  const { dashboardScope, dashboardGroups, dashboardCombinationGroups, isDashboardConversion } = load("src\\lib\\dashboard.ts");
  const rows = dashboardScope(actor, records, [profile]);
  const today = new Date().toISOString().slice(0, 10);
  const terminal = new Set(stages.filter(stage => stage.is_terminal).map(stage => stage.name));
  const due = rows.filter(row => row.followUpAt && !terminal.has(row.stage));
  const groups = field => dashboardGroups(rows, field).map(group => ({ ...group, stages: Object.fromEntries(group.stages) }));
  const leaders = field => groups(field).filter(group => group.converted > 0).sort((a,b) => b.rate-a.rate || b.converted-a.converted || a.name.localeCompare(b.name)).slice(0,8);
  const daily = {};
  for (const row of rows) if (row.createdAt) daily[row.createdAt.slice(0,10)] = (daily[row.createdAt.slice(0,10)] ?? 0) + 1;
  return {
    total: rows.length, newToday: rows.filter(row => row.createdAt?.startsWith(today)).length,
    converted: rows.filter(isDashboardConversion).length, overdue: due.filter(row => row.followUpAt.slice(0,10) < today).length,
    dueToday: due.filter(row => row.followUpAt.startsWith(today)).length, daily,
    stages: [...new Set(rows.map(row => row.stage))].map(name => ({ stage_name: name, stage_id: rows.find(row => row.stage === name).stageId, total: rows.filter(row => row.stage === name).length })),
    country: groups("country").slice(0,30), course: groups("course").slice(0,30),
    countryLeaders: leaders("country"), courseLeaders: leaders("course"),
    combinations: dashboardCombinationGroups(rows).slice(0,30),
  };
}
const accessData = { profiles: [profile], overrides: [], roles: ["leads.view", "leads.create", "leads.edit", "users.manage", "reports.export", "settings.manage"].map((permission_key) => ({ role: "counselor", permission_key, allowed: false })) };
const query = (data) => {
  const result = { data, error: null, count: data.length };
  const chain = { then: (resolve) => resolve(result) };
  chain.is = (key, value) => {
    result.data = result.data.filter(row => (row[key] ?? null) === value);
    result.count = result.data.length;
    return chain;
  };
  chain.gt = (key, value) => {
    result.data = result.data.filter(row => row[key] > value);
    result.count = result.data.length;
    return chain;
  };
  for (const method of ["select", "order", "limit", "range"]) chain[method] = () => chain;
  return chain;
};
const server = { requireUser: async () => ({ user, supabase: { from: (table) => query(table === "notifications" ? [{ id: "note-1", type: "Follow-up", payload: { message: "Review your pending follow-ups." }, created_at: session.signed_in_at }] : [session]) } }) };
const cases = [
  ["dashboard", "src\\app\\page.tsx", { overrides: { "@/lib/server/auth": server } }],
  ["dashboard-empty", "src\\app\\page.tsx", { overrides: { "@/lib/server/auth": server, "@/lib/crm-data": { ...crm, fetchLeads: async () => [] } } }],
  ["dashboard-conversions", "src\\app\\page.tsx", { overrides: { "@/lib/server/auth": server, "@/lib/crm-data": { ...crm, fetchLeads: async () => [
    { ...lead, stage: "Closed Won", stageId: stages[2].id },
    { ...lead, id: "converted-2", name: "Maya Singh", country: "Canada", course: "Nursing", stage: "Already Enrolled", stageId: stages[2].id },
    { ...lead, id: "open-3", country: "India", course: "Nursing", stage: "Warm" },
  ] } } }],
  ["users", "src\\app\\users\\page.tsx", { states: [{ profiles: [profile], activity: [session], canManage: true, currentUserId: id }] }],
  ["users-create", "src\\app\\users\\page.tsx", { states: [{ profiles: [profile], activity: [], canManage: true, currentUserId: id }, "new", profile, "", "", false, "", null, "", "", true, null, ""] }],
  ["users-password", "src\\app\\users\\page.tsx", { states: [{ profiles: [profile], activity: [], canManage: true, currentUserId: id }, null, profile, "", "", false, "", profile, "", "", true, null, ""] }],
  ["users-delete", "src\\app\\users\\page.tsx", { states: [{ profiles: [profile], activity: [], canManage: true, currentUserId: id }, null, profile, "", "", false, "", null, "", "", true, profile, ""] }],
  ["settings", "src\\app\\settings\\page.tsx", { states: [{ stages, settings: configuration, canManagePicklists: true }, "", "", false, ""] }],
  ["access", "src\\components\\access-editor.tsx", { component: "AccessEditor", states: [accessData, "counselor", {}, "", "", false] }],
  ["access-users", "src\\components\\access-editor.tsx", { component: "AccessEditor", props: { individual: true }, states: [accessData, "", {}, "", "", false] }],
  ["leads", "src\\app\\leads\\page.tsx", { overrides: { "@/lib/live-leads-client": liveMock } }],
  ["leads-selected", "src\\app\\leads\\page.tsx", { states: [filter, "", [lead.id], false, "", "", "", 0, null, false], overrides: { "@/lib/live-leads-client": liveMock } }],
  ["leads-transfer", "src\\app\\leads\\page.tsx", { states: [filter, "", [lead.id], false, "", "", "", 0, null, false, "", null, false, "", false, [null], "transfer"], overrides: { "@/lib/live-leads-client": liveMock } }],
  ["leads-empty", "src\\app\\leads\\page.tsx", { overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, leads: [] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["leads-create", "src\\app\\leads\\new\\page.tsx", { overrides: { "@/lib/live-leads-client": liveMock } }],
  ["leads-conditions", "src\\app\\leads\\page.tsx", { states: [{ ...filter, criteria: [{ id: "stage-filter", field: "stage", operator: "in", value: stages[0].name }, { id: "date-filter", field: "createdAt", operator: "between", value: "2026-10-01", secondValue: "2026-10-31" }] }, "", [], false, "", "", "", 0, ["name", "stage"], true], overrides: { "@/lib/live-leads-client": liveMock } }],
  ["pipeline", "src\\app\\pipeline\\page.tsx", { overrides: { "@/lib/live-leads-client": liveMock } }],
  ["pipeline-empty", "src\\app\\pipeline\\page.tsx", { overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, leads: [] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["lead-import", "src\\app\\leads\\import\\page.tsx", { overrides: { "@/lib/live-leads-client": liveMock } }],
  ["lead-detail", "src\\app\\leads\\[id]\\page.tsx", { overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [], activities: [], emails: [] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["lead-duplicates", "src\\app\\leads\\[id]\\page.tsx", { states: [false,false,"","","","",true,true,"","","overview"], overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [], activities: [], emails: [], duplicates: [{ assignee: "Guneswari Bokam", merge_target_id: "duplicate-1" }, { assignee: "Other team counselor", merge_target_id: null }] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["lead-scheduled", "src\\app\\leads\\[id]\\page.tsx", { overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [], activities: [], emails: [], scheduledCalls: [{ id: "call-1", user_id: id, scheduled_at: "2099-12-01T10:00:00Z", status: "scheduled" }] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["lead-many-calls", "src\\app\\leads\\[id]\\page.tsx", { states: [false,false,"","","","",false,false,"","","calls"], overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [], activities: [{ id: "call-audit", user_id: id, type: "call", description: "Call rescheduled", created_at: lead.createdAt, meta: { actor_name: profile.fullName, changes: { scheduled_at: { before: "2099-12-01T10:00:00Z", after: "2099-12-02T10:00:00Z" } } } }], emails: [], scheduledCalls: manyScheduledCalls, canScheduleCall: false }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["lead-audit", "src\\app\\leads\\[id]\\page.tsx", { overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [], emails: [], activities: [{ id: "audit", type: "updated", description: "Lead details updated", user_id: id, created_at: lead.createdAt, meta: { actor_name: profile.fullName, changes: { course: { before: "Clinical research", after: "Clinical Embryology" }, stage_id: { before: stages[0].id, after: stages[1].id } } } }] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["lead-schedule", "src\\app\\leads\\[id]\\page.tsx", { states: [false, false, "", "", "", "", false, [], "", "", "overview", true, "2099-12-01T10:00", "", false], overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [], activities: [], emails: [] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["lead-notes", "src\\app\\leads\\[id]\\page.tsx", { states: [false, false, "", "", "", "", false, [], "", "", "note"], overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [{ id: "note-1", content: "Discussed course eligibility and the next admission steps.", user_id: id, created_at: lead.createdAt }], activities: [], emails: [] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["lead-emails", "src\\app\\leads\\[id]\\page.tsx", { states: [false, false, "", "", "", "", false, [], "", "", "email"], overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, mailbox: { email: "counselor@gmail.com" }, notes: [], activities: [], emails: [{ id: "email-1", from_email: "counselor@gmail.com", to_email: lead.email, subject: "Your course information", body: "Thank you for your interest. Here are the next steps for your application.", status: "sent", direction: "outbound", created_at: lead.createdAt }] }, loading: false, error: "", reload() {}, setError() {} }) } } }],
  ["reports", "src\\app\\reports\\page.tsx", { overrides: { "@/components/reports-data-provider": { useReportsData: () => ({ user, leads: [lead], reports: [report], filters: live.filters }) } } }],
  ["report-list", "src\\app\\reports\\[id]\\[mode]\\page.tsx", { overrides: { "@/components/reports-data-provider": { useReportsData: () => ({ user, leads: [lead], reports: [report] }) } } }],
  ["report-count", "src\\app\\reports\\[id]\\[mode]\\page.tsx", { overrides: { "next/navigation": { useParams: () => ({ id: report.id, mode: "count" }) }, "@/components/reports-data-provider": { useReportsData: () => ({ user, leads: [lead], reports: [report] }) } } }],
  ["meetings", "src\\app\\meetings\\page.tsx", { states: [true, "", null, "", new Date(2026, 9, 1)], overrides: { "../integrations/operational-ui": opMock } }],
  ["invoices", "src\\app\\invoices\\page.tsx", { states: [true, "", "", "", lead.id, "2", "12500", "1800", "500"], overrides: { "@/app/integrations/operational-ui": opMock } }],
  ["invoice-detail", "src\\app\\invoices\\page.tsx", { states: [false, "", "", "invoice-1"], overrides: { "@/app/integrations/operational-ui": opMock } }],
  ["lead-invoices", "src\\app\\leads\\[id]\\page.tsx", { states: [false,false,"","","","",false,false,"","","invoices"], overrides: {
    "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [], activities: [], emails: [] }, loading: false, error: "", reload() {}, setError() {} }) },
    "@/app/integrations/operational-ui": { ...op, useOperationalData: () => operational(operations["/api/invoices"]) },
  } }],
  ["automations", "src\\app\\automations\\page.tsx", { states: [true, null], overrides: { "../integrations/operational-ui": opMock } }],
  ["integrations", "src\\app\\integrations\\page.tsx", { states: [true, "website", "", "stage-1", "", "", null, false, "", null, null], overrides: { "./operational-ui": opMock, "@/app/integrations/operational-ui": opMock } }],
  ["integrations-empty", "src\\app\\integrations\\page.tsx", { overrides: { "./operational-ui": emptyIntegrationMock, "@/app/integrations/operational-ui": emptyIntegrationMock } }],
  ["integrations-clean-source", "src\\app\\integrations\\page.tsx", { states: [true, "website", "", "stage-1", "", "", null, false, "", null, null], overrides: { "./operational-ui": emptyIntegrationMock, "@/app/integrations/operational-ui": emptyIntegrationMock } }],
  ["integrations-setup", "src\\app\\integrations\\page.tsx", { states: [false, "website", "", "stage-1", "", "", null, false, "", null, null, "", "smtp"], overrides: { "./operational-ui": opMock, "@/app/integrations/operational-ui": opMock } }],
  ["integrations-website-guide", "src\\app\\integrations\\page.tsx", { states: [false, "website", "", "stage-1", "", "", null, false, "", null, null, "", "intake"], overrides: { "./operational-ui": opMock, "@/app/integrations/operational-ui": opMock } }],
  ["integrations-meta-guide", "src\\app\\integrations\\page.tsx", { states: [false, "website", "", "stage-1", "", "", null, false, "", null, null, "", "facebook"], overrides: { "./operational-ui": opMock, "@/app/integrations/operational-ui": opMock } }],
  ["integrations-facebook", "src\\app\\integrations\\page.tsx", { states: [true, "facebook", "", "stage-1", "", "", null, false, "", null, null, "", null, false, "", "", false, "", "All integrations", ""], overrides: { "./operational-ui": opMock, "@/app/integrations/operational-ui": opMock } }],
  ["login-activity", "src\\app\\admin\\login-activity\\page.tsx", { overrides: { "@/lib/server/auth": server } }],
  ["notifications", "src\\app\\notifications\\page.tsx", { overrides: { "@/lib/server/auth": server } }],
  ["help", "src\\app\\help\\page.tsx", {}],
];
cases.push(...cases.filter(([name]) => ["lead-notes", "lead-emails", "lead-many-calls", "lead-audit", "lead-invoices"].includes(name)).map(([name, file, options]) => {
  const states = [false,false,"","","","",false,false,"","",name === "lead-audit" ? "overview" : options.states[10],false,"","",false,Date.now(),"","timeline"];
  return [`${name}-timeline`, file, { ...options, states }];
}));

for (const [name, file, options] of cases) test(`live UI renders ${name} inside the authorized workspace`, async () => {
  currentPath = name.startsWith("users") ? "/users" : name.startsWith("integrations") ? "/integrations" : name === "dashboard" ? "/" : name === "lead-import" ? "/leads/import" : name === "lead-detail" ? "/leads/lead-1" : name === "leads-create" ? "/leads/new" : name === "access-users" ? "/settings/access/users" : name === "access" ? "/settings/access" : name.startsWith("report-") ? `/reports/report-1/${name === "report-count" ? "count" : "list"}` : name === "login-activity" ? "/admin/login-activity" : `/${name}`;
  let html;
  if (options.component) {
    const Component = load(file, { ...baseline, react: hookStates(options.states) })[options.component];
    html = renderToStaticMarkup(React.createElement(shell, { user }, React.createElement(Component, options.props)));
  } else html = await renderPage(file, options);
  assert.match(html, /class="app-layout"/);
  assert.match(html, /class="page-content"/);
  assert.match(html, /<h1/);
  assert.doesNotMatch(html, /Send password setup|Demo mode/);
  if (name === "dashboard") {
    assert.equal((html.match(/class="panel kpi-card"/g) ?? []).length, 4);
    assert.equal((html.match(/class="stage-bar-track"/g) ?? []).length, 3);
    assert.match(html, /Follow-ups needing attention/);
  }
  if (name === "users") assert.match(html, /class="table-sub">admin@example.com/);
  if (name === "meetings") {
    assert.equal((html.match(/class="calendar-cell calendar-date/g) ?? []).length, 42);
    assert.match(html, /class="operational-form"/);
  }
  if (["invoices", "automations", "integrations"].includes(name)) assert.match(html, /class="operational-form(?: invoice-form| integration-source-form)?"/);
  if (name === "lead-import") {
    assert.match(html, /<strong>Import leads<\/strong>/);
    assert.match(html, /class="import-dropzone"/);
  }
  if (name === "lead-detail") {
    assert.match(html, /class="lead-detail-layout lead-refined-workspace"/);
    assert.match(html, /aria-label="Lead sections"/);
    assert.match(html, /role="tablist" aria-label="Overview views"/);
  }
  if (name === "leads") {
    assert.match(html, /class="lead-cell" href="\/leads\/lead-1">Alex Morgan<\/a>/);
    assert.doesNotMatch(html, /class="avatar"/);
  }
  if (name === "settings") {
    for (const field of ["Name", "Email", "Country code", "Phone", "Country", "Qualification", "Category", "Course", "Source", "Stage", "Assignee", "Closure Fee"])
      assert.ok(html.includes(field), `settings field list includes ${field}`);
    assert.match(html, /Preferred campus/);
    assert.match(html, /Delhi/);
    assert.match(html, /Dubai/);
    assert.match(html, /New field type/);
  }
  if (name === "pipeline") assert.match(html, /class="pipeline-journey-steps"/);
  if (name === "reports") assert.match(html, /class="reports-grid"/);
  if (name === "access-users") assert.match(html, /aria-current="page">User exceptions/);
  if (name === "login-activity") {
    assert.match(html, /Sign out device/);
    assert.match(html, /Windows computer/);
    assert.doesNotMatch(html, /IP address|Device \/ browser|Mozilla|<th>Location/);
  }
  if (process.env.UI_FIXTURE_DIR) {
    const directory = process.env.UI_FIXTURE_DIR;
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${name}.html`), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>UI validation: ${name}</title></head><body>${html}</body></html>`);
  }
});

test("CRM controls and mobile layout share explicit styles rather than browser defaults", () => {
  const css = readFileSync(path.join(root, "src", "app", "modules.css"), "utf8");
  assert.match(css, /\.operational-form > label/);
  assert.match(css, /\.page-content :where\(input/);
  assert.match(css, /minmax\(min\(100%,240px\),1fr\)/);
  assert.match(css, /\.page-content \.live-history-grid/);
  assert.match(readFileSync(path.join(root, "src", "app", "globals.css"), "utf8"), /\.table-sub \{ display: block/);
});

test("sidebar removes Help and support and keeps scrollable responsive navigation", () => {
  const html = renderToStaticMarkup(React.createElement(shell, { user }, "Content"));
  assert.doesNotMatch(html, /Help &amp; support|href="\/help"/);
  for (const label of ["Dashboard", "CRM settings", "Admissions Administrator"]) assert.ok(html.includes(label));
  const css = readFileSync(path.join(root, "src", "app", "globals.css"), "utf8");
  assert.match(css, /\.side-nav \{[^}]*overflow-y: auto;[^}]*scrollbar-width: none/);
  assert.match(css, /\.side-nav::-webkit-scrollbar \{ display: none; \}/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /@media \(max-height: 850px\)/);
  assert.match(css, /width: min\(270px, calc\(100vw - 32px\)\)/);
  assert.match(css, /\.sidebar\.sidebar-open \{[^}]*visibility: visible/);
});

test("shared sidebar preserves permitted navigation and profile for every role", () => {
  const { DEFAULT_ROLE_PERMISSIONS } = load("src\\lib\\permissions.ts");
  const { navigationItems } = load("src\\lib\\navigation.ts");
  for (const role of ["counselor", "team_lead", "manager", "admin", "super_admin"]) {
    const roleUser = { ...user, profile: { ...profile, role }, permissions: DEFAULT_ROLE_PERMISSIONS[role] };
    const html = renderToStaticMarkup(React.createElement(shell, { user: roleUser }, "Workspace"));
    const sidebar = html.match(/<aside[\s\S]*?<\/aside>/)[0];
    const expected = navigationItems.filter(item => roleUser.permissions.includes(item.permission)
      && (item.href !== "/admin/login-activity" || ["admin", "super_admin"].includes(role)));
    assert.deepEqual([...sidebar.matchAll(/class="nav-link[^"]*" href="([^"]+)"/g)].map(match => match[1]), expected.map(item => item.href), role);
    assert.match(sidebar, /class="brand-mark"/);
    assert.match(sidebar, /class="profile-card"/);
    assert.ok(sidebar.includes(role.replaceAll("_", " ")));
    assert.equal(sidebar.includes(">MANAGE<"), expected.some(item => item.group === "manage"), role);
    assert.doesNotMatch(sidebar, /Help &amp; support/);
    if (process.env.UI_FIXTURE_DIR) {
      mkdirSync(process.env.UI_FIXTURE_DIR, { recursive: true });
      writeFileSync(path.join(process.env.UI_FIXTURE_DIR, `sidebar-${role}.html`), `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body>${html}</body></html>`);
    }
  }
  const restricted = { ...user, permissions: ["dashboard.view"] };
  const html = renderToStaticMarkup(React.createElement(shell, { user: restricted }, "Workspace"));
  assert.doesNotMatch(html, />MANAGE<|href="\/users"|href="\/settings"/);
});

test("site actions suppress decorative borders and mouse rings while retaining keyboard focus", () => {
  const css = readFileSync(path.join(root, "src", "app", "globals.css"), "utf8");
  assert.match(css, /:is\(button, a, summary, \[role="button"\]\):not\(:focus-visible\) \{ outline: none !important; \}/);
  assert.match(css, /:is\(button, \.button, summary, \[role="button"\]\) \{ border-color: transparent !important; box-shadow: none !important; \}/);
  assert.match(css, /:is\(button, a, summary, \[role="button"\]\):focus-visible \{ filter: brightness\(\.85\); \}/);
  assert.match(css, /\.nav-link:focus-visible \{ background: #254974; color: #fff; \}/);
});

test("lead filters use the retained compact sidebar with columns in the results toolbar", async () => {
  const html = await renderPage("src\\app\\leads\\page.tsx", { overrides: { "@/lib/live-leads-client": liveMock } });
  const sidebar = html.match(/<aside class="lead-filter-sidebar"[\s\S]*?<\/aside>/)?.[0];
  assert.ok(sidebar);
  for (const control of ["Search leads", "My Leads", "Condition matching", "Add condition", "Reset", "Saved filters", "Filter name", "Save filter"]) assert.ok(sidebar.includes(control), control);
  assert.doesNotMatch(sidebar, /class="data-table"/);
  assert.match(html, /<\/aside><div class="lead-results">/);
  assert.match(html, /Columns/);
  assert.match(html, /class="leads-workspace"/);
  assert.match(html, /class="leads-view-bar"/);
  assert.match(html, /aria-label="Lead results"/);
  assert.match(html, /Export CSV/);
  assert.match(html, /New lead/);
  const header = html.match(/<header class="page-heading leads-heading"[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  assert.doesNotMatch(header, />Refresh<|Import CSV|href="\/leads\/import"/);
  const css = readFileSync(path.join(root, "src", "app", "leads", "leads.css"), "utf8");
  assert.match(css, /grid-template-columns: 218px minmax\(0,1fr\)/);
  assert.match(css, /@media \(max-width: 940px\)/);
});

function elements(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}

function invoiceHarness(data = operations["/api/invoices"], initial = [], overrides = {}) {
  const states = [...initial], requests = [], urls = [];
  let index = 0;
  const { InvoiceWorkspace } = load("src\\components\\invoice-workspace.tsx", {
    ...baseline,
    react: { ...React, useEffect() {}, useRef: () => ({ current: null }), useState(initial) { const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = value; }]; } },
    "@/app/integrations/operational-ui": { ...op, ...overrides, useOperationalData: url => {
      urls.push(url);
      return { ...operational(data), mutate: async (...args) => { requests.push(args); return true; } };
    } },
  });
  return { states, requests, urls, render(props = {}) { index = 0; return InvoiceWorkspace(props); } };
}

test("invoice form scopes to the lead, previews percentage discounts and submits the invoice contract", async () => {
  const payload = { lead_id: lead.id, quantity: "2", unit_price: "12500", tax_amount: "1800", discount_percent: "2", description: "Admission", due_date: "2026-12-01" };
  const ui = invoiceHarness(undefined, [true, "", "", "", lead.id, "2", "12500", "1800", "2"], { formValues: () => payload });
  let nodes = elements(ui.render({ leadId: lead.id }));
  assert.equal(ui.urls[0], "/api/invoices?leadId=lead-1");
  assert.equal(nodes.find(node => node.props?.name === "lead_id").props.value, lead.id);
  assert.ok(!nodes.some(node => node.props?.ariaLabel === "Invoice lead"));
  assert.equal(nodes.find(node => node.props?.name === "discount_reason").props.required, true);
  assert.equal(nodes.find(node => node.props?.name === "discount_percent").props.max, 100);
  assert.ok(nodes.some(node => node.type === "dd" && /26,300/.test(node.props.children)));
  await nodes.find(node => node.type === "form").props.onSubmit({ preventDefault() {}, currentTarget: {} });
  assert.deepEqual(ui.requests, [["/api/invoices", "POST", payload]]);
  assert.equal(ui.states[0], false);
  assert.equal(ui.states[5], "1");
});

test("invoice details always reflect current record status, provider locks and permissions", () => {
  const data = structuredClone(operations["/api/invoices"]);
  const invoice = data.invoices[0];
  const ui = invoiceHarness(data, [false, "", "", invoice.id]);
  let nodes = elements(ui.render());
  assert.ok(nodes.some(node => node.type === "button" && node.props.children === "Reject"));
  invoice.status = "sent";
  invoice.payment_link_lock_at = "2026-10-21T10:00:00Z";
  invoice.email_lock_at = "2026-10-21T10:00:00Z";
  nodes = elements(ui.render());
  assert.ok(!nodes.some(node => node.type === "button" && node.props.children === "Reject"));
  assert.ok(!nodes.some(node => JSON.stringify(node).toLowerCase().includes("qr")));
  assert.ok(nodes.some(node => node.type === "button" && node.props.disabled && Array.isArray(node.props.children) && node.props.children.includes("Email reconciliation required")));
  data.canApprove = false; data.canCreate = false;
  nodes = elements(ui.render());
  assert.ok(!nodes.some(node => node.type === "button" && (JSON.stringify(node.props.children).includes("Email invoice") || JSON.stringify(node.props.children).includes("Verify external payment"))));
  assert.ok(nodes.some(node => node.type === "a" && node.props.href === "/api/invoices/invoice-1/pdf"));
});

test("installment form only offers server-approved paid course invoices and shows remaining balance", () => {
  const data = structuredClone(operations["/api/invoices"]);
  data.installmentParents = [{ id: "root-invoice", invoice_no: "INV-ROOT", course_total: 300, currency: "INR", balance: 200 }];
  data.courseBalances = { "root-invoice": 200 };
  const ui = invoiceHarness(data, [true, "", "", "", lead.id, "1", "100", "0", "0", "installments", "root-invoice"]);
  const nodes = elements(ui.render());
  assert.ok(nodes.some(node => node.type === "option" && node.props.value === "root-invoice" && /200/.test(node.props.children)));
  assert.ok(nodes.some(node => node.type === "input" && node.props.name === "course_total" && node.props.value === 300));
  assert.ok(nodes.some(node => node.type === "p" && /Remaining course balance after verified payments/.test(node.props.children)));
});

test("invoice timeline uses only persisted events with actors and never renders billing controls", () => {
  const data = structuredClone(operations["/api/invoices"]);
  const invoice = data.invoices[0];
  invoice.status = "sent";
  invoice.invoice_approvals = [{ id: "decision", decision: "approved", requested_by: id, decided_by: id, created_at: lead.createdAt, decided_at: "2026-10-22T10:00:00Z", comment: "Course fee verified" }];
  invoice.sent_at = "2026-10-22T11:00:00Z";
  invoice.paid_at = "2026-10-23T12:00:00Z";
  const html = renderToStaticMarkup(invoiceHarness(data).render({ leadId: lead.id, timelineOnly: true }));
  for (const value of ["Invoices timeline", "Invoice issued", "Invoice approved", "Course fee verified", profile.fullName, "SMTP delivery service", "Verified payment"]) assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /<form|Create invoice|Invoice register|invoice-metrics/);
  assert.ok(html.indexOf("Payment received") < html.indexOf("Invoice issued"));
  assert.equal((html.match(/class="invoice-event"/g) ?? []).length, 4);
});

test("invoice search and status filters combine, while metrics keep currencies separate", () => {
  const data = structuredClone(operations["/api/invoices"]);
  data.invoices[0].status = "sent";
  data.invoices.push({ ...data.invoices[0], id: "invoice-2", invoice_no: "USD-002", currency: "USD", total: 100 });
  const ui = invoiceHarness(data);
  let nodes = elements(ui.render());
  const metric = nodes.find(node => node.props?.className === "panel invoice-metric is-blue");
  const value = elements(metric).find(node => node.type === "strong").props.children;
  assert.match(value, /25,000/);
  assert.match(value, /100/);
  assert.match(value, / \/ /);
  nodes.find(node => node.props?.["aria-label"] === "Search invoices").props.onChange({ target: { value: "usd" } });
  nodes = elements(ui.render());
  assert.equal(nodes.filter(node => node.props?.className === "invoice-number-button").length, 1);
  nodes.find(node => node.props?.ariaLabel === "Invoice status").props.onChange("paid");
  nodes = elements(ui.render());
  assert.equal(nodes.filter(node => node.props?.className === "invoice-number-button").length, 0);
  assert.ok(nodes.some(node => node.type === "h3" && node.props.children === "No matching invoices"));
});

test("lead invoice navigation respects permissions and preserves isolated main and Timeline views", async () => {
  for (const allowed of [true, false]) for (const view of ["overview", "timeline"]) {
    const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
      states: [false,false,"","","","",false,false,"","","invoices",false,"","",false,Date.now(),"",view],
      overrides: {
        "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, user: allowed ? user : { ...user, permissions: ["leads.view"] }, lead, notes: [], emails: [], activities: [] }, loading: false, error: "", reload() {}, setError() {} }) },
        "@/app/integrations/operational-ui": { ...op, useOperationalData: url => { assert.match(url, /^\/api\/invoices\?leadId=/); return operational(operations["/api/invoices"]); } },
      },
    });
    if (!allowed) { assert.doesNotMatch(html, /id="lead-section-invoices"|class="invoice-workspace/); continue; }
    assert.match(html, /lead-section-invoices/);
    assert.match(html, /aria-label="Invoices views"/);
    if (view === "timeline") { assert.match(html, /Invoices timeline/); assert.doesNotMatch(html, /Invoices for this lead/); }
    else { assert.match(html, /Invoices for this lead/); assert.doesNotMatch(html, /Invoices timeline/); }
  }
});

test("compact lead overview uses one uninterrupted field grid without section divisions", async () => {
  const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, lead, notes: [], activities: [], emails: [] }, loading: false, error: "", reload() {}, setError() {} }) } },
  });
  assert.doesNotMatch(html, /lead-field-group|Contact details|Admission details|Ownership &amp; follow-up|Additional information/);
  for (const name of ["Lead name", "Email", "Country code", "Phone", "Alternate phone", "Country", "Course", "Qualification", "Category", "Source", "Stage", "Lead owner", "Closure fee", "Next follow-up", "Preferred campus", "Counselor note"])
    assert.ok(html.includes(`aria-label="${name}"`), name);
  assert.equal((html.match(/class="lead-inline-field"/g) ?? []).length, 16);
  assert.match(html, /type="datetime-local"/);
  assert.match(html, /Autosave enabled/);
  assert.match(html, /Last modified/);
  assert.match(html, /Modified by/);
});

test("global borderless theme preserves focus, field affordances and error states", () => {
  const css = readFileSync(path.join(root, "src", "app", "globals.css"), "utf8");
  assert.match(css, /:root body \*[\s\S]*?border-color: transparent !important/);
  assert.match(css, /:root:root body \*:focus[\s\S]*?outline: none !important/);
  assert.match(css, /:root:root body \*:focus-visible[\s\S]*?outline: none !important/);
  assert.match(css, /:focus-visible\)[\s\S]*?background-color: #eaf1fb !important/);
  assert.match(css, /\[aria-invalid="true"\][\s\S]*?background-color: #fff1f0/);
  assert.match(css, /aria-selected="true"[\s\S]*?background-color: #edf5ff/);
});

test("email composer combines addresses and connection controls without changing sender gates", async () => {
  for (const connected of [true, false]) {
    const data = { ...live, lead, notes: [], activities: [], emails: [], mailbox: connected ? { email: user.email ?? profile.email } : null };
    const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
      states: [false,false,"","Message body","Course information","",false,false,"","","email"],
      overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...data, user: { ...user, email: profile.email } }, loading: false, error: "", reload() {}, setError() {} }) } },
    });
    assert.match(html, /lead-email-envelope/);
    assert.match(html, /lead-mailbox-control/);
    assert.match(html, /Add a subject/);
    assert.ok(html.includes(profile.email));
    assert.ok(html.includes(lead.email));
    assert.match(html, /No shared SMTP sender is used/);
    if (connected) { assert.match(html, /Gmail connected/); assert.doesNotMatch(html, /lead-compose-warning/); }
    else { assert.match(html, /Mailbox not connected/); assert.match(html, /lead-compose-warning/); assert.match(html, /disabled=""[^>]*>Send email/); }
  }
});

test("dashboard role scope includes only assigned personal, recursive team or organization leads", () => {
  const { dashboardScope } = load("src\\lib\\dashboard.ts");
  const profiles = [
    { ...profile, id: "manager", role: "manager" },
    { ...profile, id: "team", role: "team_lead", reportingTo: "manager" },
    { ...profile, id: "counselor", role: "counselor", reportingTo: "team" },
    { ...profile, id: "other", reportingTo: null },
  ];
  const leads = ["manager", "team", "counselor", "other", undefined].map((owner, index) => ({ ...lead, id: String(index), assigneeId: owner }));
  for (const [role, owner, expected] of [
    ["counselor", "counselor", ["2"]],
    ["team_lead", "team", ["1", "2"]],
    ["manager", "manager", ["0", "1", "2"]],
    ["admin", "other", ["0", "1", "2", "3", "4"]],
    ["super_admin", "other", ["0", "1", "2", "3", "4"]],
  ]) {
    assert.deepEqual(dashboardScope({ ...user, id: owner, profile: { ...profile, role } }, leads, profiles).map(item => item.id), expected);
  }
  assert.equal(dashboardScope({ ...user, id: "counselor", profile: { ...profile, role: "counselor" } }, leads, [...profiles, { ...profile, id: "other", reportingTo: "counselor" }]).length, 1);
});

test("dashboard course/country conversions and drilldowns match exact records including empty values", () => {
  const { dashboardGroups, dashboardLink, readDashboardFilter, dashboardCriterion, CONVERSION_STAGES } = load("src\\lib\\dashboard.ts");
  const { filterLeads } = load("src\\lib\\lead-filters.ts");
  const records = [
    { ...lead, id: "1", course: "Medicine", country: "India", stage: "Closed Won" },
    { ...lead, id: "2", course: "Medicine", country: "India", stage: "Closed Lost" },
    { ...lead, id: "3", course: "Nursing", country: "Canada", stage: "Already Enrolled" },
    { ...lead, id: "4", course: "", country: "", stage: "Warm" },
  ];
  const courses = dashboardGroups(records, "course");
  assert.equal(courses.find(item => item.name === "Medicine").rate, 50);
  assert.equal(courses.find(item => item.name === "Nursing").rate, 100);
  assert.equal(dashboardGroups(records, "country").find(item => item.name === "India").converted, 1);
  assert.deepEqual(dashboardGroups([], "course"), []);
  for (const field of ["course", "country"]) {
    for (const group of dashboardGroups(records, field)) {
      const criteria = [dashboardCriterion(field, group.name ? "is" : "is_empty", group.name)];
      const read = extra => readDashboardFilter(new URL(dashboardLink([...criteria, ...extra]), "http://localhost").searchParams.get("dashboard"));
      assert.equal(filterLeads(records, read([])).length, group.total);
      assert.equal(filterLeads(records, read([dashboardCriterion("stage", "in", CONVERSION_STAGES.join("\n"))])).length, group.converted);
      for (const [stage, count] of group.stages) {
        assert.equal(filterLeads(records, read([dashboardCriterion("stage", "is", stage)])).length, count);
      }
    }
  }
  assert.throws(() => readDashboardFilter('{"criteria":[]}'), /invalid/);
  assert.throws(() => readDashboardFilter("broken"));
});

test("dashboard date drilldowns preserve UTC midnight boundaries regardless of local timezone", () => {
  const { filterDashboardLeads, dashboardCriterion, dashboardLink, readDashboardFilter } = load("src\\lib\\dashboard.ts");
  const records = [
    { ...lead, id: "before", createdAt: "2026-10-21T23:59:00Z" },
    { ...lead, id: "after", createdAt: "2026-10-22T00:01:00Z" },
  ];
  const filter = readDashboardFilter(new URL(dashboardLink([dashboardCriterion("createdAt", "is", "2026-10-22")]), "http://localhost").searchParams.get("dashboard"));
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Asia/Kolkata";
    assert.deepEqual(filterDashboardLeads(records, filter, user.id).map(item => item.id), ["after"]);
    process.env.TZ = "America/Los_Angeles";
    assert.deepEqual(filterDashboardLeads(records, filter, user.id).map(item => item.id), ["after"]);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("dashboard column charts retain axes for empty data and plot exact values with linked bars", () => {
  const { DashboardBarChart } = load("src\\components\\dashboard-bar-chart.tsx");
  const empty = renderToStaticMarkup(React.createElement(DashboardBarChart, { label: "Empty chart", categories: [], percent: true, emptyMessage: "No records" }));
  assert.match(empty, /dashboard-gridline/);
  assert.match(empty, /100%/);
  assert.match(empty, /No data to plot/);
  assert.doesNotMatch(empty, /dashboard-chart-bar/);
  const props = { label: "Conversions", percent: true, emptyMessage: "No records", categories: [
    { label: "India / Medicine", href: "/leads?all", detail: "1 / 2 leads", segments: [{ label: "Converted", value: 50, color: "#32a698", href: "/leads?converted" }] },
    { label: "Canada / Medicine", href: "/leads?canada", detail: "0 / 1 leads", segments: [{ label: "Converted", value: 0, color: "#32a698", href: "/leads?zero" }] },
  ] };
  const nodes = elements(DashboardBarChart(props));
  const rects = nodes.filter(node => node.type === "rect");
  assert.equal(rects[0].props.height, 100);
  assert.equal(rects[1].props.height, 0);
  assert.equal(rects[2].props.fill, "transparent", "zero conversions have a clickable baseline target, not a false bar");
  assert.ok(nodes.some(node => node.type === Link && node.props.href === "/leads?converted"));
  assert.ok(nodes.some(node => node.type === Link && node.props.href === "/leads?zero"));
});

test("country/course conversion bars use pair-specific totals and drilldowns", async () => {
  const { dashboardCombinationGroups, filterDashboardLeads, readDashboardFilter } = load("src\\lib\\dashboard.ts");
  const records = [
    { ...lead, id: "1", country: "India", course: "Medicine", stage: "Closed Won" },
    { ...lead, id: "2", country: " india ", course: "medicine", stage: "Warm" },
    { ...lead, id: "3", country: "India", course: "Nursing", stage: "Already Enrolled" },
    { ...lead, id: "4", country: "Canada", course: "Medicine", stage: "Closed Lost" },
    { ...lead, id: "5", country: "", course: "", stage: "Warm" },
  ];
  const groups = dashboardCombinationGroups(records);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups[0], { country: "India", course: "Nursing", total: 1, converted: 1, rate: 100 });
  assert.equal(groups.find(group => group.country === "India" && group.course === "Medicine").rate, 50);
  assert.equal(groups.find(group => group.country === "Canada").rate, 0);
  assert.deepEqual(dashboardCombinationGroups([]), []);
  const Component = load("src\\app\\page.tsx", {
    "@/lib/server/auth": { requireUser: async () => ({ user, supabase: {} }) },
    "@/lib/crm-data": { ...crm, fetchLeads: async () => records },
  }).default;
  const nodes = elements(await Component());
  const chart = nodes.find(node => node.props?.label === "Country + course conversion");
  assert.ok(chart);
  const rows = chart.props.categories;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    const read = href => readDashboardFilter(new URL(href, "http://localhost").searchParams.get("dashboard"));
    const all = filterDashboardLeads(records, read(row.href), user.id);
    const converted = filterDashboardLeads(records, read(row.segments[0].href), user.id);
    const expected = groups.find(group => group.country.toLowerCase() === all[0].country.trim().toLowerCase() && group.course.toLowerCase() === all[0].course.trim().toLowerCase());
    assert.equal(all.length, expected.total);
    assert.equal(converted.length, expected.converted);
    assert.equal(read(row.segments[0].href).criteria.length, 3);
    assert.equal(read(row.segments[0].href).matchMode, "all");
    assert.equal(row.segments[0].value, expected.rate);
  }
});

test("chart segments, donut slices and follow-up bars open exactly their displayed lead counts", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const records = [
    { ...lead, id: "won", stage: "Closed Won", course: "Medicine", followUpAt: `${today}T08:00:00Z` },
    { ...lead, id: "enrolled", stage: "Already Enrolled", course: "Nursing", country: "Canada", followUpAt: undefined },
    { ...lead, id: "due", stage: stages[0].name, course: "Medicine", followUpAt: `${today}T00:01:00Z` },
    { ...lead, id: "overdue", stage: stages[0].name, country: "", course: "", followUpAt: "2020-01-01T00:00:00Z" },
  ];
  const Component = load("src\\app\\page.tsx", {
    "@/lib/server/auth": { requireUser: async () => ({ user, supabase: {} }) },
    "@/lib/crm-data": { ...crm, fetchLeads: async () => records },
  }).default;
  const tree = elements(await Component());
  const nodes = [...tree, ...tree.filter(node => typeof node.type === "function" && node.type.name === "DashboardBarChart").flatMap(node => elements(node.type(node.props)))];
  const { readDashboardFilter, filterDashboardLeads } = load("src\\lib\\dashboard.ts");
  const chartLinks = nodes.filter(node => node.props?.href?.startsWith("/leads?dashboard=") && (
    node.props.className === "dashboard-followup-row" || ((node.type === "a" || node.type === Link) && node.props["aria-label"]?.endsWith(" leads"))
  ));
  assert.ok(chartLinks.length >= 8);
  for (const link of chartLinks) {
    const label = link.props["aria-label"];
    const expected = label.match(/(\d+) (?:converted |other )?leads$/);
    assert.ok(expected, label);
    const filter = readDashboardFilter(new URL(link.props.href, "http://localhost").searchParams.get("dashboard"));
    assert.equal(filterDashboardLeads(records, filter, user.id).length, Number(expected[1]), label);
  }
});

test("dashboard chart colors are muted and stage colors match across panels", async () => {
  const Component = load("src\\app\\page.tsx", {
    "@/lib/server/auth": { requireUser: async () => ({ user, supabase: {} }) },
    "@/lib/crm-data": { ...crm, fetchLeads: async () => [lead, { ...lead, id: "won", stage: "Closed Won" }] },
  }).default;
  const nodes = elements(await Component());
  const charts = nodes.filter(node => typeof node.type === "function" && node.type.name === "DashboardBarChart");
  const colors = charts.flatMap(chart => chart.props.categories.flatMap(category => category.segments.map(segment => segment.color)));
  colors.push(...nodes.flatMap(node => [node.props?.pathLength ? node.props.stroke : undefined, node.props?.style?.background]).filter(color => /^#[0-9a-f]{6}$/i.test(color ?? "")));
  assert.ok(colors.length > 5);
  for (const color of colors) {
    const channels = color.slice(1).match(/../g).map(channel => parseInt(channel, 16) / 255);
    const max = Math.max(...channels), min = Math.min(...channels);
    const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(max + min - 1));
    assert.ok(saturation <= 0.3, `${color} should remain low saturation`);
  }
  const breakdown = charts.find(chart => chart.props.label === "Leads by course and stage");
  for (const row of nodes.filter(node => node.props?.className === "stage-row dashboard-stage-row")) {
    const children = elements(row);
    const name = children.find(node => node.type === "span").props.children;
    const bar = children.find(node => node.props?.className === "stage-bar");
    const segment = breakdown.props.categories.flatMap(category => category.segments).find(segment => segment.label === name);
    if (segment) assert.equal(bar.props.style.background, segment.color);
  }
});

test("dashboard renders course/country analyses and linked metrics for each role", async () => {
  for (const role of ["counselor", "team_lead", "manager", "admin", "super_admin"]) {
    const scopedUser = { ...user, profile: { ...profile, role } };
    const records = [{ ...lead, stage: "Closed Won" }, { ...lead, id: "foreign", name: "Outside scope", assigneeId: "other", country: "Hidden country", course: "Hidden course" }];
    const html = await renderPage("src\\app\\page.tsx", {
      shellUser: scopedUser,
      overrides: {
        "@/lib/server/auth": { requireUser: async () => ({ user: scopedUser, supabase: { from: () => query([]) } }) },
        "@/lib/crm-data": { ...crm, fetchLeads: async () => records },
      },
    });
    for (const title of ["Leads by course", "Leads by country", "Course conversion leaders", "Country conversion leaders", "Converted leads"]) assert.ok(html.includes(title));
    assert.match(html, /href="\/leads\?dashboard=/);
    assert.ok(html.indexOf("<h2>Lead activity</h2>") < html.indexOf("<h2>Leads by course</h2>"));
    const dashboardContent = html.slice(html.indexOf('class="dashboard-workspace"'));
    assert.doesNotMatch(dashboardContent, /Create lead|href="\/leads\?create=1"/);
    assert.doesNotMatch(dashboardContent, /<table|Recent leads|class="activity-list"/);
    assert.match(dashboardContent, /class="dashboard-chart-bar"/);
    assert.match(dashboardContent, /class="dashboard-donut"/);
    assert.match(dashboardContent, /class="dashboard-followup-row"/);
    if (!["admin", "super_admin"].includes(role)) assert.doesNotMatch(html, /Hidden country|Hidden course|Outside scope/);
    else assert.match(html, /Hidden country/);
  }
});

test("opening a dashboard link applies its criteria and personal role scope in Leads", (t) => {
  const dashboard = load("src\\lib\\dashboard.ts");
  const href = dashboard.dashboardLink([dashboard.dashboardCriterion("country", "is", "India")], "India leads");
  const previousWindow = global.window;
  let onPop;
  global.window = { location: { search: new URL(href, "http://localhost").search }, addEventListener(_event, handler) { onPop = handler; }, removeEventListener() {} };
  t.after(() => { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; });
  const states = [], refs = [], effects = [];
  let index = 0, refIndex = 0, error = "";
  const records = [
    lead,
    { ...lead, id: "other-country", country: "Canada" },
    { ...lead, id: "other-owner", assigneeId: "other" },
  ];
  const Component = load("src\\app\\leads\\page.tsx", {
    "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: path => {
      const params = new URL(path,"http://localhost").searchParams;
      const actor = { ...user, profile: { ...profile, role: "counselor" } };
      const scoped = params.get("dashboard") === "1" ? dashboard.dashboardScope(actor,records,[profile]) : records;
      const selected = params.has("filter") ? dashboard.filterDashboardLeads(scoped,JSON.parse(params.get("filter")),actor.id) : scoped;
      return { data: { ...live, leads: selected, user: actor }, loading: false, error, reload() {}, setError(value) { error = value; } };
    } },
    react: {
      ...React,
      useEffect(effect) { effects.push(effect); }, useLayoutEffect() {},
      useMemo: factory => factory(),
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
      useState(initial) { const key = index++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }]; },
    },
  }).default;
  const render = () => { index = 0; refIndex = 0; return elements(Component()); };
  render();
  for (const effect of effects.splice(0)) effect();
  const nodes = render();
  const links = nodes.filter(node => node.props?.className === "lead-cell");
  assert.deepEqual(links.map(node => node.props.href), ["/leads/lead-1"]);
  assert.ok(nodes.some(node => node.type === "h2" && node.props.children === "India leads"));
  global.window.location.search = "?dashboard=invalid";
  onPop();
  assert.ok(error.length > 0);
});

test("pipeline filters, sorts and moves records with permission and concurrent-save guards", async () => {
  const states = [], refs = [], requests = [];
  let index = 0, refIndex = 0, error = "", finishSave, failSave, reloads = 0;
  let pipelineData = {
    ...live,
    leads: [
      lead,
      { ...lead, id: "lead-2", name: "Zara Patel", assigneeId: undefined, assignee: "", stageId: undefined, createdAt: "2026-10-22T09:00:00Z", followUpAt: undefined },
      { ...lead, id: "lead-3", name: "Bea Evans", stageId: stages[1].id, createdAt: "2026-10-20T09:00:00Z", followUpAt: "2019-01-01T09:00:00Z" },
    ],
  };
  const Component = load("src\\app\\pipeline\\page.tsx", {
    "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: path => {
      const params = new URL(path,"http://localhost").searchParams;
      const filter = params.has("filter") ? JSON.parse(params.get("filter")) : { ...liveMock.emptyFilter() };
      const owner = params.get("owner"), stage = params.get("stage"), sort = params.get("sort") ?? "newest";
      let rows = load("src\\lib\\lead-filters.ts").filterLeads(pipelineData.leads,filter,new Date(),{ currentUserId: user.id });
      rows = rows.filter(row => (!owner || (owner === "__unassigned" ? !row.assigneeId : row.assigneeId === owner))
        && (!stage || (stage === "__none" ? !row.stageId : row.stageId === stage)));
      const time = (value, fallback) => value ? Date.parse(value) : fallback;
      rows.sort((a,b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "followUp"
        ? time(a.followUpAt,Infinity)-time(b.followUpAt,Infinity) : time(b.createdAt,0)-time(a.createdAt,0)) || a.name.localeCompare(b.name));
      return { data: { ...pipelineData, leads: rows }, loading: false, error, reload: async () => { reloads++; }, setError: value => { error = value; } };
    } },
    "@/lib/crm-data": { ...crm, apiRequest: (...args) => { requests.push(args); return new Promise((resolve, reject) => { finishSave = resolve; failSave = reject; }); } },
    react: {
      ...React,
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
      useState(initial) { const key = index++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }]; },
    },
  }).default;
  const render = () => { index = 0; refIndex = 0; return elements(Component()); };
  const menu = label => render().find(node => node.props?.ariaLabel === label);
  const cards = () => render().filter(node => node.type === "article");
  const search = value => render().find(node => node.props?.["aria-label"] === "Search pipeline").props.onChange({ target: { value } });
  const clear = () => render().find(node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.includes("Clear filters")).props.onClick();
  assert.equal(cards().length, 3);
  menu("Filter by owner").props.onChange("__unassigned");
  assert.deepEqual(cards().map(card => card.props["aria-label"]), ["Zara Patel"]);
  clear();
  menu("Filter by stage").props.onChange(stages[1].id);
  assert.deepEqual(cards().map(card => card.props["aria-label"]), ["Bea Evans"]);
  clear();
  menu("Filter by stage").props.onChange("__none");
  assert.deepEqual(cards().map(card => card.props["aria-label"]), ["Zara Patel"]);
  clear();
  render().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: true } });
  assert.equal(cards().length, 2);
  clear();
  search("  CLINICAL ");
  assert.equal(cards().length, 3);
  search("no matches");
  assert.equal(cards().length, 0);
  clear();
  pipelineData = { ...pipelineData, leads: pipelineData.leads.map(item => ({ ...item, stageId: stages[0].id })) };
  menu("Sort pipeline").props.onChange("name");
  assert.deepEqual(cards().map(card => card.props["aria-label"]), ["Alex Morgan", "Bea Evans", "Zara Patel"]);
  menu("Sort pipeline").props.onChange("followUp");
  assert.deepEqual(cards().map(card => card.props["aria-label"]), ["Bea Evans", "Alex Morgan", "Zara Patel"]);
  menu("Sort pipeline").props.onChange("newest");
  assert.deepEqual(cards().map(card => card.props["aria-label"]), ["Zara Patel", "Alex Morgan", "Bea Evans"]);
  await menu("Stage for Alex Morgan").props.onChange(stages[0].id);
  assert.equal(requests.length, 0, "same-stage moves do not write");
  menu("Stage for Alex Morgan").props.onChange(stages[1].id);
  menu("Stage for Bea Evans").props.onChange(stages[2].id);
  assert.equal(requests.length, 1, "only one move may save at a time");
  assert.deepEqual(requests[0], ["/api/leads/lead-1", { method: "PATCH", body: { stageId: stages[1].id } }]);
  finishSave({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reloads, 1);
  assert.ok(render().some(node => node.props?.role === "status"));
  menu("Stage for Alex Morgan").props.onChange(stages[2].id);
  failSave(new Error("Stage update denied"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(error, "Stage update denied");
  assert.equal(reloads, 1);
  const drop = render().find(node => node.props?.["aria-label"] === `${stages[2].name}: 0 leads`);
  drop.props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => "lead-1" } });
  assert.equal(requests.length, 2, "unrelated dragged text cannot move a lead");
  cards().find(card => card.props["aria-label"] === "Alex Morgan").props.onDragStart({ dataTransfer: { setData() {} } });
  render().find(node => node.props?.["aria-label"] === `${stages[2].name}: 0 leads`).props.onDrop({ preventDefault() {}, dataTransfer: { getData: () => "lead-1" } });
  assert.equal(requests.length, 3);
  finishSave({});
  await new Promise(resolve => setImmediate(resolve));
  pipelineData = { ...pipelineData, user: { ...user, permissions: ["pipeline.view"] } };
  assert.ok(cards().every(card => card.props.draggable === false));
  assert.equal(menu("Stage for Alex Morgan"), undefined);
});

test("integration setup exposes masked credentials, login warnings and separate SMTP test controls", async () => {
  const html = await renderPage("src\\app\\integrations\\page.tsx", {
    states: [false, "website", "", "stage-1", "", "", null, false, "", null, null, "", "smtp"],
    overrides: { "./operational-ui": opMock, "@/app/integrations/operational-ui": opMock },
  });

  test("empty integration sections show concise guidance rather than blank table headers", async () => {
    const html = await renderPage("src\\app\\integrations\\page.tsx", {
      overrides: { "./operational-ui": emptyIntegrationMock, "@/app/integrations/operational-ui": emptyIntegrationMock },
    });
    assert.doesNotMatch(html, /<table|<thead/);
    for (const text of ["No Facebook Pages connected", "No lead sources yet", "Your mailbox is not connected", "View Gmail setup guide"]) assert.ok(html.includes(text), text);
    assert.match(html, /<details class="integration-section-help"><summary>About inbox sync/);
    assert.doesNotMatch(html, /class="operational-form integration-source-form"/);
  });

  test("source creation keeps required fields aligned and secondary settings collapsed", async () => {
    const html = await renderPage("src\\app\\integrations\\page.tsx", {
      states: [true, "website", "", "stage-1", "", "", null, false, "", null, null],
      overrides: { "./operational-ui": emptyIntegrationMock, "@/app/integrations/operational-ui": emptyIntegrationMock },
    });
    assert.match(html, /aria-label="Create lead source"/);
    assert.match(html, /<details class="integration-source-advanced"><summary>Advanced/);
    assert.match(html, /class="integration-form-footer"/);
    assert.match(html, /type="button"[^>]*>Cancel<\/button>/);
    assert.match(html, /<label><span>Source name <span class="integration-required">\*<\/span><\/span><input/);
    assert.doesNotMatch(html, /No lead sources yet|Close source form/);
    const form = html.match(/<form class="operational-form integration-source-form"[\s\S]*?<\/form>/)?.[0];
    assert.ok(form);
    assert.equal((form.match(/>Create source<\/button>/g) ?? []).length, 1);
  });

  test("connected mailbox with no stored messages shows an inbox empty state", async () => {
    const data = { ...emptyIntegrationOperations, "/api/integrations/gmail": { ...operations["/api/integrations/gmail"], connection: {
      email: "admin@example.com", last_synced_at: null, last_error: null, initialSync: false, hasPendingPage: false, syncInProgress: false,
    } } };
    const mock = { ...op, useOperationalData: url => operational(data[url]) };
    const html = await renderPage("src\\app\\integrations\\page.tsx", { overrides: { "./operational-ui": mock, "@/app/integrations/operational-ui": mock } });
    assert.match(html, /No inbox messages stored yet/);
    assert.match(html, /Sync inbox/);
    assert.doesNotMatch(html, /Your mailbox is not connected|<table/);
  });

  test("source form cancel preserves the existing channel and makes the header action available again", () => {
    const states = [];
    let index = 0;
    const Component = load("src\\app\\integrations\\page.tsx", {
      "./operational-ui": emptyIntegrationMock,
      react: { ...React, useEffect() {}, useRef: () => ({ current: null }), useState(initial) {
        const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = value; }];
      } },
    }).default;
    const render = () => { index = 0; return elements(Component()); };
    const section = () => render().find(node => node.props?.id === "integration-sources");
    elements(section()).find(node => node.type === "button" && node.props.children?.[1] === "Create source").props.onClick();
    assert.ok(render().some(node => node.props?.["aria-label"] === "Create lead source"));
    render().find(node => node.type === "button" && node.props.children === "Cancel").props.onClick();
    assert.ok(!render().some(node => node.props?.["aria-label"] === "Create lead source"));
    assert.ok(elements(section()).some(node => node.type === "button"));
  });

  test("source creation shows one-time credentials locally and preserves the form on failure", async t => {
    const previous = global.confirm;
    t.after(() => { if (previous === undefined) delete global.confirm; else global.confirm = previous; });
    global.confirm = () => false;
    const states = [], requests = [];
    let index = 0, failure = "", response = { id: "created-source-id", apiKey: "one-time-test-key" };
    const mock = { ...emptyIntegrationMock, formValues: () => ({ name: "DMHCA Website", owner_id: id, stage_id: "stage-1" }),
      operationRequest: async (...args) => { requests.push(args); if (failure) throw new Error(failure); return response; } };
    const Component = load("src\\app\\integrations\\page.tsx", {
      "./operational-ui": mock,
      react: { ...React, useEffect() {}, useRef: () => ({ current: null }), useState(initial) {
        const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = value; }];
      } },
    }).default;
    const render = () => { index = 0; return elements(Component()); };
    const sourceNodes = () => elements(render().find(node => node.props?.id === "integration-sources"));
    const open = () => sourceNodes().find(node => node.type === "button" && node.props.children?.[1] === "Create source").props.onClick();
    const form = () => render().find(node => node.props?.["aria-label"] === "Create lead source");
    open();
    form().props.onInvalidCapture({ target: { name: "owner_id" } });
    assert.ok(sourceNodes().some(node => node.props?.children === "Select an active counselor in Assign new leads to."));
    failure = "A source with this name already exists.";
    await form().props.onSubmit({ preventDefault() {}, currentTarget: {} });
    assert.ok(form(), "failed creation retains entered form");
    assert.ok(sourceNodes().some(node => node.props?.children === failure));
    failure = "";
    await form().props.onSubmit({ preventDefault() {}, currentTarget: {} });
    assert.equal(requests.at(-1)[0], "/api/integrations/sources");
    assert.equal(requests.at(-1)[2].channel, "website");
    assert.equal(form(), undefined);
    const receipt = sourceNodes().find(node => node.props?.["aria-label"] === "Created source credentials");
    assert.ok(receipt);
    const fields = elements(receipt).filter(node => node.type === "input");
    assert.deepEqual(fields.map(node => node.props.value), ["created-source-id", "one-time-test-key"]);
    assert.ok(fields.every(node => node.props.readOnly));
    assert.equal(sourceNodes().find(node => node.type === "button" && node.props.children?.[1] === "Create source").props.disabled, true);
    const dismiss = () => sourceNodes().find(node => node.type === "button" && node.props.children === "I saved it — dismiss").props.onClick();
    dismiss();
    assert.ok(sourceNodes().some(node => node.props?.["aria-label"] === "Created source credentials"));
    global.confirm = () => true;
    dismiss();
    open();
    response = { id: "unexpected-no-key" };
    await form().props.onSubmit({ preventDefault() {}, currentTarget: {} });
    assert.ok(form());
    assert.ok(sourceNodes().some(node => node.type === "p" && typeof node.props.children === "string" && node.props.children.includes("did not return source credentials")));
  });
  for (const label of ["Zoom", "Razorpay", "SMTP", "Gmail mailbox", "Website / chatbot", "Facebook Lead Ads", "Admissions India", "Save credentials", "Send test email", "future sign-ins"]) assert.ok(html.includes(label), label);
  assert.match(html, /<input(?=[^>]*name="SMTP_PASSWORD")(?=[^>]*type="password")(?=[^>]*value="")[^>]*>/);
  assert.match(html, /Saved securely/);
  assert.match(html, /<select[^>]*name="SMTP_PORT"/);
  assert.match(html, /<select[^>]*name="SMTP_SECURE"/);
  assert.match(html, /Automatic \(based on port\)/);
  assert.match(html, /aria-describedby="help-SMTP_PASSWORD"/);
  assert.match(html, /id="help-SMTP_PASSWORD"/);
  assert.doesNotMatch(html, /<form[^>]*>[\s\S]*?integration-smtp-test[\s\S]*?<\/form>/);
});

test("integration credential actions preserve secrets, block draft testing and show failures without clearing input", async () => {
  const states = [], requests = [];
  let index = 0, failed = false, resets = 0, changes = 0;
  const react = { ...React, useEffect() {}, useRef: value => ({ current: value }),
    useState(initial) { const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = value; }]; } };
  const { IntegrationConnections } = load("src\\components\\integration-connections.tsx", {
    react,
    "@/app/integrations/operational-ui": { ...opMock, formValues: () => ({ SMTP_HOST: "smtp2.example.com", SMTP_PASSWORD: "" }),
      operationRequest: async (...args) => { requests.push(args); if (failed) throw new Error("Provider unavailable"); return { message: "Saved encrypted" }; } },
  });
  const render = () => { index = 0; return elements(IntegrationConnections({ integrations: operations["/api/integrations"].integrations, onChange: () => { changes++; } })); };
  const button = label => render().find(node => node.type === "button" && (node.props.children === label || node.props.children?.[0] === label));
  button("Configure").props.onClick();
  assert.ok(render().some(node => node.props?.["aria-label"] === "Zoom configuration"));
  button("SMTP").props.onClick();
  let form = render().find(node => node.type === "form");
  assert.ok(elements(form).find(node => node.props?.name === "SMTP_PASSWORD").props.defaultValue === "");
  form.props.onChange();
  assert.equal(button("Test saved connection").props.disabled, true);
  const event = { preventDefault() {}, currentTarget: { reset() { resets++; } } };
  await form.props.onSubmit(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests[0][2].values.SMTP_PASSWORD, "");
  assert.equal(requests[0][2].revision, integrationSettings[0].revision);
  assert.equal(resets, 1);
  assert.equal(changes, 1);
  assert.equal(button("Test saved connection").props.disabled, false);
  await button("Test saved connection").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.at(-1)[2].action, "test");
  assert.equal(requests.at(-1)[2].values, undefined);
  failed = true;
  form = render().find(node => node.type === "form");
  form.props.onChange();
  form.props.onSubmit(event);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resets, 1);
  assert.ok(render().some(node => node.props?.error === "Provider unavailable"));
  assert.equal(button("Test saved connection").props.disabled, true);
});

test("read-only integration viewers receive setup guidance without credential forms", () => {
  const { IntegrationConnections } = load("src\\components\\integration-connections.tsx", {
    react: hookStates(["gmail"]),
    "@/app/integrations/operational-ui": { ...opMock, useOperationalData: () => operational({ canManage: false, settings: [], appUrl: "https://crm.example" }) },
  });

  const html = renderToStaticMarkup(React.createElement(IntegrationConnections, { integrations: [], onChange() {} }));
  assert.match(html, /Only an Admin or Super Admin/);
  assert.match(html, /Setup guide/);
  assert.doesNotMatch(html, /<form|name="GOOGLE_CLIENT_SECRET"/);
});

test("Facebook form creation distinguishes Page fallback from exact form routing and masks Page tokens", async () => {
  const html = await renderPage("src\\app\\integrations\\page.tsx", {
    states: [true, "facebook", "", "stage-1", "", "", null, false, "", null, null, "", null, false, "", "", false, "", "", "All integrations", ""],
    overrides: { "./operational-ui": opMock, "@/app/integrations/operational-ui": opMock },
  });
  for (const name of ["facebook_page_id", "facebook_form_id", "access_token", "owner_id"]) assert.ok(html.includes(`name="${name}"`), name);
  for (const text of ["One Page-wide fallback is allowed", "Token saved securely", "Replace token", "Check forms &amp; subscription", "not your Meta App ID"]) assert.ok(html.includes(text), text);
});

test("integration catalog searches, filters, restores selection and confirms unsaved navigation", t => {
  const previous = global.confirm;
  t.after(() => { if (previous === undefined) delete global.confirm; else global.confirm = previous; });
  const states = [];
  let index = 0, confirmations = 0, discard = false;
  global.confirm = () => { confirmations++; return discard; };
  const { IntegrationConnections } = load("src\\components\\integration-connections.tsx", {
    react: { ...React, useEffect() {}, useRef: () => ({ current: null }), useState(initial) {
      const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = value; }];
    } },
    "@/app/integrations/operational-ui": opMock,
  });
  const render = () => { index = 0; return elements(IntegrationConnections({ integrations: operations["/api/integrations"].integrations, onChange() {} })); };
  const cards = () => render().filter(node => node.props?.className?.includes("panel integration-card"));
  const click = text => render().find(node => node.type === "button" && node.props.children === text).props.onClick();
  const search = value => render().find(node => node.props?.["aria-label"] === "Search integrations").props.onChange({ target: { value } });
  assert.equal(cards().length, 6);
  click("Email");
  assert.equal(cards().length, 2);
  search("  GMAIL ");
  assert.equal(cards().length, 1);
  search("not-a-provider");
  assert.equal(cards().length, 0);
  assert.ok(render().some(node => node.props?.role === "status"));
  search("");
  click("All integrations");
  const card = cards().find(node => node.props.className.includes("integration-provider-intake"));
  elements(card).find(node => node.type === "button").props.onClick();
  assert.equal(cards().length, 0, "setup replaces the catalog rather than appending below it");
  render().find(node => node.type === "form").props.onChange();
  click("SMTP");
  assert.ok(render().some(node => node.props?.["aria-label"] === "Website / chatbot configuration"));
  assert.equal(confirmations, 1);
  discard = true;
  click("SMTP");
  assert.ok(render().some(node => node.props?.["aria-label"] === "SMTP configuration"));
  render().find(node => node.props?.["aria-label"] === "Close integration settings").props.onClick();
  assert.equal(cards().length, 6);
});

test("every provider has actionable setup, field guidance, verification and troubleshooting", () => {
  const { integrationGuides, integrationFieldHelp } = load("src\\lib\\integration-guides.ts");
  const { IntegrationSetupGuide } = load("src\\components\\integration-setup-guide.tsx");
  for (const provider of integrationDefinitions) {
    const guide = integrationGuides[provider.id];
    assert.ok(guide.needs.length >= 3);
    assert.ok(guide.steps.length >= 3);
    assert.ok(guide.problems.length >= 2);
    assert.ok(guide.docs.url.startsWith("https://"));
    for (const field of provider.fields) assert.ok(integrationFieldHelp[field.key], field.key);
    const html = renderToStaticMarkup(React.createElement(IntegrationSetupGuide, { provider: provider.id, appUrl: "https://crm.example" }));
    for (const title of ["What you will need", "Verify the complete workflow", "Troubleshooting"]) assert.ok(html.includes(title), `${provider.id}: ${title}`);
  }
});

test("website developer handoff signs the exact posted JSON and preserves the enquiry ID", async () => {
  const { IntakeDeveloperHandoff } = load("src\\components\\integration-setup-guide.tsx");
  const codeNode = elements(IntakeDeveloperHandoff({ appUrl: "https://crm.example" })).find(node => node.type === "code" && typeof node.props.children === "string" && node.props.children.startsWith("// Server-side"));
  assert.ok(codeNode);
  const script = ts.transpileModule(codeNode.props.children, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  const env = { CRM_BASE_URL: "https://crm.example", CRM_SOURCE_ID: "source-id", CRM_SOURCE_API_KEY: "source-key", CRM_INTAKE_SIGNING_KEY: "test-signing-key" };
  const submission = { id: "persisted-submission-1", name: "Visitor", phone: "+919876543210", email: "visitor@example.com" };
  const requests = [];
  const execute = response => new Function("exports", "require", "process", "submission", "fetch", `return (async () => {${script}})();`)({}, require, { env }, submission, async (url, init) => { requests.push({ url, init }); return response; });
  await execute({ ok: true, status: 200 });
  const { url, init } = requests[0];
  assert.equal(url, "https://crm.example/api/webhooks/lead-intake");
  assert.equal(init.headers.Authorization, "Bearer source-key");
  assert.equal(init.headers["x-crm-source"], env.CRM_SOURCE_ID);
  const expected = require("node:crypto").createHmac("sha256", env.CRM_INTAKE_SIGNING_KEY).update(init.headers["x-crm-timestamp"] + "." + init.body).digest("hex");
  assert.equal(init.headers["x-crm-signature"], `v1=${expected}`);
  assert.equal(JSON.parse(init.body).event_id, submission.id);
  await assert.rejects(execute({ ok: false, status: 503 }), /HTTP 503/);
  assert.equal(JSON.parse(requests[1].init.body).event_id, submission.id);
});

test("New lead uses a separate route and preserves creation permissions", async () => {
  const list = await renderPage("src\\app\\leads\\page.tsx", { overrides: { "@/lib/live-leads-client": liveMock } });
  assert.match(list, /href="\/leads\/new"[^>]*>[\s\S]*?New lead/);
  assert.doesNotMatch(list, /Cancel new lead|<h2>Create lead<\/h2>/);
  const form = await renderPage("src\\app\\leads\\new\\page.tsx", { overrides: { "@/lib/live-leads-client": liveMock } });
  assert.doesNotMatch(form, /Lead information|Enter the contact and admission details/);
  assert.match(form, /Preferred campus/);
  assert.match(form, /Choose preferred campus/);
  assert.match(form, /Counselor note/);
  assert.match(form, /Create lead/);
  assert.match(form, /Back to leads/);
  assert.doesNotMatch(form, /class="data-table"/);
  const denied = await renderPage("src\\app\\leads\\new\\page.tsx", { overrides: {
    "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: { ...live, user: { ...user, permissions: ["leads.view"] } }, loading: false, error: "", setError() {} }) },
  } });
  assert.match(denied, /You do not have permission to create leads/);
  assert.doesNotMatch(denied, /class="live-lead-form"/);
});

test("dedicated lead creation saves, confirms duplicates and surfaces failures", async (t) => {
  const previousConfirm = global.confirm;
  t.after(() => { if (previousConfirm === undefined) delete global.confirm; else global.confirm = previousConfirm; });
  const states = [], refs = [], requests = [], routes = [];
  let index = 0, refIndex = 0, error = "", respond;
  const Component = load("src\\app\\leads\\new\\page.tsx", {
    "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: live, error, loading: false, setError(value) { error = value; } }) },
    "@/lib/crm-data": { ...crm, apiRequest: async (...args) => { requests.push(args); return respond(); } },
    "next/navigation": { useRouter: () => ({ push: route => routes.push(route) }) },
    react: { ...React, useMemo: fn => fn(), useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
      useState(initial) { const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = value; }]; } },
  }).default;
  const render = () => { index = 0; refIndex = 0; return elements(Component()); };
  const form = () => render().find(node => node.type === actualLeads.LeadForm);
  assert.equal(form().props.initial.assigneeId, user.id);
  assert.equal(form().props.initial.stageId, stages[0].id);
  assert.equal(form().props.canAssign, true);
  const draft = actualLeads.leadDraft(lead);
  let finish;
  respond = () => new Promise(resolve => { finish = resolve; });
  const save = form().props.onSave(draft);
  assert.equal(form().props.busy, true);
  await form().props.onSave(draft);
  assert.equal(requests.length, 1);
  finish({ id: "created-id" });
  await save;
  assert.deepEqual(routes, ["/leads/created-id"]);
  respond = () => { throw new Error("Database unavailable"); };
  await form().props.onSave(draft);
  assert.equal(error, "Database unavailable");
  assert.equal(routes.length, 1);
  global.confirm = () => false;
  respond = () => { throw new Error("Duplicate warning: matching phone"); };
  const before = requests.length;
  await form().props.onSave(draft);
  assert.equal(requests.length, before + 1);
  assert.equal(form().props.busy, false);
  global.confirm = () => true;
  respond = () => { if (!requests.at(-1)[1].body.duplicateOverride) throw new Error("Duplicate warning: matching phone"); return { id: "duplicate-id" }; };
  await form().props.onSave(draft);
  assert.equal(requests.at(-1)[1].body.duplicateOverride, true);
  assert.equal(routes.at(-1), "/leads/duplicate-id");
});

test("organized Leads workspace retains permissions and selection actions", async () => {
  const readonly = { ...live, user: { ...user, profile: { ...profile, role: "counselor" }, permissions: ["leads.view"] } };
  const html = await renderPage("src\\app\\leads\\page.tsx", {
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data: readonly, loading: false, error: "", reload() {}, setError() {} }) } },
  });
  const header = html.match(/<header class="page-heading leads-heading"[\s\S]*?<\/header>/)?.[0];
  assert.ok(header);
  assert.doesNotMatch(header, /Export CSV|New lead|Import CSV|Refresh/);
  assert.match(html, /aria-label="Lead results"/);
  assert.match(html, /Columns/);
  const selectedHtml = await renderPage("src\\app\\leads\\page.tsx", {
    states: [filter, "", [lead.id], false, "", "", "", 0, null, false],
    overrides: { "@/lib/live-leads-client": liveMock },
  });
  assert.match(selectedHtml, /class="lead-bulk-actions"/);
  for (const label of ["1 selected", "Transfer", "Update status", "Delete"]) assert.ok(selectedHtml.includes(label), label);
});

test("selected lead actions respect roles even when a counselor has assignment and delete overrides", async () => {
  for (const role of ["counselor", "team_lead", "manager", "admin", "super_admin"]) {
    const data = { ...live, user: { ...user, profile: { ...profile, role } } };
    const html = await renderPage("src\\app\\leads\\page.tsx", {
      states: [filter, "", [lead.id], false, "", "", "", 0, null, false],
      overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
    });
    const bar = html.match(/<section class="lead-bulk-actions"[\s\S]*?<\/section>/)[0];
    assert.match(bar, /class="lead-bulk-buttons"/);
    assert.match(bar, />Update status<\/button>/);
    assert.equal(bar.includes(">Transfer</button>"), role !== "counselor", role);
    assert.equal(bar.includes(">Delete</button>"), ["admin", "super_admin"].includes(role), role);
    assert.doesNotMatch(bar, /<select|searchable-dropdown/);
  }
  const css = readFileSync(path.join(root, "src", "app", "leads", "leads.css"), "utf8");
  assert.match(css, /\.lead-bulk-buttons \{[^}]*justify-content: flex-end;[^}]*margin-left: auto;/);
});

test("transfer dialog requires an assignee and defaults to keeping every lead's current stage", async () => {
  const html = await renderPage("src\\app\\leads\\page.tsx", {
    states: [filter, "", [lead.id], false, "", "", "", 0, null, false, "", null, false, "", false, [null], "transfer"],
    overrides: { "@/lib/live-leads-client": liveMock },
  });
  assert.match(html, /aria-label="Transfer assignee"/);
  assert.match(html, /aria-label="Bulk stage"/);
  assert.match(html, /Keep current stage/);
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /disabled="">Confirm transfer<\/button>/);
});

test("bulk transfer sends assignee with an optional stage in one PATCH and retains failed selections", async () => {
  for (const stageId of ["", stages[1].id]) {
    const states = [filter, "", [lead.id, "lead-2"], false, "", "", "", 0, null, false, "", null, false, "", false, [null], null];
    const refs = [];
    let index = 0, refIndex = 0, error = "";
    const requests = [];
    const data = { ...live, leads: [lead, { ...lead, id: "lead-2", stageId: stages[2].id }] };
    const Component = load("src\\app\\leads\\page.tsx", {
      react: { ...React, useEffect() {}, useLayoutEffect() {},
        useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
        useState(initial) { const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }]; },
      },
      "@/lib/crm-data": { ...crm, apiRequest: async (url, options) => {
        requests.push({ url, ...options });
        if (url.endsWith("lead-2")) throw new Error("Transfer denied");
        return {};
      } },
      "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, error, loading: false, reload: async () => {}, setError: value => { error = value; } }) },
    }).default;
    const render = () => { index = 0; refIndex = 0; return elements(Component()); };
    render().find(node => node.type === "button" && node.props["aria-label"] === "Transfer").props.onClick();
    assert.equal(states[16], "transfer");
    const selects = render();
    const assignee = selects.find(node => node.props?.ariaLabel === "Transfer assignee");
    const stage = selects.find(node => node.props?.ariaLabel === "Bulk stage");
    assert.equal(assignee.props.required, true);
    assert.equal(stage.props.optionsMaxHeight, 176);
    assert.deepEqual(stage.props.options, [{ value: "", label: "Keep current stage" }, ...stages.map(item => ({ value: item.id, label: item.name }))]);
    assignee.props.onChange(profile.id);
    stage.props.onChange(stageId);
    render().find(node => node.type === "form" && node.props.onSubmit).props.onSubmit({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, "PATCH");
    assert.deepEqual(requests[0].body, { assigneeId: profile.id, ...(stageId ? { stageId } : {}) });
    assert.deepEqual(states[2], ["lead-2"]);
    assert.match(error, /1 of 2 leads updated.*Transfer denied/);
  }
});

test("searchable dropdown portals into its dialog and supports filtering, scroll limits and selection", t => {
  const previousDocument = global.document;
  const dialog = {};
  const body = {};
  global.document = { body };
  t.after(() => { if (previousDocument === undefined) delete global.document; else global.document = previousDocument; });
  const options = Array.from({ length: 30 }, (_, index) => ({ value: String(index), label: `Counselor ${String(index).padStart(2, "0")}` }));
  const states = [true, "", { left: 10, top: 10, width: 300, maxHeight: 240 }];
  let stateIndex = 0, refIndex = 0, target, selected;
  const refs = [{ current: { closest: selector => { assert.equal(selector, "dialog"); return dialog; } } }, { current: { focus() {} } }];
  const { SearchableDropdown } = load("src\\components\\searchable-dropdown.tsx", {
    react: { ...React, useEffect() {}, useLayoutEffect() {}, useId: () => "test-options",
      useState(initial) { const key = stateIndex++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = value; }]; },
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
    },
    "react-dom": { createPortal(content, container) { target = container; return content; } },
  });
  const render = () => { stateIndex = 0; refIndex = 0; return elements(SearchableDropdown({ ariaLabel: "Transfer assignee", placeholder: "Choose assignee", options, value: "", onChange: value => { selected = value; }, optionsMaxHeight: 176 })); };
  let nodes = render();
  assert.equal(target, dialog);
  assert.equal(nodes.filter(node => node.props?.role === "option").length, 30);
  assert.equal(nodes.find(node => node.props?.role === "listbox").props.style.maxHeight, 176);
  nodes.find(node => node.type === "input" && node.props.type === "search").props.onChange({ target: { value: "Counselor 29" } });
  nodes = render();
  assert.equal(nodes.filter(node => node.props?.role === "option").length, 1);
  nodes.find(node => node.props?.role === "option").props.onClick();
  assert.equal(selected, "29");
  assert.equal(states[0], false);
  states[0] = true; states[1] = "no match";
  assert.ok(render().some(node => node.props?.children === "No matching options"));
  refs[0].current.closest = () => null;
  render();
  assert.equal(target, body);
});

test("lead columns float without layout shifts and save each checkbox change automatically", async (t) => {
  const states = [];
  const refs = [];
  let index = 0;
  let refIndex = 0;
  const requests = [];
  let finishSave;
  let failSave;
  const previousDocument = global.document;
  global.document = { body: {} };
  t.after(() => {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  });
  const Component = load("src\\app\\leads\\page.tsx", {
    "@/lib/live-leads-client": liveMock,
    "react-dom": { createPortal: (content) => content },
    "@/lib/crm-data": { ...crm, apiRequest: (...args) => {
      requests.push(args);
      return new Promise((resolve, reject) => { finishSave = resolve; failSave = reject; });
    } },
    react: {
      ...React,
      useEffect() {},
      useLayoutEffect() {},
      useRef(initial) {
        const key = refIndex++;
        if (!(key in refs)) refs[key] = { current: initial };
        return refs[key];
      },
      useMemo: (factory) => factory(),
      useState(initial) {
        const key = index++;
        if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
        return [states[key], (value) => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
      },
    },
  }).default;
  const render = () => { index = 0; refIndex = 0; return elements(Component()); };
  const toggle = () => render().find((node) => node.type === "button" && Array.isArray(node.props.children) && node.props.children.includes("Columns"));
  const search = (value) => render().find((node) => node.props?.["aria-label"] === "Search columns").props.onChange({ target: { value } });
  const options = () => render().filter((node) => node.props?.className === "lead-column-option");

  toggle().props.onClick();
  assert.equal(options().length, 16);
  search("  EMAIL ");
  assert.equal(options().length, 1);
  assert.equal(options()[0].props.children[1].props.children, "Email");
  options()[0].props.children[0].props.onChange({ target: { checked: true } });
  assert.equal(requests.length, 1);
  assert.ok(requests[0][1].body.columns.includes("email"));
  assert.ok(options().every((node) => node.props.children[0].props.disabled));
  options()[0].props.children[0].props.onChange({ target: { checked: true } });
  assert.equal(requests.length, 1, "concurrent checkbox saves must not overwrite each other");
  finishSave({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(options()[0].props.children[0].props.checked, true);
  search("phone");
  options()[0].props.children[0].props.onChange({ target: { checked: false } });
  assert.ok(!requests[1][1].body.columns.includes("phone"));
  assert.ok(requests[1][1].body.columns.includes("email"));
  finishSave({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(options()[0].props.children[0].props.checked, false);
  search("email");
  assert.equal(options()[0].props.children[0].props.checked, true);
  search("does not exist");
  assert.equal(options().length, 0);
  assert.ok(render().some((node) => node.props?.role === "status" && node.props.children === "No columns match your search."));
  search("");
  assert.equal(options().length, 16);
  assert.ok(!render().some((node) => node.type === "button" && ["Cancel", "Save columns"].includes(node.props.children)));
  search("email");
  options()[0].props.children[0].props.onChange({ target: { checked: false } });
  failSave(new Error("Preference save failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(options()[0].props.children[0].props.checked, true);
  assert.ok(render().some((node) => node.props?.role === "alert" && node.props.children === "Preference save failed"));
  assert.equal(options()[0].props.children[0].props.disabled, false);
  toggle().props.onClick();
  toggle().props.onClick();
  assert.equal(options().length, 16);
  assert.equal(options().find((node) => node.props.children[1].props.children === "Email").props.children[0].props.checked, true);

  for (const option of options()) {
    const input = option.props.children[0];
    if (input.props.checked && option.props.children[1].props.children !== "Lead name") {
      const label = option.props.children[1].props.children;
      search(label);
      options().find((node) => node.props.children[1].props.children === label).props.children[0].props.onChange({ target: { checked: false } });
      finishSave({});
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  search("Lead name");
  assert.equal(options()[0].props.children[0].props.disabled, true);
  const requestCount = requests.length;
  options()[0].props.children[0].props.onChange({ target: { checked: false } });
  assert.equal(requests.length, requestCount);
  assert.ok(render().some((node) => node.props?.role === "alert" && node.props.children === "Keep at least one column visible."));

  const css = readFileSync(path.join(root, "src", "app", "leads", "leads.css"), "utf8");
  assert.match(css, /\.lead-column-list \{[^}]*max-height: 140px;[^}]*overflow-y: auto/);
  assert.match(css, /\.lead-column-option \{[^}]*display: flex/);
  assert.match(css, /\.lead-column-options \{[^}]*position: fixed/);
});

test("live filter menus use real configuration, multi-select values and safe field changes", () => {
  let current = { ...filter, criteria: [{ id: "condition", field: "stage", operator: "is", value: "" }] };
  const render = () => elements(actualLeads.LiveFilterEditor({ filter: current, leads: [], stages, profiles: [profile], onChange: next => { current = next; } }));
  const menu = label => render().find(node => node.props?.ariaLabel === label);
  assert.deepEqual(menu("Filter value").props.options.map(option => option.label), stages.map(stage => stage.name).sort());
  menu("Filter value").props.onChange(stages[0].name);
  assert.equal(current.criteria[0].value, stages[0].name);
  menu("Filter operator").props.onChange("in");
  assert.equal(current.criteria[0].value, "");
  assert.equal(menu("Filter values").props.multiple, true);
  menu("Filter values").props.onChange(stages.slice(0, 2).map(stage => stage.name));
  assert.equal(current.criteria[0].value, stages.slice(0, 2).map(stage => stage.name).join("\n"));
  menu("Filter field").props.onChange("assignee");
  assert.equal(current.criteria[0].operator, "is");
  assert.equal(current.criteria[0].value, "");
  assert.ok(menu("Filter value").props.options.some(option => option.label === profile.fullName));
  menu("Filter field").props.onChange("createdAt");
  menu("Filter operator").props.onChange("between");
  assert.ok(render().some(node => node.props?.["aria-label"] === "Filter end date"));
  menu("Filter field").props.onChange("untouched");
  assert.equal(current.criteria[0].operator, "is_true");
  assert.equal(menu("Filter value"), undefined);
  const before = current;
  menu("Filter field").props.onChange("not-a-field");
  assert.equal(current, before);
  render().find(node => node.props?.["aria-label"] === "Remove condition").props.onClick();
  assert.equal(current.criteria.length, 0);
});

test("every filter field and operator remains available through searchable menus", () => {
  const filters = load("src\\lib\\lead-filters.ts");
  for (const field of filters.FILTER_FIELDS) {
    const criterion = { id: "criterion", field: field.key, operator: filters.defaultOperator(field.key), value: "" };
    const nodes = elements(actualLeads.LiveFilterEditor({ filter: { ...filter, criteria: [criterion] }, leads: [lead], onChange() {} }));
    assert.equal(nodes.find(node => node.props?.ariaLabel === "Filter field").props.options.length, filters.FILTER_FIELDS.length);
    assert.deepEqual(nodes.find(node => node.props?.ariaLabel === "Filter operator").props.options, filters.operatorsForField(field.key));
  }
});

test("lead workspace keeps notes separate from overview and email history", async () => {
  const data = { ...live, lead, notes: [{ id: "note-1", content: "Actual saved consultation note", created_at: lead.createdAt, user_id: id }], activities: [], emails: [] };
  const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
    states: [false, false, "", "", "", "", false, [], "", "", "note"],
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
  });

  test("each section has an isolated Timeline tab for editors and read-only viewers", async () => {
    const data = { ...live, lead, notes: [{id:"note",content:"Unique saved note",created_at:lead.createdAt,user_id:id}],
      emails: [{id:"mail",subject:"Unique saved email",body:"Email body",status:"sent",direction:"outbound",from_email:"admin@example.com",to_email:lead.email,created_at:lead.createdAt,user_id:id}],
      scheduledCalls: manyScheduledCalls,
      activities: [
        {id:"call",type:"call",description:"Unique call event",created_at:lead.createdAt,user_id:id},
        {id:"change",type:"updated",description:"Unique lead edit",created_at:lead.createdAt,user_id:id},
      ],
    };
    for (const readOnly of [false,true]) {
      for (const [section,label,event,others] of [
        ["overview","Overview","Unique lead edit",["Unique call event","Unique saved note","Unique saved email"]],
        ["note","Notes","Unique saved note",["Unique call event","Unique lead edit","Unique saved email"]],
        ["email","Emails","Unique saved email",["Unique call event","Unique lead edit","Unique saved note"]],
        ["calls","Calls","Unique call event",["Unique lead edit","Unique saved note","Unique saved email"]],
      ]) {
        const html = await renderPage("src\\app\\leads\\[id]\\page.tsx",{
          states:[false,false,"draft note","draft email","draft subject","",false,false,"","",section,false,"","",false,Date.now(),"","timeline"],
          overrides:{"@/lib/live-leads-client":{...liveMock,useLiveLeadData:()=>({data:{...data,user:readOnly?{...user,permissions:["leads.view"]}:user},loading:false,error:"",reload(){},setError(){}})}},
        });
        assert.match(html,new RegExp(`role="tablist" aria-label="${label} views"`));
        assert.ok(html.includes(event),`${section}: ${event}`);
        for (const other of others) assert.ok(!html.includes(other),`${section} must not show ${other}`);
        assert.doesNotMatch(html,/<textarea|class="lead-calls-scroll"|Lead information|Compose email|Add a note/);
        assert.match(html,/dateTime="2026-10-21T09:00:00Z"/);
        assert.match(html,/Admissions Administrator/);
      }
    }
  });

  test("Notes, Emails and Calls Timeline switching preserves drafts and resets on left navigation", () => {
    const states = [],refs=[];
    let index=0,refIndex=0;
    const data={...live,lead,notes:[],emails:[],activities:[],scheduledCalls:[]};
    const Component=load("src\\app\\leads\\[id]\\page.tsx",{
      react:{...React,useEffect(){},useRef(initial){const key=refIndex++;return refs[key]??(refs[key]={current:initial});},
        useState(initial){const key=index++;if(!(key in states))states[key]=typeof initial==="function"?initial():initial;return[states[key],value=>{states[key]=value;}];}},
      "@/lib/crm-data":crm,
      "@/lib/live-leads-client":{...liveMock,useLiveLeadData:()=>({data,loading:false,error:"",reload(){},setError(){}})},
    }).default;
    const render=()=>{index=0;refIndex=0;return Component();};
    const nodes=()=>elements(render());
    for(const [section,label] of [["note","Notes"],["email","Emails"],["calls","Calls"]]){
      nodes().find(node=>node.props?.id===`lead-section-${section}`).props.onClick();
      assert.match(renderToStaticMarkup(render()),new RegExp(`${label} views`));
      if(section!=="calls"){
        nodes().find(node=>node.type==="textarea").props.onChange({target:{value:`${section} draft`}});
      }
      nodes().find(node=>node.props?.id===`lead-${section}-tab-timeline`).props.onClick();
      assert.match(renderToStaticMarkup(render()),new RegExp(`${section==="email"?"Email":label} timeline`));
      assert.doesNotMatch(renderToStaticMarkup(render()),/<textarea/);
      let focused="";
      nodes().find(node=>node.props?.role==="tablist").props.onKeyDown({key:"Home",preventDefault(){},currentTarget:{querySelector:selector=>({focus(){focused=selector;}})}});
      assert.equal(focused,`#lead-${section}-tab-overview`);
      if(section!=="calls")assert.equal(nodes().find(node=>node.type==="textarea").props.value,`${section} draft`);
    }
    assert.equal(states[2],"note draft");
    assert.equal(states[3],"email draft");
  });
  assert.doesNotMatch(html, /Actual saved consultation note/);
  assert.match(html, /Add a note/);
  assert.match(html, /Add note/);
  assert.doesNotMatch(html, /Notes timeline/);
  assert.doesNotMatch(html, /Overview timeline|Email timeline|Edit lead|SMTP account/);
  assert.doesNotMatch(html, /No records yet/);
});

test("lead overview exposes inline fields with no separate edit or save button", async () => {
  const data = { ...live, lead, notes: [], activities: [{ id: "change-1", description: "Lead stage changed", type: "updated", created_at: lead.createdAt, user_id: id }], emails: [], mailbox: null };
  const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
  });

  test("Overview Timeline tab clearly shows actor and field changes without showing lead fields", async () => {
    const data = { ...live, lead, notes: [], emails: [], activities: [{ id: "audit", type: "updated", description: "Lead details updated", user_id: id, created_at: lead.createdAt, meta: { actor_name: "Original counselor", changes: { course: { before: "Old course", after: "New course" }, stage_id: { before: stages[0].id, after: stages[1].id }, custom_fields: { before: { Campus: "Delhi" }, after: { Campus: "Dubai" } } } } }] };
    const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", { states: [false,false,"","","","",false,false,"","","overview",false,"","",false,Date.now(),"","timeline"], overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } } });
    assert.match(html,/role="tablist" aria-label="Overview views"/);
    assert.doesNotMatch(html,/aria-label="Lead name"|Lead information/);
    assert.match(html,/aria-label="Lead sections"/);
    for (const text of ["Overview timeline","Original counselor","Old course","New course","Delhi","Dubai",stages[0].name,stages[1].name]) assert.ok(html.includes(text), text);
    assert.match(html,/dateTime="2026-10-21T09:00:00Z"/);
  });

  test("locked call workflow disables new scheduling but provides real call change actions and a call timeline", async () => {
    const data = { ...live, lead, canScheduleCall: false, scheduledCalls: [manyScheduledCalls[0]], notes: [], emails: [], activities: [] };
    const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
      states: [false,false,"","","","",false,false,"","","calls"],
      overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
    });
    assert.match(html,/disabled=""[^>]*><svg[\s\S]*?Schedule a call/);
    assert.match(html,/Update a lead field/);
    assert.match(html,/Reschedule/);
    assert.match(html,/>Complete<\/button>/);
    assert.match(html,/>Cancel call<\/button>/);
    assert.doesNotMatch(html,/Calls timeline/);
  });
  assert.match(html, /Autosave enabled/);
  assert.match(html, /aria-label="Lead name"/);
  assert.match(html, /role="tablist" aria-label="Overview views"/);
  assert.doesNotMatch(html, /Overview timeline|Lead stage changed/);
  assert.doesNotMatch(html, /Edit lead|Save lead|Notes timeline|Email timeline/);
  assert.doesNotMatch(html, /Send email|Archive lead|>Refresh<|Merge duplicates|View duplicates/);
});

test("Overview local tabs switch independently, support keyboard and reset from left navigation", () => {
  const states = [], refs = [];
  let index = 0, refIndex = 0;
  const data = { ...live, lead, notes: [], emails: [], activities: [{id:"change",type:"updated",description:"Unique change",created_at:lead.createdAt,user_id:id}] };
  const Component = load("src\\app\\leads\\[id]\\page.tsx", {
    react: { ...React, useEffect() {},
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = {current:initial}); },
      useState(initial) { const key = index++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key], value => { states[key] = value; }]; },
    },
    "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({data,loading:false,error:"",reload() {},setError() {}}) },
  }).default;
  const render = () => {index=0;refIndex=0;return Component();};
  let tree = render();
  assert.doesNotMatch(renderToStaticMarkup(tree),/Unique change|Overview timeline/);
  elements(tree).find(node => node.props?.id === "lead-overview-tab-timeline").props.onClick();
  tree = render();
  assert.match(renderToStaticMarkup(tree),/Unique change/);
  assert.doesNotMatch(renderToStaticMarkup(tree),/Lead information|aria-label="Lead name"/);
  let focused = "";
  const key = value => elements(render()).find(node => node.props?.role === "tablist").props.onKeyDown({key:value,preventDefault(){},currentTarget:{querySelector: selector => ({focus(){focused=selector;}})}});
  key("Home");
  assert.equal(focused,"#lead-overview-tab-overview");
  assert.match(renderToStaticMarkup(render()),/Lead information/);
  key("ArrowRight");
  assert.match(renderToStaticMarkup(render()),/Unique change/);
  elements(render()).find(node => node.props?.id === "lead-section-note").props.onClick();
  assert.match(renderToStaticMarkup(render()),/Notes views/);
  elements(render()).find(node => node.props?.id === "lead-section-overview").props.onClick();
  assert.match(renderToStaticMarkup(render()),/Lead information/);
  assert.doesNotMatch(renderToStaticMarkup(render()),/Unique change/);
});

test("duplicate actions show only matching owners, with merge enabled only for server-approved bucket destinations", async () => {
  for (const eligible of [false,true]) {
    const data = { ...live, lead, notes: [], activities: [], emails: [], duplicates: [
      { assignee: "Outside counselor", merge_target_id: null },
      ...(eligible ? [{ assignee: "Inside counselor", merge_target_id: "inside-lead" }] : []),
    ] };
    const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
      states: [false,false,"","","","",true,true,"","","overview"],
      overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
    });
    assert.match(html,/View duplicates/);
    assert.match(html,/Outside counselor/);
    assert.doesNotMatch(html,/href="\/leads\/(?:inside|outside)-lead"|Archive lead|>Refresh<|Send email/);
    if (eligible) {
      assert.match(html,/Inside counselor/);
      assert.match(html,/Select for merge/);
    } else {
      assert.match(html,/disabled="" title="Both leads must be within your merge bucket/);
      assert.doesNotMatch(html,/Select for merge|Confirm merge/);
    }
  }
});

test("view-only users can reveal cross-bucket assignee names but cannot merge", async () => {
  const data = { ...live, user: { ...user, permissions: ["leads.view"] }, lead, notes: [], activities: [], emails: [], duplicates: [{ assignee: "Another team counselor", merge_target_id: null }] };
  const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
    states: [false,false,"","","","",false,true,"","","overview"],
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
  });
  assert.match(html,/Another team counselor/);
  assert.match(html,/View duplicates/);
  assert.match(html,/disabled="" title="Both leads/);
  assert.doesNotMatch(html,/Select for merge|Confirm merge/);
});

test("duplicate View reveals owners without a broad lead fetch and merges only the selected approved destination", async () => {
  const states = [false,false,"","","","",false,false,"","","overview"];
  const refs = [], requests = [], navigations = [];
  let index = 0, refIndex = 0;
  const previousConfirm = global.confirm;
  global.confirm = () => true;
  try {
    const data = { ...live, lead, notes: [], activities: [], emails: [], duplicates: [{ assignee: "Bucket counselor", merge_target_id: "approved-destination" }, { assignee: "Outside team", merge_target_id: null }] };
    const Component = load("src\\app\\leads\\[id]\\page.tsx", {
      react: { ...React, useEffect() {},
        useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
        useState(initial) { const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }]; },
      },
      "next/navigation": { useParams: () => ({ id: lead.id }), useRouter: () => ({ push: value => navigations.push(value) }) },
      "@/lib/crm-data": { ...crm, apiRequest: async (url, options) => { requests.push({ url, ...options }); return { id: "approved-destination" }; } },
      "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, error: "", loading: false, reload: async () => {}, setError() {} }) },
    }).default;
    const render = () => { index = 0; refIndex = 0; return elements(Component()); };
    const button = text => render().find(node => node.type === "button" && (node.props.children === text || (Array.isArray(node.props.children) && node.props.children.includes(text))));
    render().find(node => node.type === "button" && node.props["aria-controls"] === "lead-duplicate-owners").props.onClick();
    assert.equal(states[7],true);
    assert.equal(requests.length,0);
    button("Merge duplicates").props.onClick();
    const choices = render().filter(node => node.type === "button" && node.props.children === "Select for merge");
    assert.equal(choices.length,1);
    choices[0].props.onClick();
    assert.equal(states[8],"approved-destination");
    button("Confirm merge").props.onClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests,[{ url: `/api/leads/${lead.id}/merge`, body: { targetId: "approved-destination" } }]);
    assert.deepEqual(navigations,["/leads/approved-destination"]);
  } finally {
    if (previousConfirm === undefined) delete global.confirm; else global.confirm = previousConfirm;
  }
});

test("lead detail offers safe phone actions and displays saved call appointments", async () => {
  const data = { ...live, lead, notes: [], activities: [], emails: [], scheduledCalls: [
    { id: "future-call", user_id: id, scheduled_at: "2099-12-01T10:00:00Z", status: "scheduled" },
    { id: "past-call", user_id: id, scheduled_at: "2020-01-01T10:00:00Z", status: "scheduled" },
    { id: "cancelled-call", user_id: id, scheduled_at: "2098-12-01T10:00:00Z", status: "cancelled" },
  ] };
  const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
  });
  assert.match(html, /href="tel:\+919876543210"/);
  assert.match(html, /Click to call/);
  assert.match(html, /Schedule a call/);
  assert.match(html, /Next scheduled call/);
  assert.match(html, /1 past due/);
  assert.match(html, /2099/);
  assert.doesNotMatch(html, /2098/);
});

test("many appointments keep the overview compact and all calls appear sorted in the Calls workspace", async () => {
  const data = { ...live, lead, notes: [], activities: [], emails: [], scheduledCalls: [...manyScheduledCalls].reverse() };
  const options = { overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } } };
  const overview = await renderPage("src\\app\\leads\\[id]\\page.tsx", options);
  assert.equal((overview.match(/class="panel lead-call-summary"/g) ?? []).length,1);
  const summary = overview.match(/<section class="panel lead-call-summary"[\s\S]*?<\/section>/)[0];
  assert.equal((summary.match(/<time /g) ?? []).length,1);
  assert.match(summary,/20 upcoming/);
  assert.match(summary,/10 past due/);
  assert.match(summary,/View all calls \(30\)/);
  assert.match(summary,/dateTime="2099-12-01T10:00:00.000Z"/);
  assert.doesNotMatch(overview,/class="lead-call-row"|class="lead-call-card"/);
  const calls = await renderPage("src\\app\\leads\\[id]\\page.tsx", { ...options, states: [false,false,"","","","",false,false,"","","calls"] });
  assert.equal((calls.match(/class="lead-call-row"/g) ?? []).length,30);
  assert.match(calls,/aria-label="Upcoming calls"/);
  assert.match(calls,/aria-label="Past due calls"/);
  assert.ok(calls.indexOf('dateTime="2099-12-01T10:00:00.000Z"',calls.indexOf('aria-label="Upcoming calls"')) < calls.indexOf('dateTime="2099-12-20T10:00:00.000Z"'));
  assert.ok(calls.indexOf('dateTime="2020-12-30T10:00:00.000Z"') < calls.indexOf('dateTime="2020-12-21T10:00:00.000Z"'));
  assert.match(calls,/role="region" aria-label="Call appointments" tabindex="0"/);
  assert.doesNotMatch(calls,/Compose email|Add a note|<form/);
  const css = readFileSync(path.join(root,"src","app","leads","leads.css"),"utf8");
  assert.match(css,/\.lead-calls-scroll \{[^}]*max-height: 460px;[^}]*overflow-y: auto;/);
});

test("Calls empty and past-due-only states remain available without invented upcoming appointments", async () => {
  for (const readOnly of [false,true]) {
    for (const scheduledCalls of [[],[{ id: "past", user_id: id, scheduled_at: "2020-01-01T10:00:00Z", status: "scheduled" }]]) {
      const data = { ...live, user: readOnly ? { ...user, permissions: ["leads.view"] } : user, lead, notes: [], activities: [], emails: [], scheduledCalls };
      const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
        states: [false,false,"","","","",false,false,"","","calls"],
        overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
      });
      assert.match(html,/aria-current="page"[^>]*>[\s\S]*?Calls/);
      assert.match(html, scheduledCalls.length ? /No upcoming calls/ : /No calls scheduled yet/);
      if (readOnly) assert.doesNotMatch(html,/Schedule a call/);
      assert.doesNotMatch(html,/Compose email|Add a note/);
    }
  }
});

test("View all calls navigates to the Calls workspace and notification dismissal clears the message", () => {
  const states = [false,false,"","","","Call saved",false,false,"","","overview"];
  let index = 0;
  const data = { ...live, lead, notes: [], activities: [], emails: [], scheduledCalls: manyScheduledCalls };
  const Component = load("src\\app\\leads\\[id]\\page.tsx", {
    react: { ...React, useEffect() {}, useRef: initial => ({ current: initial }),
      useState(initial) { const key = index++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key],value => { states[key] = value; }]; },
    },
    "@/lib/crm-data": crm,
    "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) },
  }).default;
  const nodes = elements(Component());
  nodes.find(node => node.type === "button" && Array.isArray(node.props.children) && node.props.children[0] === "View all calls (").props.onClick();
  assert.equal(states[10],"calls");
  nodes.find(node => node.type === "button" && node.props["aria-label"] === "Dismiss notification").props.onClick();
  assert.equal(states[5],"");
});

test("due indicators update while the page stays open and the clock timer is cleaned up", () => {
  const previousWindow = global.window, originalNow = Date.now;
  const states = [], effects = [];
  let index = 0, tick, cleared = false, now = originalNow();
  Date.now = () => now;
  global.window = {
    setInterval(callback, delay) { assert.equal(delay,30000); tick = callback; return 17; },
    clearInterval(timer) { assert.equal(timer,17); cleared = true; },
  };
  try {
    const data = { ...live, lead, notes: [], activities: [], emails: [], scheduledCalls: [{ id: "due-soon", user_id: id, scheduled_at: new Date(now + 1000).toISOString(), status: "scheduled" }] };
    const Component = load("src\\app\\leads\\[id]\\page.tsx", {
      react: { ...React, useEffect: effect => effects.push(effect), useRef: initial => ({ current: initial }),
        useState(initial) { const key = index++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key],value => { states[key] = value; }]; },
      },
      "@/lib/crm-data": crm,
      "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) },
    }).default;
    const render = () => { index = 0; return renderToStaticMarkup(Component()); };
    assert.match(render(),/1 upcoming/);
    const cleanup = effects[0]();
    now += 30000; tick();
    const after = render();
    assert.match(after,/No upcoming calls/);
    assert.match(after,/1 past due/);
    cleanup();
    assert.equal(cleared,true);
  } finally {
    Date.now = originalNow;
    if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
  }
});

test("schedule dialog exposes required local date, ownership and honest reminder limitations", async () => {
  const data = { ...live, lead, notes: [], activities: [], emails: [] };
  const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
    states: [false, false, "", "", "", "", false, [], "", "", "overview", true, "2099-12-01T10:00", "Server rejected appointment.", false],
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
  });
  assert.match(html, /aria-labelledby="schedule-call-title"/);
  assert.match(html, /type="datetime-local" required/);
  assert.match(html, /Scheduled for you \(Admissions Administrator\)/);
  assert.match(html, /does not place an automatic call or send a reminder/);
  assert.match(html, /role="alert"[^>]*>Server rejected appointment/);
});

test("invalid phone disables dialing and lead viewers cannot call or schedule", async () => {
  for (const readOnly of [false, true]) {
    const data = { ...live, user: readOnly ? { ...user, permissions: ["leads.view"] } : user, lead: { ...lead, phone: "invalid-phone" }, notes: [], activities: [], emails: [] };
    const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
      overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
    });

    test("scheduling validates before posting, prevents duplicate submits and preserves errors for retry", async () => {
      for (const failure of [false, true]) {
        const states = [false, false, "", "", "", "", false, [], "", "", "overview", false, "", "", false];
        const refs = [], requests = [];
        let index = 0, refIndex = 0, reloads = 0, finishRequest;
        const data = { ...live, lead, notes: [], activities: [], emails: [] };
        const Component = load("src\\app\\leads\\[id]\\page.tsx", {
          react: { ...React, useEffect() {},
            useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
            useState(initial) { const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }]; },
          },
          "@/lib/crm-data": { ...crm, apiRequest: async (url, options) => {
            requests.push({ url, ...options });
            await new Promise(resolve => { finishRequest = resolve; });
            if (failure) throw new Error("Database unavailable. Retry later.");
          } },
          "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, error: "", loading: false, reload: async () => { reloads++; }, setError() {} }) },
        }).default;
        const render = () => { index = 0; refIndex = 0; return elements(Component()); };
        render().find(node => node.type === "button" && node.props.children?.includes("Schedule a call")).props.onClick();
        assert.equal(states[11], true);
        const submit = () => render().find(node => node.type === "dialog").props.children.props.onSubmit({ preventDefault() {} });
        submit();
        assert.equal(requests.length, 0);
        assert.match(states[13], /future date/);
        const local = "2099-12-01T10:00";
        render().find(node => node.type === "input" && node.props.type === "datetime-local" && node.props.required).props.onChange({ target: { value: local } });
        submit(); submit();
        assert.equal(requests.length, 1);
        assert.equal(states[14], true);
        assert.deepEqual(requests[0].body, { action: "schedule_call", scheduledAt: new Date(local).toISOString() });
        finishRequest();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(states[14], false);
        assert.equal(states[11], failure);
        assert.equal(reloads, failure ? 0 : 1);
        if (failure) { assert.match(states[13], /Database unavailable/); assert.equal(states[12], local); }
        else { assert.match(states[5], /Call scheduled for/); assert.equal(states[12], ""); }
      }
    });
    assert.doesNotMatch(html, /href="tel:/);
    if (readOnly) assert.doesNotMatch(html, /Click to call|Schedule a call/);
    else assert.match(html, /disabled="" title="Add a valid phone number/);
  }
});

test("leads table formats timestamp columns as readable dates and times, including the linked first column", async () => {
  const timestamp = "2026-10-22T12:42:20.169251+00:00";
  const formatDateTime = value => value ? new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";
  for (const columns of [["name", "createdAt", "modifiedAt", "lastVisitAt"], ["createdAt", "modifiedAt", "name", "lastVisitAt"]]) {
    const data = { ...live, columns, leads: [{ ...lead, createdAt: timestamp, modifiedAt: timestamp, lastVisitAt: undefined }] };
    const html = await renderPage("src\\app\\leads\\page.tsx", {
      overrides: {
        "@/lib/crm-data": { ...crm, formatDateTime },
        "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) },
      },
    });
    assert.ok(html.includes(formatDateTime(timestamp)));
    assert.doesNotMatch(html, /2026-10-22T12:42:20|169251|\+00:00/);
    assert.match(html, /<td>—<\/td>/);
    if (columns[0] === "createdAt") assert.ok(html.includes(`href="/leads/${lead.id}">${formatDateTime(timestamp)}</a>`));
  }
});

test("lead email composer displays the connected sender and separate email timeline", async () => {
  const data = { ...live, user: { ...user, email: "counselor@gmail.com" }, lead, notes: [], activities: [], mailbox: { email: "counselor@gmail.com" }, emails: [{ id: "email-1", subject: "Course details", body: "Your course information", from_email: "counselor@gmail.com", to_email: lead.email, status: "sent", direction: "outbound", created_at: lead.createdAt }] };
  const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
    states: [false, false, "", "", "", "", false, [], "", "", "email"],
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
  });
  assert.match(html, /counselor@gmail.com/);
  assert.doesNotMatch(html, /Email timeline|Accepted by provider|Your course information/);
  assert.match(html, /Your Google Workspace mailbox is connected/);
  assert.doesNotMatch(html, /Overview timeline|Notes timeline|Sent through your configured SMTP/);
});

test("lead email composer shows login address and blocks unconnected or mismatched mailboxes", async () => {
  for (const mailbox of [null, { email: "other-counselor@dmhca.in" }]) {
    const data = { ...live, user: { ...user, email: "guneswari@dmhca.in" }, lead, notes: [], activities: [], emails: [], mailbox };
    const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
      states: [false, false, "", "Hello", "Course details", "", false, [], "", "", "email"],
      overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
    });
    assert.match(html, /<strong>From<\/strong> guneswari@dmhca.in/);
    assert.match(html, /CRM sign-in alone does not grant mailbox access/);
    assert.match(html, /disabled="">Send email/);
    assert.match(html, mailbox ? /does not match your login/ : /Connect Gmail using guneswari@dmhca.in/);
  }
});
test("lead viewers see owner labels, not editable fields or compose actions", async () => {
  const data = { ...live, user: { ...user, permissions: ["leads.view"] }, lead, notes: [], activities: [], emails: [], mailbox: null };
  const html = await renderPage("src\\app\\leads\\[id]\\page.tsx", {
    overrides: { "@/lib/live-leads-client": { ...liveMock, useLiveLeadData: () => ({ data, loading: false, error: "", reload() {}, setError() {} }) } },
  });

  test("inline text editing saves on blur, validates input, retains failures and retries", async () => {
    const states = [], refs = [];
    let index = 0, refIndex = 0, fail = false;
    const saved = [];
    const { LeadInlineField } = load("src\\components\\lead-inline-field.tsx", {
      react: { ...React, useEffect() {},
        useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
        useState(initial) { const key = index++; if (!(key in states)) states[key] = initial; return [states[key], value => { states[key] = value; }]; },
      },
    });
    const render = () => { index = 0; refIndex = 0; return elements(LeadInlineField({ label: "Email", value: "old@example.com", type: "email", onSave: async value => { saved.push(value); if (fail) throw new Error("Database offline"); } })); };
    const input = () => render().find(node => node.type === "input");
    const settle = () => new Promise(resolve => setImmediate(resolve));
    input().props.onChange({ target: { value: "new@example.com" } });
    assert.equal(saved.length, 0);
    input().props.onBlur({ currentTarget: { reportValidity: () => false, validationMessage: "Invalid email" } });
    assert.equal(saved.length, 0);
    assert.ok(render().some(node => node.props?.role === "alert"));
    fail = true;
    input().props.onBlur({ currentTarget: { reportValidity: () => true } });
    await settle();
    assert.equal(input().props.value, "new@example.com");
    assert.ok(render().some(node => node.props?.role === "alert"));
    fail = false;
    render().find(node => node.type === "button" && node.props.children === "Retry").props.onClick();
    await settle();
    assert.deepEqual(saved, ["new@example.com", "new@example.com"]);
    assert.ok(render().some(node => node.props?.role === "status" && node.props.children === "Saved"));
    input().props.onChange({ target: { value: "discard@example.com" } });
    input().props.onKeyDown({ key: "Escape" });
    assert.equal(input().props.value, "old@example.com");
  });

  test("inline dropdowns save immediately on selection", async () => {
    let selected;
    const refs = [];
    let refIndex = 0;
    const { LeadInlineField } = load("src\\components\\lead-inline-field.tsx", {
      react: { ...hookStates([]), useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); } },
    });
    const nodes = elements(LeadInlineField({ label: "Stage", value: "new", options: [{ value: "new", label: "New" }, { value: "warm", label: "Warm" }], onSave: async value => { selected = value; } }));
    nodes.find(node => node.props?.ariaLabel === "Stage").props.onChange("warm");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(selected, "warm");
  });
  assert.match(html, /Read only/);
  assert.match(html, /Admissions Administrator/);
  assert.doesNotMatch(html, /<input|Autosave enabled|Edit lead|Save lead/);
});

test("ordinary admins can view device history but cannot see revocation controls", async () => {
  const admin = { ...user, profile: { ...profile, role: "admin" } };
  const adminServer = { requireUser: async () => ({ user: admin, supabase: { from: () => query([session]) } }) };
  const html = await renderPage("src\\app\\admin\\login-activity\\page.tsx", { shellUser: admin, overrides: { "@/lib/server/auth": adminServer } });
  assert.match(html, /Windows computer/);
  assert.doesNotMatch(html, /Sign out device|<th>Actions/);
});

test("dashboard does not display or query device sessions", async () => {
  for (const role of ["admin", "super_admin"]) {
    const dashboardUser = { ...user, profile: { ...profile, role } };
    const html = await renderPage("src\\app\\page.tsx", {
      shellUser: dashboardUser,
      overrides: { "@/lib/server/auth": { requireUser: async () => ({
        user: dashboardUser,
        supabase: { from() { assert.fail("Dashboard must not query device sessions"); } },
      }) } },
    });
    assert.doesNotMatch(html, /Active devices and last used|View active devices|No active device sessions|Windows computer/);
    assert.match(html, /Leads by course/);
  }
});

test("signed-out and expired sessions disappear from Login activity and active count", async () => {
  const rows = [
    session,
    { ...session, session_id: "ended", email: "signed-out@example.com", signed_out_at: "2026-10-21T10:00:00Z" },
    { ...session, session_id: "expired", email: "expired@example.com", expires_at: "2020-01-01T00:00:00Z" },
  ];
  const activeServer = { requireUser: async () => ({ user, supabase: { from: () => query(rows) } }) };
  const html = await renderPage("src\\app\\admin\\login-activity\\page.tsx", { overrides: { "@/lib/server/auth": activeServer } });
  assert.match(html, /admin@example.com/);
  assert.doesNotMatch(html, /signed-out@example.com|expired@example.com/);
  assert.match(html, /1 active sessions/);
});
