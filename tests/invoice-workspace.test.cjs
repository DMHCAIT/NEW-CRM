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
function fixture({ denied = false, profileError = false, originAllowed = true, invoiceRows, role = "counselor", invoiceSchema, singleInvoice, issuedInvoice, invoiceById, assigneeId, verificationError, receiptError, deliveries = [], deliveryError, rpcData = "new-invoice", rpcError = null, beforeRead = (_name, value) => Promise.resolve(value) } = {}) {
  const calls = [];
  let decided = false;
  const supabase = {
    from(table) {
      calls.push(["from", table]);
      let lookupId;
      const result = { data: table === "profiles" ? [{ id: "actor", full_name: "Counselor" }] : invoiceRows ?? [{ id: "invoice", lead_id: leadId, payment_type: "one_shot" }], error: table === "profiles" && profileError ? new Error("Profile query failed") : null };
      const query = {
        select(value) { calls.push(["select", value]); return query; },
        eq(key, value) { calls.push(["eq", key, value]); if (key === "id") lookupId = value; return query; },
        in(key, value) { calls.push(["in", key, value]); return query; },
        order(key) { calls.push(["order", key]); return query; },
        maybeSingle() { return Promise.resolve({ data: decided && issuedInvoice ? issuedInvoice : invoiceById ? invoiceById[lookupId] ?? null : singleInvoice ?? { id: "new-invoice", status: "pending_approval" }, error: null }); },
        limit(value) { calls.push(["limit", value]); return beforeRead(table, {...result,data:result.data.slice(0,value)}); },
        range(start,end) { calls.push(["range",start,end]);return beforeRead(table,{...result,data:result.data.slice(start,end+1)}); },
        then(resolve, reject) { return beforeRead(table, result).then(resolve, reject); },
      };
      return query;
    },
    rpc: async (name, args) => { calls.push(["rpc", name, args]); if (name === "operational_decide_invoice" && !rpcError) decided = true; return { data: rpcData, error: rpcError }; },
  };
  const mocks = {
    "@/lib/server/integration-settings": { integrationStatus: provider => beforeRead(provider, { configured: true, missing: [], required: [] }) },
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } },
    "@/lib/server/auth": {
      requireUser: async permission => { calls.push(["permission", permission]); return { supabase, user: { id: "actor", profile: { role }, permissions: ["invoices.create","invoices.approve"] } }; },
      jsonError: error => ({ status: error.status ?? 400, error: error.message }),
      readJson: request => request.json(), HttpError: class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } },
    },
    "@/lib/server/operational": {
      uuid: z.string().uuid(), parseInput: (schema, value) => schema.parse(value),
      accessibleLead: async (_client, id) => { calls.push(["lead", id]); if (denied) throw new Error("Lead not accessible"); return { id, name: "Lead name", assignee_id: assigneeId }; },
      databaseError: error => { if (error) throw error; },
      configurationStatus: () => ({ configured: true, missing: [] }),
      integrationRequirements: { smtp: [], razorpay: [] },
      leadOptions: () => { calls.push(["leadOptions"]); return beforeRead("leads", [{ id: leadId, name: "Lead name" }]); },
    },
    "@/lib/server/operational-validation": { invoiceInput: invoiceSchema ?? z.object({ lead_id: z.string().uuid() }) },
    "@/lib/server/login": { checkOrigin: () => { calls.push(["origin"]); if (!originAllowed) throw new Error("Request origin is not allowed."); } },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => supabase },
    "@/lib/server/razorpay": {},
    "@/lib/server/mailer": {},
    "@/lib/server/invoice-delivery": { deliverInvoice: async (_admin, invoice, lead, creatorEmail) => {
      calls.push(["deliverInvoice", invoice.id, lead.id, creatorEmail]);
      if (deliveryError) throw deliveryError;
      return { messageId: "message" };
    }, sendPaymentReceipt: async () => { if (receiptError) throw receiptError; return "receipt"; } },
    "@/lib/server/invoice-scheduler": {
      deliverScheduledInvoices: async (_admin, ids) => { calls.push(["deliverScheduled", ids]); if (deliveryError) throw deliveryError; return deliveries; },
      invoiceDeliveryMessage: results => `${results.filter(row => row.sent).length} invoice email(s) accepted by SMTP. Future-dated invoices remain scheduled.`,
    },
    "@/lib/server/invoice-payment-verification": {
      verifyInvoicePaymentUrl: async (invoice, url) => { calls.push(["verify", invoice.id, url]); if (verificationError) throw verificationError; return { provider: "razorpay", paymentId: "pay_test", linkId: "plink_test", amount: 10000, currency: "INR", url }; },
      verifySavedInvoicePayment: async () => { throw new Error("No saved payment link"); },
    },
    "@/lib/server/invoice-link-cancellation": { cancelInvoicePaymentLinks: async () => { calls.push(["cancelLinks"]); } },
    "@/lib/invoice-policy": load("src\\lib\\invoice-policy.ts",{}),
  };
  mocks["@/lib/server/invoice-payment-url"] = load("src\\lib\\server\\invoice-payment-url.ts", {
    "@/lib/invoice-policy": mocks["@/lib/invoice-policy"],
    "@/lib/server/auth": mocks["@/lib/server/auth"],
    "@/lib/server/env": { appUrl: () => "https://invoices.example.com" },
    "@/lib/server/integration-settings": { decryptIntegrationValues: () => ({ token: "saved-token" }) },
  });
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
test("CRM payment URLs use the live public invoice and disappear after payment or when unavailable", async () => {
  for (const payment_type of ["one_shot", "installments"]) {
    for (const currency of ["INR", "USD"]) {
      const invoice = { id: "payable", lead_id: leadId, payment_type, currency, status: "sent", total: 125,
        course_total: 1000, created_at: new Date().toISOString(), status_token_encrypted: "encrypted" };
      const { route } = fixture({ invoiceRows: [invoice] });
      const read = () => route.GET(new Request("https://crm.example/api/invoices"));
      assert.equal((await read()).data.invoices[0].payment_url, "https://invoices.example.com/api/invoice-status/saved-token/pay");
      for (const status of ["paid", "scheduled", "pending_approval", "cancelled", "rejected", "expired"]) {
        invoice.status = status;
        assert.equal((await read()).data.invoices[0].payment_url, null, status);
      }
      invoice.status = "sent"; invoice.tax_review_required = true;
      assert.equal((await read()).data.invoices[0].payment_url, null);
    }
  }
});
test("the register fetches every invoice batch and does not hide records after the latest 200",async()=>{
  const invoiceRows=Array.from({length:401},(_,index)=>({id:`invoice-${index}`,lead_id:leadId,payment_type:"one_shot"}));
  const {route,calls}=fixture({invoiceRows,role:"admin"});
  const result=await route.GET(new Request("https://crm.example/api/invoices"));
  assert.equal(result.status,200);
  assert.equal(result.data.invoices.length,401);
  assert.equal(result.data.canApprove,true);
  assert.deepEqual(calls.filter(call=>call[0]==="range"),[["range",200,399],["range",400,599]]);
});
test("installment balances subtract only paid invoices and expose blockers plus frozen course pricing",async()=>{
  const root={id:"root",invoice_no:"INV-ROOT",lead_id:leadId,course_id:"course",company_code:"DMHCA",
    payment_type:"installments",parent_invoice_id:null,status:"paid",currency:"INR",total:100,course_total:300,
    enrollment_subtotal:300,enrollment_discount:0,enrollment_tax:0,enrollment_tax_percent:0,discount_percent:0};
  const {route}=fixture({invoiceRows:[root,{...root,id:"next",parent_invoice_id:"root",status:"sent",total:75}]});
  const result=await route.GET(new Request("https://crm.example/api/invoices"));
  assert.equal(result.data.courseBalances.root,200);
  assert.equal(result.data.courseBalances.next,200,"awaiting payment is not money received");
  assert.equal(result.data.installmentParents[0].pending,true);
  assert.equal(result.data.installmentParents[0].next_installment,3);
  assert.equal(result.data.installmentParents[0].available_balance,125);
  assert.equal(result.data.installmentParents[0].enrollment_subtotal,300);
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
  assert.deepEqual([...pending.keys()].sort(), ["invoices", "leads", "profiles", "razorpay", "smtp", "stripe"]);
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
test("saving an issued invoice sends automatically while discounted invoices wait for approval", async () => {
  for (const status of ["sent", "pending_approval"]) {
    const { route, calls } = fixture({ singleInvoice: { id: "new-invoice", lead_id: leadId, status } });
    const result = await route.POST(new Request("https://crm.example/api/invoices", { method: "POST", body: JSON.stringify({ lead_id: leadId }) }));
    assert.equal(result.status, 201);
    assert.equal(result.data.id, "new-invoice");
    assert.equal(calls.some(call => call[0] === "deliverInvoice"), status === "sent");
    assert.equal(result.data.delivery.sent, status === "sent");
    assert.equal(result.data.warning, undefined);
  }
});
test("saving preserves the CRM invoice and returns a warning when automatic email fails", async () => {
  const { route } = fixture({ singleInvoice: { id: "new-invoice", lead_id: leadId, status: "sent" }, deliveryError: new Error("SMTP unavailable") });
  const result = await route.POST(new Request("https://crm.example/api/invoices", { method: "POST", body: JSON.stringify({ lead_id: leadId }) }));
  assert.equal(result.status, 201);
  assert.equal(result.data.id, "new-invoice");
  assert.equal(result.data.delivery.sent, false);
  assert.match(result.data.warning, /automatic delivery failed: SMTP unavailable/);
});
test("discount approval sends the issued invoice without a second email action", async () => {
  const { detail, calls } = fixture({ role: "admin",
    singleInvoice: { id: leadId, lead_id: leadId, status: "pending_approval" },
    issuedInvoice: { id: leadId, lead_id: leadId, status: "sent", creator_email: "creator@example.com" } });
  const result = await detail.PATCH(new Request(`https://crm.example/api/invoices/${leadId}`, {
    method: "PATCH", body: JSON.stringify({ action: "approve" }),
  }), { params: Promise.resolve({ id: leadId }) });
  assert.equal(result.status, 200);
  assert.ok(calls.findIndex(call => call[0] === "rpc") < calls.findIndex(call => call[0] === "deliverInvoice"));
  assert.equal(calls.filter(call => call[0] === "deliverInvoice").length, 1);
  assert.match(result.data.message, /email accepted by SMTP.*current lead owner/);
});
test("invoice mutations reject disallowed origins before database or provider actions", async () => {
  const { route, detail, calls } = fixture({ originAllowed: false });
  assert.match((await route.POST(new Request("https://crm.example/api/invoices", { method: "POST" }))).error, /origin/);
  assert.match((await detail.PATCH(new Request("https://crm.example/api/invoices/1", { method: "PATCH" }), { params: Promise.resolve({ id: leadId }) })).error, /origin/);
  assert.deepEqual(calls, [["origin"], ["origin"]]);
});

test("installment creation submits the entire plan atomically without sending future invoices inline", async () => {
  const invoiceSchema = load("src\\lib\\server\\operational-validation.ts", {}).invoiceInput;
  const input = { lead_id: leadId, course_id: "20000000-0000-4000-8000-000000000001", company_code: "DMHCA",
    billing_address: "Address", payment_type: "installments", request_id: "30000000-0000-4000-8000-000000000001",
    due_date: "2027-01-05", installments: [{ amount: 100, invoice_date: "2027-01-01" }] };
  const { route, calls } = fixture({ invoiceSchema, rpcData: ["scheduled-invoice"] });
  const result = await route.POST(new Request("https://crm.example/api/invoices", { method: "POST", body: JSON.stringify(input) }));
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.ids, ["scheduled-invoice"]);
  assert.equal(calls.find(call => call[0] === "rpc")[1], "operational_create_installment_plan");
  assert.deepEqual(calls.find(call => call[0] === "deliverScheduled"), ["deliverScheduled", ["scheduled-invoice"]]);
  assert.equal(calls.some(call => call[0] === "from"), false, "future delivery belongs to the scheduler");
  const denied = fixture({ invoiceSchema, denied: true });
  assert.equal((await denied.route.POST(new Request("https://crm.example/api/invoices", { method: "POST", body: JSON.stringify(input) }))).status, 400);
  assert.equal(denied.calls.some(call => call[0] === "rpc"), false);
});

test("saving today's installments attempts targeted delivery and preserves saved IDs on delivery errors", async () => {
  const invoiceSchema = z.object({ lead_id: z.string().uuid(), payment_type: z.literal("installments") });
  const request = () => new Request("https://crm.example/api/invoices", { method: "POST", body: JSON.stringify({ lead_id: leadId, payment_type: "installments" }) });
  const successful = fixture({ invoiceSchema, rpcData: ["today", "future"], deliveries: [{ id: "today", sent: true }] });
  const sent = await successful.route.POST(request());
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.data.deliveries, [{ id: "today", sent: true }]);
  assert.match(sent.data.message, /1 invoice email.*accepted by SMTP/);
  assert.deepEqual(successful.calls.find(call => call[0] === "deliverScheduled"), ["deliverScheduled", ["today", "future"]]);
  const failed = fixture({ invoiceSchema, rpcData: ["saved"], deliveryError: new Error("Delivery claim failed") });
  const result = await failed.route.POST(request());
  assert.equal(result.status, 201);
  assert.deepEqual(result.data.ids, ["saved"]);
  assert.match(result.data.message, /saved, but automatic delivery failed: Delivery claim failed/);
});

