const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(path, dependencies = {}) {
  const exports = {};
  const source = readFileSync(join(__dirname, "..", path), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, {
    exports, require: (name) => name in dependencies ? dependencies[name] :
      name === "@/lib/server/login" ? { checkOrigin: () => {} } :
      name === "@/lib/server/operational-gmail" ? { currentGmailMailbox: async () => null } :
      name === "@/lib/email-signature-policy" ? load("src\\lib\\email-signature-policy.ts", dependencies) :
      name === "@/lib/note-images" ? load("src\\lib\\note-images.ts") :
      name === "@/lib/server/note-images" ? load("src\\lib\\server\\note-images.ts", { "@/lib/server/auth": auth }) :
      name === "@/lib/server/email-signature" ? load("src\\lib\\server\\email-signature.ts", dependencies) :
      name === "@/lib/lead-phone" ? load("src\\lib\\lead-phone.ts") : require(name),
    Date, Set, URL, Response, Buffer, console,
  });
  return exports;
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const auth = {
  HttpError,
  readJson: (request) => request.json(),
  jsonError: (error) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
  requireString: (value, label, max = 500) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new HttpError(400, `Invalid ${label}.`);
    return value.trim();
  },
};
const picklists = load("src\\lib\\lead-picklists.ts");
const validation = load("src\\lib\\live-leads.ts", { "@/lib/server/auth": auth, "@/lib/lead-picklists": picklists, "@/lib/lead-phone": load("src\\lib\\lead-phone.ts") });
const csv = load("src\\lib\\live-leads-csv.ts");
const filters = load("src\\lib\\lead-filters.ts");
const reports = load("src\\lib\\reports.ts", { "@/lib/lead-filters": filters });
const validLead = { name: "Live Student", phone: "+91 98765 43210", email: "student@example.test" };

test("click-to-call safely formats lead phones with their selected calling code", () => {
  const { leadCallNumber } = load("src\\lib\\lead-phone.ts");
  assert.equal(leadCallNumber("98765 43210", "India (+91)"), "+919876543210");
  assert.equal(leadCallNumber("919876543210", "India (+91)"), "+919876543210");
  assert.equal(leadCallNumber("+44 (20) 1234-5678", "India (+91)"), "+442012345678");
  assert.equal(leadCallNumber("5551234567", "United States (+1)"), "+15551234567");
  assert.equal(leadCallNumber("2345678924", "+91"), "+912345678924");
  assert.equal(leadCallNumber("2345678924", "91"), "+912345678924");
  assert.equal(leadCallNumber("912345678924"), "+912345678924");
  assert.equal(leadCallNumber("9876543210"), "9876543210");
  for (const value of ["", "123", "abc1234567", "1234567;ext=1", "+1234567890123456", "++1234567"]) {
    assert.equal(leadCallNumber(value, "India (+91)"), null);
  }
  assert.equal(leadCallNumber("123456789012345", "India (+91)"), null);
});

test("lead storage combines calling code and phone without duplicating explicit international prefixes", () => {
  for (const [phone, countryCode, expected] of [
    ["9123456789", "India (+91)", "+919123456789"],
    ["98765 43210", "India (+91)", "+919876543210"],
    ["919876543210", "India (+91)", "+919876543210"],
    ["+63 4567893834", "India (+91)", "+634567893834"],
    ["+44 (20) 1234-5678", "", "+442012345678"],
    ["5551234567", "United States (+1)", "+15551234567"],
    ["+912345678982", "India (+91)", "+912345678982"],
    ["912345678982", "India (+91)", "+912345678982"],
    ["2345678982", "India (+91)", "+912345678982"],
    ["912345678924", "+91", "+912345678924"],
    ["2345678924", "+91", "+912345678924"],
    ["912345678925", "91", "+912345678925"],
    ["2345678925", "91", "+912345678925"],
    ["912345678924", "", "+912345678924"],
    ["880987650001", "", "+880987650001"],
    ["9876543210", "", "+9876543210"],
  ]) {
    const parsed = validation.parseLead({ ...validLead, phone, countryCode });
    assert.equal(parsed.phone, expected);
    assert.equal(parsed.normalized_phone, expected.slice(1));
  }
});

function callScheduleRoute({ denied = false, invisible = false, archived = false, dbFailure = false, badOrigin = false } = {}) {
  const writes = [];
  const route = load("src\\app\\api\\leads\\[id]\\actions\\route.ts", {
    "@/lib/server/auth": { ...auth, requireString: (value) => {
      if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "Call date and time is required.");
      return value;
    }, requireUser: async permission => {
      assert.equal(permission, "leads.edit");
      if (denied) throw new HttpError(403, "Permission denied.");
      return { user: { id: "current-user" }, supabase: { rpc: async (name, args) => {
        assert.equal(name,"update_lead_scheduled_call");
        writes.push(args);
        return { error: dbFailure ? { message: "Call update failed" } : null };
      }, from(table) {
        assert.equal(table, "scheduled_calls");
        return { insert: async row => { writes.push(row); return { error: dbFailure ? { message: "Write failed" } : null }; } };
      } } };
    } },
    "@/lib/server/login": { checkOrigin: () => { if (badOrigin) throw new HttpError(403, "Invalid origin."); } },
    "@/lib/crm-data": { fetchLead: async () => invisible ? null : { ...validLead, isArchived: archived } },
    "@/lib/live-leads": { uuid: value => value, dbError: validation.dbError },
    "@/lib/supabase/server": {},
    "@/lib/server/operational-gmail": {},
  });
  return { writes, send: body => route.POST(new Request("https://crm.example/api/leads/id/actions", { method: "POST", body: JSON.stringify({ action: "schedule_call", ...body }) }), { params: Promise.resolve({ id: "accessible-lead" }) }) };
}

test("schedule call stores a real UTC appointment owned by the signed-in user, ignoring spoofed ownership", async () => {
  const state = callScheduleRoute();
  const response = await state.send({ scheduledAt: "2099-12-01T15:30:00+05:30", user_id: "someone-else", lead_id: "hidden-lead", status: "completed" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(state.writes)), [{ lead_id: "accessible-lead", user_id: "current-user", scheduled_at: "2099-12-01T10:00:00.000Z", status: "scheduled" }]);
});

test("schedule call rejects missing, malformed, impossible, timezone-free and past dates without writing", async () => {
  for (const scheduledAt of [undefined, null, 123, "", "tomorrow", "2099-02-30T12:00:00Z", "2099-12-01T10:00:00", "2020-01-01T10:00:00Z"]) {
    const state = callScheduleRoute();
    assert.equal((await state.send({ scheduledAt })).status, 400, String(scheduledAt));
    assert.equal(state.writes.length, 0);
  }
});

