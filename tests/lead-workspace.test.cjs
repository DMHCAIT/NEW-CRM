const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const id = "10000000-0000-4000-8000-000000000001";
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fixture({ missingLead = false, denied = false, errorTable, mailboxError = false } = {}) {
  const reads = [];
  let mailboxReads = 0;
  const rows = {
    notes: [{ id: "note", content: "Private note" }],
    emails: [{ id: "email", body: "Private message" }],
    activities: [{ id: "activity", type: "updated" }],
    leads: { custom_fields: {}, call_schedule_revision: 0 },
    scheduled_calls: [],
  };
  const supabase = {
    from(table) {
      const read = { table, filters: [] };
      reads.push(read);
      const query = {
        select(columns, options) { read.columns = columns; read.options = options; return query; },
        eq(key, value) { read.filters.push([key, value]); return query; },
        order() { return query; },
        single() { return query; },
        then(resolve, reject) {
          return Promise.resolve({
            data: read.options?.head ? null : rows[table],
            count: read.options?.count ? 7 : null,
            error: table === errorTable ? new Error(`${table} read failed`) : null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
    rpc: async () => ({ data: [], error: null }),
  };
  const mocks = {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/crm-data": {
      fetchLead: async () => missingLead ? null : { id, isArchived: false },
      fetchProfiles: async () => [], fetchStages: async () => [],
    },
    "@/lib/server/auth": {
      HttpError,
      requireUser: async permission => {
        assert.equal(permission, "leads.view");
        if (denied) throw new HttpError(403, "Permission denied.");
        return { supabase, user: { id: "actor", email: "actor@example.test" } };
      },
      jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
    },
    "@/lib/live-leads": {
      uuid: value => value,
      fetchLeadConfiguration: async () => ({ fields: [] }),
      dbError: error => { if (error) throw error; },
    },
    "@/lib/server/login": {},
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({}) },
    "@/lib/server/operational-gmail": { currentGmailMailbox: async () => {
      mailboxReads++;
      if (mailboxError) throw new Error("Mailbox unavailable.");
      return { email: "actor@example.test" };
    } },
  };
  const source = ts.transpileModule(readFileSync(path.join(__dirname, "..", "src", "app", "api", "leads", "[id]", "route.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const api = {};
  new Function("exports", "require", source)(api, name => mocks[name] ?? require(name));
  return {
    reads, mailboxReads: () => mailboxReads,
    get: suffix => api.GET(new Request(`https://crm.example/api/leads/${id}${suffix}`), { params: Promise.resolve({ id }) }),
  };
}

test("initial overview omits note/email bodies, activity and mailbox work while retaining scoped counts", async () => {
  const f = fixture({ mailboxError: true });
  const response = await f.get("?section=overview");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const data = await response.json();
  assert.deepEqual(data.counts, { notes: 7, emails: 7 });
  assert.deepEqual(data.notes, []);
  assert.deepEqual(data.emails, []);
  assert.deepEqual(data.activities, []);
  assert.equal(f.mailboxReads(), 0);
  assert.ok(!f.reads.some(read => read.table === "activities"));
  for (const table of ["notes", "emails"]) {
    const read = f.reads.find(read => read.table === table);
    assert.deepEqual(read.options, { count: "exact", head: true });
    assert.deepEqual(read.filters, [["lead_id", id]]);
  }
});

test("related sections fetch only the requested history and resolve Gmail only for Emails", async () => {
  for (const section of ["note", "email", "calls", "invoices", "courses"]) {
    const f = fixture();
    const data = await (await f.get(`?section=${section}`)).json();
    assert.equal(data.notes.length, section === "note" ? 1 : 0);
    assert.equal(data.emails.length, section === "email" ? 1 : 0);
    assert.equal(data.activities.length, 0);
    assert.equal(f.mailboxReads(), section === "email" ? 1 : 0);
    for (const read of f.reads.filter(read => ["notes", "emails", "scheduled_calls"].includes(read.table))) {
      assert.ok(read.filters.some(([key, value]) => key === "lead_id" && value === id));
    }
  }
});

test("record and call timelines explicitly opt in to activity reads", async () => {
  for (const section of ["overview", "calls"]) {
    const f = fixture();
    const data = await (await f.get(`?section=${section}&history=1`)).json();
    assert.equal(data.activities.length, 1);
    assert.equal(f.mailboxReads(), 0);
  }
});

test("legacy detail requests preserve all histories and mailbox information", async () => {
  const f = fixture();
  const data = await (await f.get("")).json();
  assert.equal(data.notes.length, 1);
  assert.equal(data.emails.length, 1);
  assert.equal(data.activities.length, 1);
  assert.equal(f.mailboxReads(), 1);
});

test("invalid sections, inaccessible leads and denied permissions do not run related queries", async () => {
  for (const [options, suffix, status] of [
    [{}, "?section=invalid", 400],
    [{ missingLead: true }, "?section=overview", 404],
    [{ denied: true }, "?section=email", 403],
  ]) {
    const f = fixture(options);
    assert.equal((await f.get(suffix)).status, status);
    assert.equal(f.reads.length, 0);
    assert.equal(f.mailboxReads(), 0);
  }
});

test("count, history and mailbox failures remain visible errors rather than empty success responses", async () => {
  for (const [options, section] of [
    [{ errorTable: "notes" }, "overview"],
    [{ errorTable: "activities" }, "calls&history=1"],
    [{ errorTable: "emails" }, "email"],
    [{ mailboxError: true }, "email"],
  ]) {
    const f = fixture(options);
    const response = await f.get(`?section=${section}`);
    assert.equal(response.status, 500);
    assert.ok((await response.json()).error);
  }
});
