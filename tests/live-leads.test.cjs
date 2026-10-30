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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, require: (name) => name in dependencies ? dependencies[name] : name === "@/lib/server/login" ? { checkOrigin: () => {} } : require(name),
    Date, Set, Response, Buffer, console,
  });
  return exports;
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const auth = {
  HttpError,
  readJson: (request) => request.json(),
  jsonError: (error) => Response.json({ error: error.message }, { status: error.status ?? 500 }),
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
  let updated;
  const route = load("src\\app\\api\\leads\\[id]\\route.ts", {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({
      user: { id: "editor", permissions: ["leads.edit"] },
      supabase: { from() {
        const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: { custom_fields: { Existing: "kept" } }, error: null }),
          update: row => { updated = row; return chain; }, maybeSingle: async () => ({ data: { id: "lead" }, error: null }) };
        return chain;
      } },
    }) },
    "@/lib/crm-data": { fetchLead: async () => ({ ...validLead, country: "", course: "", qualification: "", source: "Website", closureFee: 0 }) },
    "@/lib/live-leads": { ...validation, uuid: value => value, fetchLeadConfiguration: async () => ({ fields: [{ name: "New field", active: true, type: "text" }] }) },
    "@/lib/supabase/server": {},
  });
  async function patch(body) {
    return route.PATCH(new Request("https://crm.example/api/leads/id", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "lead" }) });
  }
  assert.equal((await patch({ name: "Changed" })).status, 200);
  assert.deepEqual(Object.keys(updated).sort(), ["modified_by", "name"]);
  assert.equal((await patch({ email: "new@example.com" })).status, 200);
  assert.deepEqual(Object.keys(updated).sort(), ["email", "modified_by", "normalized_email"]);
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
      "@/lib/crm-data": { fetchLead: async () => ({ ...validLead, country: "", course: "", qualification: "", source: "Website", closureFee: 0 }), fetchStages: async () => [{ id: stageId }] },
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
    `name,phone\n${"A,9876543210\n".repeat(1001)}`,
  ]) assert.throws(() => csv.parseLeadCsv(source));
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

test("import refuses create bypass, duplicate file rows and assignment bypass", async () => {
  for (const [permissions, rows, status] of [
    [[], [validLead], 403],
    [["leads.create"], [validLead, validLead], 409],
    [["leads.create"], [{ ...validLead, assigneeId: "00000000-0000-4000-8000-000000000002" }], 400],
  ]) {
    let writes = 0;
    const route = load("src\\app\\api\\leads\\import\\route.ts", {
      "next/server": { NextResponse: Response }, "@/lib/live-leads": validation,
      "@/lib/server/auth": { ...auth, requireUser: async (permission) => {
        assert.equal(permission, "leads.import");
        return { user: { id: "00000000-0000-4000-8000-000000000001", permissions }, supabase: {
          rpc: async (name) => {
            if (name === "check_live_lead_duplicates") return { data: "block", error: null };
            writes++;
          },
          from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { value: {} }, error: null }) }) }) }),
        } };
      } },
    });

    const response = await route.POST(new Request("http://localhost/api/leads/import", { method: "POST", body: JSON.stringify({ rows }) }));
    assert.equal(response.status, status);
    assert.equal(writes, 0);
  }
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
    "src\\app\\leads\\page.tsx", "src\\app\\leads\\[id]\\page.tsx",
    "src\\app\\leads\\import\\page.tsx", "src\\app\\pipeline\\page.tsx",
    "src\\app\\reports\\page.tsx", "src\\components\\reports-data-provider.tsx",
  ]) assert.doesNotMatch(readFileSync(join(__dirname, "..", file), "utf8"), /@\/lib\/demo|localStorage|useRolePreview/);
});