test("schedule call enforces permission, origin and accessible non-archived leads", async () => {
  for (const [options, status] of [[{ denied: true }, 403], [{ badOrigin: true }, 403], [{ invisible: true }, 404], [{ archived: true }, 404]]) {
    const state = callScheduleRoute(options);
    assert.equal((await state.send({ scheduledAt: "2099-12-01T10:00:00Z" })).status, status);
    assert.equal(state.writes.length, 0);
  }
});

test("schedule call surfaces database errors rather than reporting success", async () => {
  const state = callScheduleRoute({ dbFailure: true });
  const response = await state.send({ scheduledAt: "2099-12-01T10:00:00Z" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Write failed/);
});

test("call update API validates rescheduling and forwards status updates to the scoped transaction", async () => {
  for (const status of ["scheduled","completed","cancelled"]) {
    const state = callScheduleRoute();
    const response = await state.send({ action: "update_call", callId: "call-id", status, scheduledAt: "2099-12-02T10:00:00Z" });
    assert.equal(response.status,200);
    assert.deepEqual(JSON.parse(JSON.stringify(state.writes)),[{ lead_id: "accessible-lead", call_id: "call-id", new_status: status, new_time: status === "scheduled" ? "2099-12-02T10:00:00.000Z" : null }]);
  }
  for (const body of [{ status: "unknown" }, { status: "scheduled", scheduledAt: "2020-01-01T00:00:00Z" }, { status: "scheduled", scheduledAt: "invalid" }]) {
    const state = callScheduleRoute();
    assert.equal((await state.send({ action: "update_call", callId: "call-id", ...body })).status,400);
    assert.equal(state.writes.length,0);
  }
  const denied = callScheduleRoute({ denied: true });
  assert.equal((await denied.send({ action: "update_call", callId: "call-id", status: "completed" })).status,403);
});

test("lead detail reload returns persisted scheduled calls through the authenticated lead scope", async () => {
  const calls = [{ id: "call-id", user_id: "current-user", scheduled_at: "2099-12-01T10:00:00Z", status: "scheduled" }];
  const route = load("src\\app\\api\\leads\\[id]\\route.ts", {
    "@/lib/server/auth": { ...auth, requireUser: async permission => {
      assert.equal(permission, "leads.view");
      return { user: { id: "current-user" }, supabase: { rpc: async (name, args) => {
        assert.equal(name, "lead_duplicate_owners"); assert.equal(args.lead_id, "accessible-lead");
        return { data: [{ assignee: "Other counselor", merge_target_id: null }], error: null };
      }, from(table) {
        const chain = {
          select: () => chain,
          eq: (key, value) => { if (table === "scheduled_calls") { assert.equal(key, "lead_id"); assert.equal(value, "accessible-lead"); } return chain; },
          order: async (column, options) => { if (table === "scheduled_calls") { assert.equal(column, "scheduled_at"); assert.equal(options.ascending, true); } return { data: table === "scheduled_calls" ? calls : [], error: null }; },
          single: async () => ({ data: { custom_fields: {} }, error: null }),
        };
        return chain;
      } } };
    } },
    "@/lib/crm-data": { fetchLead: async () => validLead, fetchProfiles: async () => [], fetchStages: async () => [] },
    "@/lib/live-leads": { uuid: value => value, dbError: validation.dbError, fetchLeadConfiguration: async () => ({}) },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }) },
  });
  const response = await route.GET(new Request("https://crm.example/api/leads/id"), { params: Promise.resolve({ id: "accessible-lead" }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.scheduledCalls, calls);
  assert.deepEqual(result.duplicates, [{ assignee: "Other counselor", merge_target_id: null }]);
});

function leadActionRoute({ missing = false, sendError = null, logError = null } = {}) {
  const writes = [];
  let sends = 0;
  const route = load("src\\app\\api\\leads\\[id]\\actions\\route.ts", {
    "@/lib/server/auth": { ...auth, isEmail: () => true, requireString: (value) => value, requireUser: async permission => {
      assert.equal(permission, "leads.edit");
      return { user: { id: "signed-in-user", email: "signed-in@gmail.com" }, supabase: { from(table) {
        if (table === "profiles") return { select: () => ({ eq: () => ({ single: async () => ({ data: { email_signature_html: "" }, error: null }) }) }) };
        assert.equal(table, "emails");
        return {
          insert(row) { writes.push(row); return { select: () => ({ single: async () => ({ data: { id: "email-row" }, error: null }) }) }; },
          update(row) { writes.push(row); return { eq: async () => ({ error: logError }) }; },
        };
      } } };
    } },
    "@/lib/crm-data": { fetchLead: async () => ({ ...validLead, assigneeId: "different-lead-owner" }) },
    "@/lib/live-leads": { uuid: value => value, dbError: validation.dbError },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({}) },
    "@/lib/server/operational-gmail": {
      prepareGmailSend: async (_admin, userId, loginEmail) => { assert.equal(userId, "signed-in-user"); assert.equal(loginEmail, "signed-in@gmail.com"); if (missing) throw new HttpError(409, "Connect your Gmail mailbox"); return { email: loginEmail, accessToken: "personal" }; },
      sendGmailMessage: async (mailbox, to, subject, content) => {
        sends++; assert.equal(mailbox.email, "signed-in@gmail.com"); assert.equal(to, validLead.email);
        assert.equal(subject, "Course information"); assert.equal(content, "Message body");
        if (sendError) throw sendError; return { id: "gmail-message" };
      },
    },
  });
  return { writes, get sends() { return sends; }, send: () => route.POST(new Request("https://crm.example/api/leads/id/actions", { method: "POST", body: JSON.stringify({ action: "email", subject: "Course information", content: "Message body" }) }), { params: Promise.resolve({ id: "lead-id" }) }) };
}

test("lead email is sent from the signed-in mailbox and persists actual sender and Gmail ID", async () => {
  const state = leadActionRoute();
  assert.equal((await state.send()).status, 200);
  assert.equal(state.sends, 1);
  assert.equal(state.writes[0].from_email, "signed-in@gmail.com");
  assert.equal(state.writes[0].user_id, "signed-in-user");
  assert.equal(state.writes[1].gmail_message_id, "gmail-message");
  assert.equal(state.writes[1].status, "sent");
});

test("lead email without a connected mailbox is blocked before queuing or sending", async () => {
  const state = leadActionRoute({ missing: true });
  assert.equal((await state.send()).status, 409);
  assert.equal(state.sends, 0);
  assert.equal(state.writes.length, 0);
});

test("Gmail errors persist failed status instead of reporting success", async () => {
  const state = leadActionRoute({ sendError: new HttpError(502, "Reconnect Gmail") });
  const response = await state.send();
  assert.equal(response.status, 502);
  assert.equal(state.writes[1].status, "failed");
});

