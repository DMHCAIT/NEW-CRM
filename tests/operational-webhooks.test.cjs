const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createHmac } = require("node:crypto");

function load(relativePath, mocks, overrides = {}) {
  mocks = { "@/lib/server/integration-settings": {
    getIntegrationConfig: async () => ({ RAZORPAY_WEBHOOK_SECRET: "operational-test-webhook-key", ZOOM_WEBHOOK_SECRET_TOKEN: "operational-test-webhook-key" }),
    requireIntegrationValue: (values, key) => values[key],
    integrationStatus: async () => ({ configured: true, missing: [], required: [] }),
  }, "@/lib/server/invoice-delivery": { sendPaymentReceipt: async () => undefined }, ...mocks };
  const exports = {};
  const source = readFileSync(join(__dirname, "..", ...relativePath.split("/")), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, {
    exports, require: (name) => name in mocks ? mocks[name] : require(name),
    Buffer, Date, process, console, Response, fetch, AbortSignal, crypto: require("node:crypto").webcrypto, ...overrides,
  });
  return exports;
}
const secret = "operational-test-webhook-key";
const env = { "@/lib/server/env": { requireEnv: () => secret } };
const razorpay = load("src/lib/server/razorpay.ts", env);
const zoom = load("src/lib/server/zoom.ts", env);
const signRazorpay = (body) => createHmac("sha256", secret).update(body).digest("hex");
const signZoom = (body, timestamp) => "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");

test("Razorpay verifies exact raw payload and rejects missing or altered signatures", () => {
  const raw = '{"event":"payment_link.paid"}';
  assert.equal(razorpay.razorpaySignatureValid(raw, signRazorpay(raw)), true);
  assert.equal(razorpay.razorpaySignatureValid(raw + " ", signRazorpay(raw)), false);
  assert.equal(razorpay.razorpaySignatureValid(raw, null), false);
  assert.equal(razorpay.razorpaySignatureValid(raw, "bad"), false);
});

test("Razorpay creates fixed-amount Payment Links with invoice correlation, not QR codes", async () => {
  let request;
  const provider = load("src/lib/server/razorpay.ts", {
    "@/lib/server/env": { requireEnv: () => secret },
    "@/lib/server/integration-settings": {
      getIntegrationConfig: async () => ({ RAZORPAY_KEY_ID: "key_id", RAZORPAY_KEY_SECRET: "key_secret" }),
      requireIntegrationValue: (values, key) => values[key],
    },
  }, {
    fetch: async (url, init) => {
      request = { url, init };
      return { ok: true, json: async () => ({ id: "plink_123", short_url: "https://rzp.io/i/123", status: "created" }) };
    },
  });
  const link = await provider.createInvoicePaymentLink({
    invoiceId: "10000000-0000-4000-8000-000000000001", invoiceNo: "INV-1", leadId: "lead-1",
    leadName: "Lead", leadEmail: "lead@example.com", amount: 125, currency: "INR",
  });
  assert.equal(link.short_url, "https://rzp.io/i/123");
  assert.equal(request.url, "https://api.razorpay.com/v1/payment_links");
  const body = JSON.parse(request.init.body);
  assert.equal(body.amount, 12500);
  assert.equal(body.currency, "INR");
  assert.equal(body.reference_id, "10000000-0000-4000-8000-000000000001");
  assert.equal(body.customer.email, "lead@example.com");
  assert.equal(body.notes.invoice_id, body.reference_id);
  assert.equal(body.reminder_enable, false);
  assert.equal("type" in body, false);
});

test("Zoom verifies signatures and rejects stale replays", () => {
  const raw = '{"event":"meeting.ended"}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  assert.equal(zoom.zoomSignatureValid(raw, timestamp, signZoom(raw, timestamp)), true);
  assert.equal(zoom.zoomSignatureValid(raw + " ", timestamp, signZoom(raw, timestamp)), false);
  const old = String(Number(timestamp) - 600);
  assert.equal(zoom.zoomSignatureValid(raw, old, signZoom(raw, old)), false);
  assert.equal(zoom.zoomSignatureValid(raw, null, null), false);
});

