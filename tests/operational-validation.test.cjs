const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = readFileSync(join(__dirname, "..", "src", "lib", "server", "operational-validation.ts"), "utf8");
const api = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText, { exports: api, require, Date, Number });
const invoice = {
  lead_id: "8c5b3271-8bdc-4ccc-9d40-8c741505bb98", description: "Consultation",
  quantity: "2", unit_price: "100.25", tax_amount: "10", discount_percent: "0", due_date: "2026-11-01",
};

test("invoice validates actual amounts, dates and mandatory discount reason", () => {
  const valid = api.invoiceInput.parse(invoice);
  assert.equal(api.invoiceTotals(valid).total, 210.5);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, discount_percent: 101, discount_reason: "too much" }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, discount_percent: 10 }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, quantity: -1 }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, unit_price: "Infinity" }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, unit_price: "10.001" }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, quantity: "1.001" }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, quantity: 10000, unit_price: 99999999 }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, due_date: "2026-02-31" }).success, false);
  const discounted = api.invoiceInput.parse({ ...invoice, discount_percent: 10, discount_reason: "Approved promotion" });
  assert.equal(api.invoiceTotals(discounted).total, 190.45);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, payment_type: "installments", course_total: 100 }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, payment_type: "invalid" }).success, false);
  assert.equal(api.invoiceInput.safeParse({ ...invoice, payment_type: "emi", discount_reason: "not a discount" }).success, false);
});

test("meeting requires a real supported provider and a future time", () => {
  const meeting = { title: "Consultation", duration_min: "30", provider: "internal", attendee_ids: ["8c5b3271-8bdc-4ccc-9d40-8c741505bb98"], start_at: new Date(Date.now() + 3600000).toISOString() };
  assert.equal(api.meetingInput.safeParse(meeting).success, true);
  assert.equal(api.meetingInput.safeParse({ ...meeting, lead_id: "8c5b3271-8bdc-4ccc-9d40-8c741505bb98" }).success, false);
  assert.equal(api.meetingInput.safeParse({ ...meeting, provider: "zoom", duration_min: 40 }).success, true);
  assert.equal(api.meetingInput.safeParse({ ...meeting, provider: "zoom", duration_min: 41 }).success, false);
  for (const change of [{ provider: "demo" }, { duration_min: 0 }, { duration_min: 600 }, { start_at: "2020-01-01T00:00:00Z" }]) {
    assert.equal(api.meetingInput.safeParse({ ...meeting, ...change }).success, false);
  }
});

test("automation rejects unimplemented triggers and actions", () => {
  const rule = { name: "Reminder", trigger: "manual", action: "notify_me", days: 1, is_active: false };
  assert.equal(api.automationInput.safeParse(rule).success, true);
  for (const change of [{ trigger: "lead_created" }, { action: "send_email" }, { action: "round_robin" }, { days: -1 }]) {
    assert.equal(api.automationInput.safeParse({ ...rule, ...change }).success, false);
  }
});