test("email log failure after provider acceptance warns against duplicate sends", async () => {
  const state = leadActionRoute({ logError: { message: "Database unavailable" } });
  const response = await state.send();
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /Gmail accepted.*Do not resend/);
  assert.equal(state.sends, 1);
});

test("single-field lead PATCH preserves unrelated columns and merges custom fields", async () => {
  let updated, leadReads = 0;
  const crmData = load("src\\lib\\crm-data.ts", { "@/lib/permissions": { isCrmRole: () => true } });
  const returnedRow = { id: "lead", name: "Server normalized", modified_at: "2099-01-01T10:00:00Z", closure_fee: "1250", custom_fields: { Existing: "kept" }, call_schedule_revision: 4, modifier: { full_name: "Server editor" } };
  const selects = [];
  const route = load("src\\app\\api\\leads\\[id]\\route.ts", {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({
      user: { id: "editor", permissions: ["leads.edit"] },
      supabase: { from() {
        const chain = { select: columns => { selects.push(columns); return chain; }, eq: () => chain, single: async () => ({ data: { custom_fields: { Existing: "kept" }, call_schedule_revision: 3 }, error: null }),
          update: row => { updated = row; return chain; }, maybeSingle: async () => ({ data: returnedRow, error: null }) };
        return chain;
      } },
    }) },
    "@/lib/crm-data": { ...crmData, fetchLead: async () => { leadReads++; return { ...validLead, country: "", course: "", qualification: "", source: "Website", closureFee: 0 }; } },
    "@/lib/live-leads": { ...validation, uuid: value => value, fetchLeadConfiguration: async () => ({ fields: [{ name: "New field", active: true, type: "text" }] }) },
    "@/lib/supabase/server": {},
  });
  async function patch(body) {
    return route.PATCH(new Request("https://crm.example/api/leads/id", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "lead" }) });
  }
  const response = await patch({ name: "Changed" });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.id, "lead");
  assert.equal(saved.lead.name, "Server normalized");
  assert.equal(saved.lead.modifiedAt, returnedRow.modified_at);
  assert.equal(saved.lead.modifiedBy, "Server editor");
  assert.equal(saved.lead.closureFee, 1250);
  assert.deepEqual(saved.lead.customFields, { Existing: "kept" });
  assert.equal(saved.scheduleUnlocked, true);
  assert.equal(leadReads, 1, "the update returns its own selected row without a second detail lookup");
  assert.match(selects.at(-1), /custom_fields,call_schedule_revision/);
  assert.deepEqual(Object.keys(updated).sort(), ["modified_by", "name"]);
  assert.equal((await patch({ email: "new@example.com" })).status, 200);
  assert.deepEqual(Object.keys(updated).sort(), ["email", "modified_by", "normalized_email"]);
  assert.equal((await patch({ expectedClosureDate: "2026-12-01" })).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(updated)), { expected_closure_date: "2026-12-01", modified_by: "editor" });
  assert.equal((await patch({ expectedClosureDate: "" })).status, 200);
  assert.equal(updated.expected_closure_date, null);
  assert.equal((await patch({ speciality: " Cardiology " })).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(updated)), { speciality: "Cardiology", modified_by: "editor" });
  assert.equal((await patch({ speciality: "" })).status, 200);
  assert.equal(updated.speciality, null);
  assert.equal((await patch({ customFields: { "New field": "value" } })).status, 200);
  assert.equal(updated.custom_fields.Existing, "kept");
  assert.equal(updated.custom_fields["New field"], "value");
  assert.equal((await patch({ assigneeId: "20000000-0000-4000-8000-000000000001" })).status, 403);
  assert.equal((await patch({})).status, 400);
});

test("lead validation normalizes phone and email and excludes client-owned metadata", () => {
  const parsed = validation.parseLead(validLead);
  assert.equal(parsed.normalized_phone, "919876543210");
  assert.equal(parsed.normalized_email, "student@example.test");
  assert.equal(parsed.closure_fee, 0);
  assert.throws(() => validation.parseLead({ ...validLead, created_by: "spoof" }), /Unrecognized/);
  assert.throws(() => validation.parseLead({ ...validLead, is_archived: true }), /Unrecognized/);
  assert.throws(() => validation.parseLead({ ...validLead, closureFee: -1 }), /closureFee/);
  assert.throws(() => validation.parseLead({ ...validLead, phone: "abc1234567" }), /phone/);
  assert.throws(() => validation.parseLead({ ...validLead, email: "not-an-email" }), /email/);
  assert.throws(() => validation.parseLead({ ...validLead, assigneeId: "fake" }), /assigneeId/);
  assert.throws(() => validation.parseLead({ ...validLead, followUpAt: "tomorrow" }), /followUpAt/);
});

test("expected closure date validates real calendar days without timezone conversion", () => {
  for (const date of ["2026-12-01", "2028-02-29", "", null]) {
    assert.equal(validation.parseLead({ ...validLead, expectedClosureDate: date }).expected_closure_date, date || null);
  }
  for (const date of ["2026-02-29", "2026-02-30", "tomorrow", "2026-12-01T00:00:00Z", "01-12-2026"]) {
    assert.throws(() => validation.parseLead({ ...validLead, expectedClosureDate: date }), /expectedClosureDate/);
  }
  assert.equal(validation.parseLead(validLead).expected_closure_date, null);
  const parsed = csv.parseLeadCsv("name,phone,Expected closure fee,Expected closure date\nNew lead,9876543210,1250,2026-12-01")[0];
  assert.equal(parsed.closureFee, "1250");
  assert.equal(parsed.expectedClosureDate, "2026-12-01");
  assert.equal(csv.parseLeadCsv("name,phone,closureFee\nNew lead,9876543210,1250")[0].closureFee, "1250");
});

test("sample lead CSV marks required columns and includes two parseable examples for every field", () => {
  const sample = csv.createLeadCsvSample({
    picklists: { countryCode: ["India (+91)"], country: ["India", "UAE"], qualification: ["MBBS"], category: ["Fellowship"], course: ["Cardiology"], source: ["Website"] },
    stages: ["New enquiry", "Application review"],
    assignees: ["admin@example.test"],
    customFields: [{ name: "Campus", options: ["Delhi", "Dubai"] }, { name: "Comment", options: [] }],
  });
  const [headerLine, ...sampleLines] = sample.trim().split("\r\n");
  assert.match(headerLine, /^"name \(required\)".*"countryCode".*"phone \(required\)".*"email \(required\)"/);
  const customHeaders = ["Campus", "Comment"];
  const rows = csv.parseLeadCsv(sample, customHeaders);
  assert.equal(rows.length, 2);
  assert.equal(sampleLines.length, 2);
  assert.ok(rows.every(row => row.name.startsWith("Sample Lead") && row.phone.length >= 7));
  assert.equal(Array.from(rows, row => row.note).join("|"), [
    "Initial enquiry from website; asked about course details.",
    "Follow-up requested; prefers an afternoon call.",
  ].join("|"));
  for (const header of [...csv.IMPORT_HEADERS, ...customHeaders.map(name => `custom:${name}`)]) {
    const key = header === "expectedClosureFee" ? "closureFee" : header;
    assert.ok(rows.every(row => typeof row[key] === "string" && row[key].length > 0), `${header} has a sample value`);
  }
});

