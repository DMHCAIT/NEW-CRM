const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { z } = require("zod");

const leadId = "10000000-0000-4000-8000-000000000001";
function load(relative, mocks) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(path.join(__dirname, "..", relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  new Function("exports", "require", source)(exports, name => name in mocks ? mocks[name] : require(name));
  return exports;
}
function fixture({ denied = false, profileError = false, originAllowed = true, beforeRead = (_name, value) => Promise.resolve(value) } = {}) {
  const calls = [];
  const supabase = {
    from(table) {
      calls.push(["from", table]);
      const result = { data: table === "profiles" ? [{ id: "actor", full_name: "Counselor" }] : [{ id: "invoice", lead_id: leadId, payment_type: "one_shot" }], error: table === "profiles" && profileError ? new Error("Profile query failed") : null };
      const query = {
        select(value) { calls.push(["select", value]); return query; },
        eq(key, value) { calls.push(["eq", key, value]); return query; },
        in(key, value) { calls.push(["in", key, value]); return query; },
        order(key) { calls.push(["order", key]); return query; },
        maybeSingle() { return Promise.resolve({ data: { id: "new-invoice", status: "pending_approval" }, error: null }); },
        limit(value) { calls.push(["limit", value]); return beforeRead(table, result); },
        then(resolve, reject) { return beforeRead(table, result).then(resolve, reject); },
      };
      return query;
    },
    rpc: async (name, args) => { calls.push(["rpc", name, args]); return { data: "new-invoice", error: null }; },
  };
  const mocks = {
    "@/lib/server/integration-settings": { integrationStatus: provider => beforeRead(provider, { configured: true, missing: [], required: [] }) },
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } },
    "@/lib/server/auth": {
      requireUser: async permission => { calls.push(["permission", permission]); return { supabase, user: { id: "actor", permissions: ["invoices.create"] } }; },
      jsonError: error => ({ status: 400, error: error.message }),
      readJson: request => request.json(),
    },
    "@/lib/server/operational": {
      uuid: z.string().uuid(), parseInput: (schema, value) => schema.parse(value),
      accessibleLead: async (_client, id) => { calls.push(["lead", id]); if (denied) throw new Error("Lead not accessible"); return { id, name: "Lead name" }; },
      databaseError: error => { if (error) throw error; },
      configurationStatus: () => ({ configured: true, missing: [] }),
      integrationRequirements: { smtp: [], razorpay: [] },
      leadOptions: () => { calls.push(["leadOptions"]); return beforeRead("leads", [{ id: leadId, name: "Lead name" }]); },
    },
    "@/lib/server/operational-validation": { invoiceInput: z.object({ lead_id: z.string().uuid() }) },
    "@/lib/server/login": { checkOrigin: () => { calls.push(["origin"]); if (!originAllowed) throw new Error("Request origin is not allowed."); } },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => supabase },
    "@/lib/server/razorpay": {},
    "@/lib/server/mailer": {},
    "@/lib/server/invoice-delivery": { deliverInvoice: async () => ({ messageId: "message" }), sendPaymentReceipt: async () => "receipt" },
  };
  return { calls, route: load("src\\app\\api\\invoices\\route.ts", mocks), detail: load("src\\app\\api\\invoices\\[id]\\route.ts", mocks) };
}
test("lead invoices validate access and filter in the database before the latest-200 limit", async () => {
  const { route, calls } = fixture();
  const result = await route.GET(new Request(`https://crm.example/api/invoices?leadId=${leadId}`));
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.leads, [{ id: leadId, name: "Lead name" }]);
  assert.deepEqual(result.data.profiles, [{ id: "actor", full_name: "Counselor" }]);
  assert.equal(result.data.canCreate, true);
  assert.equal(result.data.canApprove, false);
  assert.ok(calls.findIndex(call => call[0] === "lead") < calls.findIndex(call => call[0] === "from"));
  assert.ok(calls.findIndex(call => call[0] === "eq") < calls.findIndex(call => call[0] === "limit"));
  assert.ok(calls.some(call => call[0] === "eq" && call[1] === "lead_id" && call[2] === leadId));
  assert.ok(!calls.some(call => call[0] === "leadOptions"));
});
test("global invoices preserve RLS-scoped listing and accessible lead choices", async () => {
  const { route, calls } = fixture();
  assert.equal((await route.GET(new Request("https://crm.example/api/invoices"))).status, 200);
  assert.ok(calls.some(call => call[0] === "leadOptions"));
  assert.ok(!calls.some(call => call[0] === "eq"));
  assert.deepEqual(calls[0], ["permission", "invoices.view"]);
});
test("invalid, empty or hidden lead filters never fall back to the global register", async () => {
  for (const suffix of ["", "not-a-uuid", leadId]) {
    const { route, calls } = fixture({ denied: suffix === leadId });
    const response = await route.GET(new Request(`https://crm.example/api/invoices?leadId=${suffix}`));
    assert.equal(response.status, 400);
    assert.ok(!calls.some(call => call[0] === "from"));
  }
});
test("invoice actor lookup errors are surfaced rather than silently hidden", async () => {
  const { route } = fixture({ profileError: true });
  assert.equal((await route.GET(new Request("https://crm.example/api/invoices"))).error, "Profile query failed");
});

test("independent invoice reads start together and all must finish before returning", async () => {
  const pending = new Map();
  const { route } = fixture({ beforeRead: (name, value) => {
    if (pending.has(name)) return Promise.resolve(value);
    return new Promise(resolve => pending.set(name, () => resolve(value)));
  } });
  let finished = false;
  const response = route.GET(new Request("https://crm.example/api/invoices")).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...pending.keys()].sort(), ["invoices", "leads", "profiles", "razorpay", "smtp"]);
  for (const [name, release] of pending) if (name !== "smtp") release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  pending.get("smtp")();
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal(result.data.invoices.length, 1);
  assert.equal(result.data.smtp.configured, true);
});
test("invoice creation rechecks accessible lead and uses the existing creation RPC", async () => {
  const { route, calls } = fixture();
  const response = await route.POST(new Request("https://crm.example/api/invoices", { method: "POST", body: JSON.stringify({ lead_id: leadId }) }));
  assert.equal(response.status, 201);
  assert.deepEqual(calls[0], ["origin"]);
  assert.ok(calls.some(call => call[0] === "permission" && call[1] === "invoices.create"));
  assert.ok(calls.findIndex(call => call[0] === "lead") < calls.findIndex(call => call[0] === "rpc"));
  assert.deepEqual(calls.find(call => call[0] === "rpc"), ["rpc", "operational_create_invoice", { p_input: { lead_id: leadId } }]);
});
test("invoice mutations reject disallowed origins before database or provider actions", async () => {
  const { route, detail, calls } = fixture({ originAllowed: false });
  assert.match((await route.POST(new Request("https://crm.example/api/invoices", { method: "POST" }))).error, /origin/);
  assert.match((await detail.PATCH(new Request("https://crm.example/api/invoices/1", { method: "PATCH" }), { params: Promise.resolve({ id: leadId }) })).error, /origin/);
  assert.deepEqual(calls, [["origin"], ["origin"]]);
});