test("approving a scheduled enrollment sends eligible installments without sending unrelated invoices", async () => {
  const { detail, calls } = fixture({ role: "admin", invoiceRows: [{ id: "child" }],
    singleInvoice: { id: leadId, status: "pending_approval", lead_id: leadId },
    issuedInvoice: { id: leadId, status: "scheduled", lead_id: leadId },
    deliveries: [{ id: leadId, sent: true }],
  });
  const body = new Request("https://crm.example/api/invoices/" + leadId, { method: "PATCH", body: JSON.stringify({ action: "approve" }) });
  const result = await detail.PATCH(body, { params: Promise.resolve({ id: leadId }) });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.find(call => call[0] === "deliverScheduled"), ["deliverScheduled", [leadId, "child"]]);
  assert.match(result.data.message, /Enrollment discount approved.*1 invoice email/);
  assert.ok(calls.some(call => call[0] === "eq" && call[1] === "parent_invoice_id" && call[2] === leadId));
});

test("closing an expired unapproved enrollment rejects its single approval and cancels future installments", async () => {
  const { detail, calls } = fixture({ role: "admin", singleInvoice: {
    id: leadId, status: "pending_approval", scheduled_for: "2020-01-01T03:30:00Z",
    parent_invoice_id: null, payment_expires_at: "2020-01-05T03:30:00Z",
  } });
  const result = await detail.PATCH(new Request(`https://crm.example/api/invoices/${leadId}`, {
    method: "PATCH", body: JSON.stringify({ action: "close_expired" }),
  }), { params: Promise.resolve({ id: leadId }) });
  assert.equal(result.status, 200);
  assert.match(result.data.message, /scheduled installments cancelled/);
  assert.equal(calls.find(call => call[0] === "rpc")[2].p_decision, "rejected");
});