test("Excel workbook rows use the same CSV header mapping and validation", async () => {
  let sheetIndex = -1;
  const workbookCsv = load("src\\lib\\live-leads-csv.ts", {
    "read-excel-file/browser": {
      readSheet: async (input, index) => {
        assert.ok(input instanceof ArrayBuffer);
        sheetIndex = index;
        return [
          ["name (required)", "countryCode", "phone (required)", "email (required)", "note"],
          ["Sample Student", "India (+91)", "2345678982", "student@example.test", "Asked about admissions"],
        ];
      },
    },
  });
  const rows = await workbookCsv.parseLeadSpreadsheet({
    name: "leads.xlsx",
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(8),
  });
  assert.equal(sheetIndex, 0);
  assert.equal(rows[0].email, "student@example.test");
  assert.equal(rows[0].note, "Asked about admissions");
  await assert.rejects(() => workbookCsv.parseLeadSpreadsheet({
    name: "leads.xls",
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
  }), /CSV or Excel/);
});

test("speciality supplies all requested choices and is optional, validated and importable", () => {
  const expected = [
    "Cardiology", "Radiology", "General Medicine", "Internal Medicine", "Critical Care",
    "Emergency Medicine", "Orthopedics", "Dermatology", "General Surgery", "Obstetrics & Gynecology",
    "Reproductive Medicine", "Infertility Management", "Pediatrics", "Neurology", "Oncology",
    "Endocrinology", "Pulmonology", "Gastroenterology", "Urology", "Nephrology", "Psychiatry",
    "Ophthalmology", "Dentistry", "Pathology", "Microbiology", "Anesthesiology", "Anatomy",
    "Physiology", "Family Medicine", "Nutrition", "ENT (Otorhinolaryngology)", "Medical Management", "Others",
  ];
  assert.deepEqual([...picklists.DEFAULT_LEAD_PICKLISTS.speciality], expected);
  assert.equal(validation.parseLead(validLead).speciality, null);
  assert.equal(validation.parseLead({ ...validLead, speciality: "  " }).speciality, null);
  assert.equal(validation.parseLead({ ...validLead, speciality: " Cardiology " }).speciality, "Cardiology");
  assert.throws(() => validation.parseLead({ ...validLead, speciality: "x".repeat(201) }), /speciality/);
  assert.ok(csv.IMPORT_HEADERS.includes("speciality"));
  for (const header of ["Speciality", "Specialty"]) {
    assert.equal(csv.parseLeadCsv(`name,phone,${header}\nNew lead,9876543210,Cardiology`)[0].speciality, "Cardiology");
  }
  const mapped = load("src\\lib\\crm-data.ts", { "@/lib/permissions": { isCrmRole: () => true } });
  assert.equal(mapped.mapLead({ id: "lead", speciality: "Cardiology" }).speciality, "Cardiology");
  assert.equal(mapped.mapLead({ id: "lead" }).speciality, "");
});

test("lead columns expose standard and active custom fields, preserve zero fees and export their data", () => {
  const fields = [{ name: "Custom intake detail", active: true }, { name: "Disabled", active: false }];
  const columns = reports.leadColumns(fields);
  for (const key of ["countryCode", "altPhone", "billingAddress", "speciality", "closureFee", "expectedClosureDate", "createdBy", "custom:Custom intake detail"]) {
    assert.ok(columns.some(column => column.key === key), key);
  }
  assert.ok(!columns.some(column => column.key === "custom:Disabled"));
  const row = { ...validLead, speciality: "Cardiology", closureFee: 0, expectedClosureDate: "2026-12-01", customFields: { "Custom intake detail": "New answer" } };
  assert.equal(reports.leadColumnValue(row, "closureFee"), 0);
  assert.equal(reports.leadColumnValue(row, "custom:Custom intake detail"), "New answer");
  const output = reports.reportCsv({ columns: ["closureFee", "expectedClosureDate"] }, [row], "list", columns.filter(column => column.key.startsWith("custom:")));
  assert.match(output, /"Expected closure fee","Expected closure date","Custom intake detail"/);
  assert.match(output, /"0","2026-12-01","New answer"/);
  assert.match(reports.reportCsv({ columns: ["speciality"] }, [row], "list"), /"Speciality"[\s\S]*"Cardiology"/);
});

test("configuration combines saved options with database-wide observed choices, including empty pages", async () => {
  const configuration = { fields: [], picklists: { course: ["Configured course"], source: ["Website"] } };
  const observed = { speciality: ["New external speciality"], course: ["New Facebook course", "Configured course"], source: ["DMHCA-Contact form", " website "], category: ["New category"] };
  let failure = false;
  const client = { from(table) {
    assert.equal(table, "crm_settings");
    let key;
    const chain = { select: () => chain, eq: (_column, value) => { key = value; return chain; },
      maybeSingle: async () => ({ data: { value: key === "lead_configuration" ? configuration : observed }, error: failure ? { message: "Read failed" } : null }) };
    return chain;
  } };
  const result = await validation.fetchLeadConfiguration(client);
  assert.deepEqual([...result.picklists.course], ["Configured course", "New Facebook course"]);
  assert.deepEqual([...result.picklists.source], ["Website", "DMHCA-Contact form"]);
  assert.ok(result.picklists.category.includes("New category"));
  assert.ok(result.picklists.speciality.includes("Cardiology"));
  assert.ok(result.picklists.speciality.includes("New external speciality"));
  failure = true;
  await assert.rejects(validation.fetchLeadConfiguration(client), /Read failed/);
});

test("column preferences persist expected closure and active custom fields but reject arbitrary or disabled keys", async () => {
  const writes = [];
  const route = load("src\\app\\api\\leads\\preferences\\route.ts", {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({
      user: { id: "viewer" }, supabase: { from: table => {
        assert.equal(table, "user_columns");
        return { upsert: async value => { writes.push(value); return { error: null }; } };
      } },
    }) },
    "@/lib/live-leads": { ...validation, fetchLeadConfiguration: async () => ({ fields: [
      { name: "External detail", active: true }, { name: "Disabled", active: false },
    ] }) },
    "@/lib/reports": reports,
    "@/lib/lead-filters": filters,
  });
  const save = columns => route.POST(new Request("https://crm.example/api/leads/preferences", { method: "POST", body: JSON.stringify({ action: "columns", columns }) }));
  const columns = ["name", "closureFee", "expectedClosureDate", "countryCode", "custom:External detail"];
  assert.equal((await save(columns)).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0])), { user_id: "viewer", view_name: "leads", columns_json: columns });
  for (const invalid of [[], ["name", "name"], ["custom:Disabled"], ["custom:Unknown"], ["normalized_phone"]]) {
    assert.equal((await save(invalid)).status, 400);
  }
  assert.equal(writes.length, 1);
});