test("unsigned payment events never acquire the service client", async () => {
  let adminCalls = 0;
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const route = load("src/app/api/webhooks/razorpay/route.ts", {
    "next/server": { NextResponse: { json: (payload) => payload } },
    "@/lib/server/auth": { HttpError, jsonError: (error) => ({ status: error.status, error: error.message }) },
    "@/lib/server/razorpay": razorpay,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { adminCalls++; throw new Error("Must not run"); } },
    "@/lib/server/operational": { databaseError: (error) => { if (error) throw error; } },
  });
  const result = await route.POST(new Request("https://crm.example/api/webhooks/razorpay", { method: "POST", body: "{}" }));
  assert.equal(result.status, 401);
  assert.equal(adminCalls, 0);
});

test("authenticated unrelated provider events are ignored without privileged writes", async () => {
  let adminCalls = 0;
  const route = load("src/app/api/webhooks/razorpay/route.ts", {
    "next/server": { NextResponse: { json: (payload) => payload } },
    "@/lib/server/auth": { HttpError: Error, jsonError: (error) => ({ error: error.message }) },
    "@/lib/server/razorpay": razorpay,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { adminCalls++; throw new Error("Must not run"); } },
    "@/lib/server/operational": { databaseError: (error) => { if (error) throw error; } },
  });
  const body = JSON.stringify({ event: "payment.authorized" });
  const result = await route.POST(new Request("https://crm.example/api/webhooks/razorpay", { method: "POST", body, headers: { "x-razorpay-signature": signRazorpay(body) } }));
  assert.equal(result.ignored, true);
  assert.equal(adminCalls, 0);
});

test("signed Payment Link webhooks verify invoice reference and amount before idempotent recording", async () => {
  const invoiceId = "10000000-0000-4000-8000-000000000001";
  let calls = 0;
  let receipts = 0;
  let rpcArgs;
  const admin = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: invoiceId, total: 125, currency: "INR" }, error: null }) }) }),
    }),
    rpc: async (_name, args) => { calls++; rpcArgs = args; return { data: calls === 1, error: null }; },
  };
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const route = load("src/app/api/webhooks/razorpay/route.ts", {
    "next/server": { NextResponse: { json: payload => payload } },
    "@/lib/server/auth": { HttpError, jsonError: error => ({ status: error.status, error: error.message }) },
    "@/lib/server/razorpay": razorpay,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
    "@/lib/server/operational": { databaseError: error => { if (error) throw error; } },
    "@/lib/server/invoice-delivery": { sendPaymentReceipt: async () => { if (!receipts) receipts++; } },
  });
  const event = {
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: "plink_1", status: "paid", reference_id: invoiceId, amount: 12500, currency: "INR" } },
      payment: { entity: { id: "pay_1", status: "captured", amount: 12500, currency: "INR", method: "card" } },
    },
  };
  const raw = JSON.stringify(event);
  const request = () => new Request("https://crm.example/api/webhooks/razorpay", {
    method: "POST", body: raw, headers: { "x-razorpay-signature": signRazorpay(raw) },
  });
  assert.equal((await route.POST(request())).recorded, true);
  assert.equal(rpcArgs.p_invoice_id, invoiceId);
  assert.equal(rpcArgs.p_link_id, "plink_1");
  assert.equal(rpcArgs.p_amount_paise, 12500);
  assert.equal(receipts, 1);
  assert.equal((await route.POST(request())).recorded, false);
  assert.equal(calls, 2);
  assert.equal(receipts, 1);
  const invalid = { ...event, payload: { ...event.payload, payment: { ...event.payload.payment.entity, amount: 12000 } } };
  const invalidRaw = JSON.stringify(invalid);
  const rejected = await route.POST(new Request("https://crm.example/api/webhooks/razorpay", {
    method: "POST", body: invalidRaw, headers: { "x-razorpay-signature": signRazorpay(invalidRaw) },
  }));
  assert.equal(rejected.status, 400);
  assert.equal(calls, 2);
});