test("course schedules and balances group only the original enrollment and retain fully paid courses", async () => {
  const root = { id: "root", invoice_no: "INV-ROOT", lead_id: leadId, payment_type: "installments", course_id: "course-a",
    course_total: 300, total: 100, status: "paid", created_at: "2026-01-01", installment_number: 1,
    invoice_items: [{ description: "Course A" }], lead: { assignee_id: "actor" }, created_by: "someone-else" };
  const child = { ...root, id: "child", parent_invoice_id: root.id, installment_number: 2, status: "scheduled", total: 50 };
  const other = { ...root, id: "other", course_id: "course-b", course_total: 100, invoice_items: [{ description: "Course B" }] };
  const { route } = fixture({ invoiceRows: [child, other, root] });
  const result = await route.GET(new Request("https://crm.example/api/invoices"));
  const a = result.data.installmentParents.find(row => row.id === root.id);
  const b = result.data.installmentParents.find(row => row.id === other.id);
  assert.deepEqual(a.installments.map(row => row.id), ["root", "child"]);
  assert.equal(a.balance, 200);
  assert.equal(a.available_balance, 150);
  assert.equal(a.course_name, "Course A");
  assert.equal(b.balance, 0);
  assert.equal(b.available_balance, 0);
  assert.equal(result.data.invoices.find(row => row.id === "root").can_reconcile_payment, true, "current owner may reconcile an older creator's invoice");
});