test("lead deletion rejects non-admin roles before writes even with delete permission", async () => {
  for (const role of ["counselor", "team_lead", "manager", "admin", "super_admin"]) {
    let writes = 0;
    const route = load("src\\app\\api\\leads\\[id]\\route.ts", {
      "@/lib/server/auth": { ...auth, requireUser: async permission => {
        assert.equal(permission, "leads.delete");
        return { user: { id: "user", profile: { role }, permissions: ["leads.delete"] }, supabase: { from() {
          const chain = { update: () => { writes++; return chain; }, eq: () => chain, select: () => chain, maybeSingle: async () => ({ data: { id: "lead" }, error: null }) };
          return chain;
        } } };
      } },
      "@/lib/crm-data": {}, "@/lib/live-leads": { uuid: value => value, dbError: validation.dbError },
      "@/lib/supabase/server": {},
    });
    const response = await route.DELETE(new Request("https://crm.example/api/leads/id", { method: "DELETE" }), { params: Promise.resolve({ id: "lead" }) });
    const allowed = ["admin", "super_admin"].includes(role);
    assert.equal(response.status, allowed ? 200 : 403, role);
    assert.equal(writes, allowed ? 1 : 0, role);
  }
});

test("lead transfers allow team leads and managers, preserve stage by omission and reject invalid stages", async () => {
  const assigneeId = "20000000-0000-4000-8000-000000000001";
  const stageId = "30000000-0000-4000-8000-000000000001";
  for (const role of ["counselor", "team_lead", "manager", "admin", "super_admin"]) {
    let updated;
    const route = load("src\\app\\api\\leads\\[id]\\route.ts", {
      "@/lib/server/auth": { ...auth, requireUser: async () => ({
        user: { id: "editor", profile: { role }, permissions: ["leads.edit", "leads.assign"] },
        supabase: { from() {
          const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: { custom_fields: {} }, error: null }),
            update: row => { updated = row; return chain; }, maybeSingle: async () => ({ data: { id: "lead" }, error: null }) };
          return chain;
        } },
      }) },
      "@/lib/crm-data": { mapLead: row => row, LEAD_SELECT: "id,name", fetchLead: async () => ({ ...validLead, country: "", course: "", qualification: "", source: "Website", closureFee: 0 }), fetchStages: async () => [{ id: stageId }] },
      "@/lib/live-leads": { ...validation, uuid: value => value, fetchLeadConfiguration: async () => ({ fields: [] }) },
      "@/lib/supabase/server": {},
    });
    const patch = body => route.PATCH(new Request("https://crm.example/api/leads/id", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "lead" }) });
    assert.equal((await patch({ assigneeId })).status, role === "counselor" ? 403 : 200, role);
    if (role === "counselor") { assert.equal(updated, undefined); continue; }
    assert.equal(updated.assignee_id, assigneeId);
    assert.equal(Object.hasOwn(updated, "stage_id"), false);
    assert.equal((await patch({ assigneeId, stageId })).status, 200);
    assert.equal(updated.assignee_id, assigneeId);
    assert.equal(updated.stage_id, stageId);
    updated = undefined;
    assert.equal((await patch({ assigneeId, stageId: "30000000-0000-4000-8000-000000000002" })).status, 400);
    assert.equal(updated, undefined);
  }
});

test("new-lead picklists require valid values and include the selected dialing prefix in duplicate checks", () => {
  const parsed = validation.parseLead({
    name: "Lead", email: "lead@example.test", countryCode: "India (+91)", phone: "98765 43210",
    country: "India", qualification: "MBBS", category: "Fellowship", course: "Clinical Cardiology",
    source: "Website", stageId: "30000000-0000-4000-8000-000000000001",
  });
  assert.equal(parsed.country_code, "India (+91)");
  assert.equal(parsed.normalized_phone, "919876543210");
  assert.equal(parsed.category, "Fellowship");
  const config = { picklists: picklists.DEFAULT_LEAD_PICKLISTS };
  validation.validateNewLeadFields(parsed, config);
  assert.throws(() => validation.validateNewLeadFields({ ...parsed, source: "manual" }, config), /valid source/);
  assert.throws(() => validation.validateNewLeadFields({ ...parsed, stage_id: null }, config), /Stage is required/);
});

test("CSV reads BOM, quoted commas, multiline values, quotes and CRLF", () => {
  const rows = csv.parseLeadCsv('\uFEFFname,phone,course\r\n"Jane, ""JJ""",9876543210,"Course\nTwo"\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Jane, "JJ"');
  assert.equal(rows[0].course, "Course\nTwo");
});

test("CSV rejects malformed headers, field counts, quotes and oversized imports", () => {
  for (const source of [
    "name,Name,phone\nA,A,9876543210",
    "name,secret\nA,1",
    "name,phone\nA",
    'name,phone\n"A,9876543210',
    'name,phone\n"A"x,9876543210',
    "name,phone\n",
    `name,phone\n${"A,9876543210\n".repeat(200001)}`,
  ]) assert.throws(() => csv.parseLeadCsv(source));
});

test("lead import limits support 200,000 rows and 50 MB files", () => {
  assert.equal(csv.MAX_LEAD_IMPORT_ROWS, 200000);
  assert.equal(csv.MAX_LEAD_IMPORT_FILE_BYTES, 50000000);
  const rows = csv.parseLeadCsv(`name,phone,email\n${"Lead,9876543210,lead@example.test\n".repeat(1001)}`);
  assert.equal(rows.length, 1001);
});