test("internal meetings persist with selected staff attendees without a fabricated video URL", async () => {
  let saved;
  let attendeeRows;
  let providerCalls = 0;
  const attendeeId = "8c5b3271-8bdc-4ccc-9d40-8c741505bb98";
  const staff = [{ id: attendeeId, full_name: "Counselor", email: "counselor@example.com", role: "counselor", status: "active", deleted_at: null }];
  const profileQuery = () => {
    const query = { select() { return query; }, in() { return query; }, eq() { return query; }, is() { return query; }, order: async () => ({ data: staff, error: null }) };
    return query;
  };
  const route = load("src/app/api/meetings/route.ts", {
    "next/server": { NextResponse: { json: (payload, options = {}) => ({ ...payload, status: options.status ?? 200 }) } },
    "@/lib/server/auth": {
      requireUser: async permission => {
        assert.equal(permission, "meetings.manage");
        const supabase = { from: table => {
          const query = { select() { return query; }, insert(value) { if (table === "meetings") saved = value; else attendeeRows = value; return query; }, single: async () => ({ data: { id: saved.id, title: saved.title, start_at: saved.start_at, duration_min: saved.duration_min, join_url: saved.join_url }, error: null }), then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); } };
          return query;
        } };
        return { user: { id: "host-id", email: "host@example.com", profile: { role: "manager", fullName: "Host" } }, supabase };
      },
      readJson: request => request.json(), isEmail: value => value.includes("@"), jsonError: error => ({ status: error.status ?? 500, error: error.message }),
    },
    "@/lib/server/operational": { parseInput: (_schema, input) => input, databaseError: error => { if (error) throw error; } },
    "@/lib/server/operational-validation": { meetingInput: {} },
    "@/lib/server/zoom": { createZoomMeeting: () => { providerCalls++; throw new Error("Not configured"); } },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({ from: profileQuery }) },
    "@/lib/server/meeting-mail": { emailMeetingRecipients: async () => ({ emailed: 1 }) },
  });
  const body = { title: "Internal review", provider: "internal", start_at: "2027-01-01T09:00:00Z", duration_min: 30, attendee_ids: [attendeeId] };
  const result = await route.POST(new Request("https://crm.example/api/meetings", { method: "POST", body: JSON.stringify(body) }));
  assert.ok(result.meeting.id);
  assert.equal(result.emailed, 1);
  assert.equal(saved.host_id, "host-id");
  assert.equal(saved.join_url, null);
  assert.equal(saved.zoom_meeting_id, null);
  assert.equal(attendeeRows[0].user_id, attendeeId);
  assert.equal(providerCalls, 0);
});

test("Zoom provider failure never persists a fabricated successful meeting", async () => {
  let writes = 0;
  const attendeeId = "8c5b3271-8bdc-4ccc-9d40-8c741505bb98";
  const profileQuery = () => {
    const query = { select() { return query; }, in() { return query; }, eq() { return query; }, is() { return query; }, order: async () => ({ data: [{ id: attendeeId, full_name: "Counselor", email: "counselor@example.com", role: "counselor" }], error: null }) };
    return query;
  };
  const route = load("src/app/api/meetings/route.ts", {
    "next/server": { NextResponse: { json: payload => payload } },
    "@/lib/server/auth": {
      requireUser: async () => ({ user: { id: "host", email: "host@example.com", profile: { role: "manager", fullName: "Host" } }, supabase: { from: () => { const query = { select() { return query; }, not() { return query; }, in() { return query; }, gte() { return query; }, lt() { return query; }, limit() { return query; }, insert() { writes++; return query; }, then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); } }; return query; } } }),
      readJson: request => request.json(), isEmail: value => value.includes("@"), jsonError: error => ({ status: error.status ?? 500, error: error.message }),
    },
    "@/lib/server/operational": { parseInput: (_schema, input) => input, databaseError: error => { if (error) throw error; } },
    "@/lib/server/operational-validation": { meetingInput: {} },
    "@/lib/server/zoom": { createZoomMeeting: async () => { throw new Error("Zoom authentication failed"); } },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({ from: profileQuery }) },
    "@/lib/server/meeting-mail": { emailMeetingRecipients: async () => ({ emailed: 1 }) },
  });
  const body = { title: "Review", provider: "zoom", start_at: "2027-01-01T09:00:00Z", duration_min: 30, attendee_ids: [attendeeId] };
  const result = await route.POST(new Request("https://crm.example/api/meetings", { method: "POST", body: JSON.stringify(body) }));
  assert.equal(result.error, "Zoom authentication failed");
  assert.equal(writes, 0);
});
