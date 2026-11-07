const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

function load(file, mocks = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  new Function("exports", "require", code)(exports, name => name in mocks ? mocks[name] : require(name));
  return exports;
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

test("public invoice URLs do not change the local login origin and reject invalid origins", () => {
  const env = load("src\\lib\\server\\env.ts");
  const priorApp = process.env.NEXT_PUBLIC_APP_URL;
  const priorInvoice = process.env.INVOICE_PUBLIC_URL;
  try {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.INVOICE_PUBLIC_URL = "https://crm.example.com/";
    assert.equal(env.appUrl(), "http://localhost:3000");
    assert.equal(env.appUrl("invoice"), "https://crm.example.com");
    for (const invalid of ["http://crm.example.com", "https://crm.example.com/path", "https://crm.example.com/?key=value", "https://user:password@crm.example.com"])
      { process.env.INVOICE_PUBLIC_URL = invalid; assert.throws(() => env.appUrl("invoice"), /INVOICE_PUBLIC_URL/); }
    delete process.env.INVOICE_PUBLIC_URL;
    assert.equal(env.appUrl("invoice"), "http://localhost:3000");
  } finally {
    if (priorApp === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = priorApp;
    if (priorInvoice === undefined) delete process.env.INVOICE_PUBLIC_URL; else process.env.INVOICE_PUBLIC_URL = priorInvoice;
  }
});

test("installment dates follow India calendar boundaries and four calendar-day terms", () => {
  const api = load("src\\lib\\invoice-schedule.ts");
  assert.equal(api.invoiceDateToday(new Date("2026-12-31T20:00:00Z")), "2027-01-01");
  assert.equal(api.scheduledInvoiceTime("2027-01-01"), "2027-01-01T03:30:00.000Z");
  assert.equal(api.scheduledDueDate("2028-02-27"), "2028-03-02");
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 40].map(api.installmentLabel),
    ["1st installment", "2nd installment", "3rd installment", "4th installment", "11th installment", "12th installment", "13th installment", "21st installment", "22nd installment", "23rd installment", "40th installment"]);
});

test("invoice schedule schema requires a request ID, real dates, positive cents and chronological rows", () => {
  const { invoiceInput } = load("src\\lib\\server\\operational-validation.ts");
  const input = {
    lead_id: "10000000-0000-4000-8000-000000000001", course_id: "20000000-0000-4000-8000-000000000001",
    company_code: "DMHCA", billing_address: "Billing address", payment_type: "installments", due_date: "2027-01-05",
    request_id: "30000000-0000-4000-8000-000000000001",
    installments: [{ amount: 25.25, invoice_date: "2027-01-01" }, { amount: 74.75, invoice_date: "2027-02-01" }],
  };
  assert.equal(invoiceInput.safeParse(input).success, true);
  for (const change of [
    { request_id: undefined }, { installments: [] }, { payment_type: "one_shot" },
    { installments: [{ amount: 0.99, invoice_date: "2027-01-01" }] },
    { installments: [{ amount: 1.001, invoice_date: "2027-01-01" }] },
    { installments: [{ amount: 10, invoice_date: "2027-02-30" }] },
    { installments: [...input.installments].reverse() },
    { installments: Array.from({ length: 37 }, () => input.installments[0]) },
  ]) assert.equal(invoiceInput.safeParse({ ...input, ...change }).success, false, JSON.stringify(change));
});

test("scheduler authenticates before acquiring service credentials and reports unavailable configuration", async () => {
  let acquired = 0, delivered = 0;
  const route = load("src\\app\\api\\cron\\invoices\\route.ts", {
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } },
    "@/lib/server/auth": { HttpError, jsonError: error => ({ status: error.status ?? 500, error: error.message }) },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { acquired++; return {}; } },
    "@/lib/server/invoice-scheduler": { deliverScheduledInvoices: async () => { delivered++; return [{ id: "one", sent: true }, { id: "two", sent: false }]; } },
  });
  const prior = process.env.INVOICE_CRON_SECRET;
  try {
    delete process.env.INVOICE_CRON_SECRET;
    assert.equal((await route.GET(new Request("https://crm.example/api/cron/invoices"))).status, 503);
    process.env.INVOICE_CRON_SECRET = "test-only-scheduler-secret-32-characters";
    for (const authorization of ["", "Bearer wrong", `Basic ${process.env.INVOICE_CRON_SECRET}`]) {
      assert.equal((await route.GET(new Request("https://crm.example/api/cron/invoices", { headers: { authorization } }))).status, 401);
    }
    assert.equal(acquired, 0);
    const result = await route.GET(new Request("https://crm.example/api/cron/invoices", { headers: { authorization: `Bearer ${process.env.INVOICE_CRON_SECRET}` } }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { processed: 2, failed: 1 });
    assert.equal(acquired, 1); assert.equal(delivered, 1);
  } finally {
    if (prior === undefined) delete process.env.INVOICE_CRON_SECRET; else process.env.INVOICE_CRON_SECRET = prior;
  }
});

test("worker reuses guarded delivery and persists failures without dropping the remaining batch", async () => {
  const updates = [], deliveries = [];
  const admin = {
    rpc: async name => {
      assert.equal(name, "operational_release_due_invoices");
      return { data: [{ id: "failed", lead_id: "lead" }, { id: "sent", lead_id: "lead" }], error: null };
    },
    from(table) {
      const query = {
        select() { return query; }, eq() { return query; },
        maybeSingle: async () => ({ data: { id: "lead", name: "Lead", email: "lead@example.com" }, error: null }),
        update(values) { assert.equal(table, "invoices"); updates.push(values); return query; },
        then(resolve) { return Promise.resolve({ error: null }).then(resolve); },
      };
      return query;
    },
  };
  const worker = load("src\\lib\\server\\invoice-scheduler.ts", {
    "@/lib/server/operational": { databaseError: error => { if (error) throw error; } },
    "@/lib/server/invoice-delivery": { deliverInvoice: async (_admin, invoice) => {
      deliveries.push(invoice.id);
      if (invoice.id === "failed") throw new Error("SMTP setup missing");
    } },
  });
  const results = await worker.deliverScheduledInvoices(admin);
  assert.deepEqual(deliveries, ["failed", "sent"]);
  assert.deepEqual(results.map(row => row.sent), [false, true]);
  assert.deepEqual(updates, [{ delivery_error: "SMTP setup missing" }, { delivery_error: null }]);
  await assert.rejects(worker.deliverScheduledInvoices({ rpc: async () => ({ error: new Error("Database unavailable") }) }), /Database unavailable/);
  let claimed;
  await worker.deliverScheduledInvoices({ rpc: async (name, args) => { claimed = { name, args }; return { data: [], error: null }; } }, ["today", "future"]);
  assert.deepEqual(claimed, { name: "operational_release_due_invoices", args: { p_ids: ["today", "future"] } });
  assert.match(worker.invoiceDeliveryMessage(results), /1 invoice email.*1 delivery attempt.*SMTP setup missing/);
});