test("report CSV prevents formula injection and supports count exports", () => {
  const report = { columns: ["name", "phone"] };
  const output = reports.reportCsv(report, [{ name: '=HYPERLINK("bad")', phone: "+919876543210" }], "list");
  assert.match(output, /'=/);
  assert.match(output, /'\+919876543210/);
  assert.equal(reports.reportCsv(report, [{}], "count"), '"Count"\r\n"1"');
});

test("My Leads report filters use authenticated user ID", () => {
  const filter = { id: "f", name: "Mine", criteria: [], matchMode: "all", query: "", quickView: "My Leads" };
  const rows = reports.reportLeads({ filter }, [{ id: "one", assigneeId: "me" }, { id: "two", assigneeId: "other" }], "me");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "one");
});

test("lead exports reject lower roles before accessing database", async () => {
  for (const role of ["counselor", "team_lead", "manager"]) {
    let reads = 0;
    const route = load("src\\app\\api\\leads\\export\\route.ts", {
      "@/lib/server/auth": { ...auth, requireUser: async (permission) => {
        assert.equal(permission, "leads.view");
        return { user: { id: "user", profile: { role } }, supabase: {} };
      } },
      "@/lib/crm-data": { fetchLeads: async () => { reads++; return []; } },
      "@/lib/lead-filters": filters, "@/lib/reports": reports,
      "@/lib/live-leads": validation,
      "@/lib/server/lead-query": {}, "@/lib/server/lead-export": {},
    });
    const response = await route.POST(new Request("http://localhost/api/leads/export", { method: "POST", body: "{}" }));
    assert.equal(response.status, 403);
    assert.equal(reads, 0);
  }
});

test("report export denies explicit role overrides and missing report view", async () => {
  for (const [role, permissions] of [["counselor", ["reports.view", "reports.export"]], ["team_lead", ["reports.view", "reports.export"]], ["manager", ["reports.export"]]]) {
    const route = load("src\\app\\api\\reports\\export\\route.ts", {
      "@/lib/server/auth": { ...auth, requireUser: async (permission) => {
        assert.equal(permission, "reports.export");
        return { user: { id: "user", profile: { role }, permissions }, supabase: {} };
      } },
      "@/lib/live-leads": validation, "@/lib/crm-data": {}, "@/lib/lead-filters": filters, "@/lib/reports": reports,
      "@/lib/server/lead-query": {}, "@/lib/server/lead-export": {},
    });
    const response = await route.POST(new Request("http://localhost/api/reports/export", { method: "POST", body: "{}" }));
    assert.equal(response.status, 403);
  }
});

test("import requires create permission, email and an authorized assignee; country code is optional", async () => {
  const self = "00000000-0000-4000-8000-000000000001";
  for (const [permissions, rows, status, expectedWrites] of [
    [[], [{ ...validLead, countryCode: "India (+91)", assigneeId: self }], 403, 0],
    [["leads.create"], [{ ...validLead, countryCode: "India (+91)", assigneeId: self }], 403, 0],
    [["leads.create", "leads.import"], [{ ...validLead, countryCode: "India (+91)", assigneeId: self, email: "" }], 400, 0],
    [["leads.create", "leads.import"], [{ ...validLead, countryCode: "", assigneeId: self }], 201, 1],
    [["leads.create", "leads.import"], [{ ...validLead, countryCode: "+91", assigneeId: self }], 201, 1],
    [["leads.create", "leads.import"], [{ ...validLead, countryCode: "91", assigneeId: self }], 201, 1],
    [["leads.create", "leads.import"], [{ ...validLead, countryCode: "India (+91)" }], 400, 0],
    [["leads.create", "leads.import"], [{ ...validLead, countryCode: "Invalid (+999)", assigneeId: self }], 400, 0],
    [["leads.create", "leads.import"], [{ ...validLead, countryCode: "India (+91)", assigneeId: "00000000-0000-4000-8000-000000000002" }], 400, 0],
  ]) {
    let writes = 0;
    const route = load("src\\app\\api\\leads\\import\\route.ts", {
      "next/server": { NextResponse: Response }, "@/lib/live-leads": validation, "@/lib/lead-phone": load("src\\lib\\lead-phone.ts"),
      "@/lib/server/auth": { ...auth, requireUser: async (permission) => {
        assert.equal(permission, "leads.import");
        return { user: { id: self, permissions }, supabase: {
          rpc: async (name) => {
            writes++;
            if (name === "import_live_leads") return { data: { imported: 1, skipped: 0 }, error: null };
            return { data: "block", error: null };
          },
          from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: {} }, error: null }) }) }) }),
        } };
      } },
    });

    const response = await route.POST(new Request("http://localhost/api/leads/import", { method: "POST", body: JSON.stringify({ rows }) }));
    assert.equal(response.status, status);
    assert.equal(writes, expectedWrites);
  }
});

test("lead import attaches optional notes in the atomic import RPC", async () => {
  let rpcRows;
  const route = load("src\\app\\api\\leads\\import\\route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/live-leads": {
      ...validation,
      fetchLeadConfiguration: async () => ({ fields: [], picklists: picklists.DEFAULT_LEAD_PICKLISTS }),
      validateCustomFields() {},
      enforceDuplicatePolicy: async () => {},
    },
    "@/lib/server/auth": { ...auth, requireUser: async () => ({
      user: { id: "00000000-0000-4000-8000-000000000001", permissions: ["leads.import", "leads.create"] },
      supabase: { rpc: async (name, args) => {
        assert.equal(name, "import_live_leads");
        rpcRows = args.rows_json;
        return { data: { imported: rpcRows.length, skipped: 0 }, error: null };
      } },
    }) },
    "@/lib/server/login": { checkOrigin() {} },
  });
  const response = await route.POST(new Request("http://localhost/api/leads/import", {
    method: "POST",
    body: JSON.stringify({ rows: [{ ...validLead, countryCode: "India (+91)", assigneeId: "00000000-0000-4000-8000-000000000001", note: " Initial enquiry " }] }),
  }));
  assert.equal(response.status, 201);
  assert.equal(rpcRows[0].note, "Initial enquiry");
  assert.equal(rpcRows[0].name, validLead.name);

  const invalid = await route.POST(new Request("http://localhost/api/leads/import", {
    method: "POST",
    body: JSON.stringify({ rows: [{ ...validLead, countryCode: "India (+91)", assigneeId: "00000000-0000-4000-8000-000000000001", note: "x".repeat(10001) }] }),
  }));
  assert.equal(invalid.status, 400);
});