test("verified link recording supports scheduled installments and expired full-payment invoices for their current lead owner", async () => {
  for (const [status, payment_type] of [["scheduled", "installments"], ["expired", "installments"], ["expired", "one_shot"]]) {
    const invoice = { id: leadId, lead_id: leadId, status, payment_type, created_by: "previous-owner" };
    const { detail, calls } = fixture({ singleInvoice: invoice, assigneeId: "actor", rpcData: true });
    const result = await detail.PATCH(new Request(`https://crm.example/api/invoices/${leadId}`, {
      method: "PATCH", body: JSON.stringify({ action: "verify_payment_url", url: "https://rzp.io/i/payment" }),
    }), { params: Promise.resolve({ id: leadId }) });
    assert.equal(result.status, 200);
    assert.match(result.data.message, /Invoice is paid/);
    assert.ok(calls.findIndex(call => call[0] === "verify") < calls.findIndex(call => call[0] === "rpc"));
    assert.equal(calls.find(call => call[0] === "rpc")[1], "operational_record_verified_url");
  }
});

test("unrelated users and unapproved enrollments cannot reach payment providers or recording RPCs", async () => {
  const invoice = { id: leadId, lead_id: leadId, status: "scheduled", payment_type: "installments", created_by: "someone-else" };
  for (const options of [
    { singleInvoice: invoice, assigneeId: "another-owner" },
    { singleInvoice: { ...invoice, created_by: "actor", tax_review_required: true } },
    { singleInvoice: { ...invoice, created_by: "actor", status: "pending_approval" } },
    { invoiceById: { [leadId]: { ...invoice, created_by: "actor", parent_invoice_id: "root" }, root: { id: "root", status: "pending_approval" } } },
  ]) {
    const { detail, calls } = fixture(options);
    const result = await detail.PATCH(new Request(`https://crm.example/api/invoices/${leadId}`, {
      method: "PATCH", body: JSON.stringify({ action: "verify_payment_url", url: "https://rzp.io/i/payment" }),
    }), { params: Promise.resolve({ id: leadId }) });
    assert.ok([403, 409].includes(result.status));
    assert.equal(calls.some(call => call[0] === "verify" || call[0] === "rpc"), false);
  }
});

test("failed payment verification never records money and receipt failures do not undo a verified payment", async () => {
  const invoice = { id: leadId, status: "sent", payment_type: "one_shot", created_by: "actor" };
  const failed = fixture({ singleInvoice: invoice, verificationError: new Error("Provider has not captured payment") });
  const request = () => new Request(`https://crm.example/api/invoices/${leadId}`, { method: "PATCH",
    body: JSON.stringify({ action: "verify_payment_url", url: "https://rzp.io/i/payment" }) });
  assert.equal((await failed.detail.PATCH(request(), { params: Promise.resolve({ id: leadId }) })).status, 400);
  assert.equal(failed.calls.some(call => call[0] === "rpc"), false);
  const receiptFailed = fixture({ singleInvoice: invoice, rpcData: true, receiptError: new Error("SMTP unavailable") });
  const result = await receiptFailed.detail.PATCH(request(), { params: Promise.resolve({ id: leadId }) });
  assert.equal(result.status, 200);
  assert.match(result.data.message, /invoice is paid, but receipt delivery failed/);
});