test("import duplicate precheck allows unresolved owners and returns only duplicate row indexes", async () => {
  const route = load("src\\app\\api\\leads\\import\\route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/live-leads": {
      ...validation,
      fetchLeadConfiguration: async () => ({ fields: [], picklists: picklists.DEFAULT_LEAD_PICKLISTS }),
      validateCustomFields() {},
    },
    "@/lib/server/auth": { ...auth, requireUser: async () => ({
      user: { id: "00000000-0000-4000-8000-000000000001", permissions: ["leads.import", "leads.create"] },
      supabase: { rpc: async (name, args) => {
        assert.equal(name, "find_live_lead_import_duplicates");
        assert.equal(args.rows_json.length, 2);
        assert.equal(args.rows_json[0].assignee_id ?? null, null);
        return { data: [1], error: null };
      } },
    }) },
    "@/lib/server/login": { checkOrigin() {} },
  });
  const response = await route.POST(new Request("http://localhost/api/leads/import", {
    method: "POST",
    body: JSON.stringify({ checkOnly: true, rows: [
      { ...validLead, countryCode: "India (+91)" },
      { ...validLead, name: "Second student", phone: "9876543211", email: "second@example.test", countryCode: "India (+91)" },
    ] }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { duplicates: [1] });
});

test("tracked import API validates sheet identifiers and forwards batch identity with normalized phones", async () => {
  const self = "00000000-0000-4000-8000-000000000001";
  const importId = "00000000-0000-4000-8000-000000000002";
  const writes = [];
  const route = load("src\\app\\api\\leads\\import\\route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/live-leads": { ...validation, fetchLeadConfiguration: async () => ({ fields: [], picklists: picklists.DEFAULT_LEAD_PICKLISTS }) },
    "@/lib/server/auth": { ...auth, requireUser: async () => ({
      user: { id: self, permissions: ["leads.import", "leads.create"] },
      supabase: { rpc: async (name, args) => { writes.push({ name, args }); return { data: { imported: 1, skipped: 0 }, error: null }; } },
    }) },
  });
  const send = body => route.POST(new Request("http://localhost/api/leads/import", { method: "POST", body: JSON.stringify({ rows: [{ ...validLead, phone: "880987650001", assigneeId: self }], ...body }) }));
  for (const body of [{ importId: 123, batchIndex: 0 }, { importId: "invalid", batchIndex: 0 }, { importId }, { importId, batchIndex: -1 }, { importId, batchIndex: 0.1 }]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal(writes.length, 0);
  assert.equal((await send({ importId, batchIndex: 0 })).status, 201);
  assert.equal(writes[0].name, "import_live_lead_sheet_batch");
  assert.equal(writes[0].args.sheet_id, importId);
  assert.equal(writes[0].args.batch_index, 0);
  assert.equal(writes[0].args.rows_json[0].phone, "+880987650001");
});

test("import history API bounds pagination and persists validated file metadata through the authorized RPC", async () => {
  const calls = [];
  let canCreate = true;
  const route = load("src\\app\\api\\leads\\imports\\route.ts", {
    "next/server": { NextResponse: Response }, "@/lib/live-leads": validation,
    "@/lib/server/auth": { ...auth, requireUser: async permission => {
      assert.equal(permission, "leads.import");
      const builder = {
        select() { return builder; }, neq(column, value) { assert.equal(column, "status"); assert.equal(value, "deleted"); return builder; },
        order() { return builder; }, range(start, end) { calls.push({ start, end }); return { data: [], count: 40, error: null }; },
      };
      return { user: { permissions: canCreate ? ["leads.create"] : [] }, supabase: {
        from(table) { assert.equal(table, "lead_import_sheets"); return builder; },
        rpc: async (name, args) => { calls.push({ name, args }); return { data: { id: "saved-sheet" }, error: null }; },
      } };
    } },
  });
  assert.equal((await route.GET(new Request("http://localhost/api/leads/imports?offset=-1"))).status, 400);
  assert.equal((await route.GET(new Request("http://localhost/api/leads/imports?offset=20"))).status, 200);
  assert.deepEqual(calls.shift(), { start: 20, end: 39 });
  const send = body => route.POST(new Request("http://localhost/api/leads/imports", { method: "POST", body: JSON.stringify(body) }));
  for (const body of [{ filename: "", totalRows: 2, duplicates: 0 }, { filename: "leads.csv", totalRows: 200001, duplicates: 0 }, { filename: "leads.csv", totalRows: 2, duplicates: 3 }]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal((await send({ filename: " leads.csv ", totalRows: 100, duplicates: 25, created_by: "forged" })).status, 201);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.shift())), { name: "start_live_lead_import", args: { sheet_filename: "leads.csv", row_count: 100, duplicates: 25 } });
  canCreate = false;
  assert.equal((await send({ filename: "leads.csv", totalRows: 100, duplicates: 25 })).status, 403);
  assert.equal(calls.length, 0);
});

test("sheet deletion API requires administrator, import and delete permissions and surfaces failures", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  for (const [role, permissions, failure, expected] of [
    ["counselor", ["leads.import"], false, 403],
    ["admin", [], false, 403],
    ["admin", ["leads.import"], true, 400],
    ["super_admin", ["leads.import"], false, 200],
  ]) {
    let writes = 0;
    const route = load("src\\app\\api\\leads\\imports\\[id]\\route.ts", {
      "next/server": { NextResponse: Response }, "@/lib/live-leads": validation,
      "@/lib/server/auth": { ...auth, requireUser: async permission => {
        assert.equal(permission, "leads.delete");
        return { user: { permissions, profile: { role } }, supabase: { rpc: async (name, args) => {
          writes++; assert.equal(name, "delete_live_lead_import"); assert.equal(args.sheet_id, id);
          return failure ? { error: { message: "Delete failed" } } : { data: 17, error: null };
        } } };
      } },
    });
    const response = await route.DELETE(new Request("http://localhost/api/leads/imports/id", { method: "DELETE" }), { params: Promise.resolve({ id }) });
    assert.equal(response.status, expected);
    assert.equal(writes, expected === 403 ? 0 : 1);
    if (expected === 200) assert.deepEqual(await response.json(), { deleted: 17 });
  }
});

test("import PDF contains the sheet name and exact total, duplicate, imported and unprocessed counts", async () => {
  const pdfLib = require("pdf-lib");
  const report = {};
  const source = readFileSync(join(__dirname, "..", "src", "lib", "lead-import-report.ts"), "utf8");
  new Function("exports", "require", ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText)(report, require);
  const bytes = await report.createLeadImportPdf({
    id: "00000000-0000-4000-8000-000000000001", filename: "November admissions.xlsx",
    total_rows: 200000, imported_rows: 170000, duplicate_rows: 25000,
    status: "importing", created_at: "2026-11-11T09:00:00Z",
  });
  assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), "%PDF");
  const pdf = await pdfLib.PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getPage(0).getWidth(), 595);
  assert.equal(pdf.getPage(0).getHeight(), 596);
  assert.equal(pdf.getTitle(), "Lead import summary - November admissions.xlsx");
  const streams = pdf.getPage(0).node.Contents();
  const content = Array.from({ length: streams.size() }, (_, index) =>
    Buffer.from(pdfLib.decodePDFRawStream(pdf.context.lookup(streams.get(index))).decode()).toString()).join("\n");
  for (const text of ["November admissions.xlsx", "200,000", "170,000", "25,000", "5,000", "Incomplete", "IMPORT RESULT", "ABOUT THIS IMPORT"]) {
    assert.match(content, new RegExp(Buffer.from(text).toString("hex"), "i"), text);
  }
  for (const [status, label] of [["completed", "Completed"], ["deleted", "Deleted"]]) {
    const longName = "W".repeat(250) + ".xlsx";
    const result = await report.createLeadImportPdf({
      id: "00000000-0000-4000-8000-000000000001", filename: longName,
      total_rows: 6, imported_rows: 3, duplicate_rows: 3, status, created_at: "2026-11-11T09:00:00Z",
    });
    const document = await pdfLib.PDFDocument.load(result);
    assert.equal(document.getPageCount(), 1);
    assert.ok(document.getPage(0).getHeight() > 596, "Long filenames get additional space without overlapping the totals");
    const contents = document.getPage(0).node.Contents();
    const commands = Array.from({ length: contents.size() }, (_, index) =>
      Buffer.from(pdfLib.decodePDFRawStream(document.context.lookup(contents.get(index))).decode()).toString()).join("\n");
    assert.match(commands, new RegExp(Buffer.from(label).toString("hex"), "i"));
    assert.equal(document.getTitle(), `Lead import summary - ${longName}`);
  }
});

test("duplicate lookup includes country code when normalizing phone numbers", async () => {
  let rpcArgs;
  const route = load("src\\app\\api\\leads\\duplicates\\route.ts", {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/server/auth": {
      jsonError: auth.jsonError,
      requireUser: async permission => {
        assert.equal(permission, "leads.create");
        return { supabase: { rpc: async (name, args) => {
          assert.equal(name, "find_live_lead_duplicates");
          rpcArgs = args;
          return { data: [], error: null };
        } } };
      },
    },
    "@/lib/live-leads": {
      dbError: validation.dbError,
      normalizePhone: load("src\\lib\\lead-phone.ts").normalizePhone,
    },
  });
  const request = new Request("https://crm.example/api/leads/duplicates?phone=2345678982&countryCode=India%20%28%2B91%29");
  const response = await route.GET(request);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(rpcArgs)), {
    check_phone: "912345678982",
    check_email: "",
    check_country_code: "India (+91)",
  });
});

test("duplicate rules honor phone/email selection, block/warn/allow and admin confirmation", async () => {
  const config = { duplicateFields: "phone_email", creationPolicy: "block", fields: [] };
  const rows = [
    { normalized_phone: "1234567890", normalized_email: "a@example.test" },
    { normalized_phone: "1234567890", normalized_email: "b@example.test" },
  ];
  assert.equal(validation.duplicateRows(rows, config), true);
  assert.equal(validation.duplicateRows(rows, { ...config, duplicateFields: "email" }), false);
  const client = (decision) => ({ rpc: async (name, input) => {
    assert.equal(name, "check_live_lead_duplicates");
    assert.equal(input.rows_json, rows);
    return { data: decision, error: null };
  } });
  const manager = { profile: { role: "manager" } };
  const admin = { profile: { role: "admin" } };
  await assert.rejects(validation.enforceDuplicatePolicy(client("block"), rows, config, admin, true), /blocked/);
  await assert.rejects(validation.enforceDuplicatePolicy(client("block"), rows, { ...config, creationPolicy: "warn" }, manager, true), /blocked/);
  await assert.rejects(validation.enforceDuplicatePolicy(client("warn"), rows, { ...config, creationPolicy: "warn" }, admin, false), /Duplicate warning:/);
  await validation.enforceDuplicatePolicy(client("warn"), rows, { ...config, creationPolicy: "warn" }, admin, true);
  await validation.enforceDuplicatePolicy(client("clear"), rows, { ...config, creationPolicy: "allow" }, manager, false);
});

test("merge API checks actual permissions and both RLS-scoped leads before the transaction", async () => {
  const source = "30000000-0000-4000-8000-000000000001";
  const target = "30000000-0000-4000-8000-000000000002";
  for (const [permissions, visible, expected] of [
    [[], true, 403], [["leads.view"], false, 404], [["leads.view"], true, 200],
  ]) {
    let merges = 0;
    const route = load("src\\app\\api\\leads\\[id]\\merge\\route.ts", {
      "next/server": { NextResponse: Response }, "@/lib/live-leads": validation,
      "@/lib/server/auth": { ...auth, requireUser: async (permission) => {
        assert.equal(permission, "leads.merge");
        return { user: { permissions }, supabase: { rpc: async (name, input) => {
          assert.equal(name, "merge_live_leads"); assert.equal(input.source_id, source); assert.equal(input.target_id, target);
          merges++; return { data: { id: target }, error: null };
        } } };
      } },
      "@/lib/crm-data": { fetchLead: async () => visible ? { isArchived: false } : null },
    });
    const response = await route.POST(new Request("http://localhost/api/leads/source/merge", { method: "POST", body: JSON.stringify({ targetId: target }) }), { params: Promise.resolve({ id: source }) });
    assert.equal(response.status, expected);
    assert.equal(merges, expected === 200 ? 1 : 0);
  }
});
test("custom fields accept active configuration and preserve existing inactive values only", () => {
  const config = { duplicateFields: "phone_email", creationPolicy: "block", fields: [
    { name: "Centre", active: true, type: "text", options: [] },
    { name: "Program", active: true, type: "dropdown", options: ["Cardiology", "Neurology"] },
    { name: "Legacy", active: false, type: "text", options: [] },
  ] };
  validation.validateCustomFields({ Centre: "Delhi" }, config);
  validation.validateCustomFields({ Program: "Cardiology" }, config);
  validation.validateCustomFields({ Program: "Retired option" }, config, { Program: "Retired option" });
  validation.validateCustomFields({ Legacy: "original" }, config, { Legacy: "original" });
  assert.throws(() => validation.validateCustomFields({ Legacy: "new" }, config), /not active/);
  assert.throws(() => validation.validateCustomFields({ Program: "Retired option" }, config), /valid value/);
  const rows = csv.parseLeadCsv("name,phone,custom:Centre\nStudent,9876543210,Delhi", ["Centre"]);
  assert.equal(rows[0]["custom:Centre"], "Delhi");
  assert.throws(() => csv.parseLeadCsv("name,phone,custom:Legacy\nStudent,9876543210,Delhi", ["Centre"]), /Unknown CSV/);
});

test("active live lead flows never import demo stores or local storage", () => {
  for (const file of [
    "src\\app\\leads\\page.tsx", "src\\components\\leads-workspace.tsx", "src\\app\\leads\\[id]\\page.tsx",
    "src\\app\\leads\\import\\page.tsx", "src\\app\\pipeline\\page.tsx",
    "src\\app\\reports\\page.tsx", "src\\components\\reports-data-provider.tsx",
  ]) assert.doesNotMatch(readFileSync(join(__dirname, "..", file), "utf8"), /@\/lib\/demo|localStorage|useRolePreview/);
});
