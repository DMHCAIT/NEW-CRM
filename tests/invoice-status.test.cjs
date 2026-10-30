const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createHash } = require("node:crypto");

function loadRoute(mocks) {
  const exports = {};
  const source = readFileSync(join(__dirname, "..", "src", "app", "api", "invoice-status", "[token]", "route.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, { exports, require: name => mocks[name], Buffer });
  return exports;
}

test("public invoice status uses a random token hash and returns no customer PII", async () => {
  const token = Buffer.alloc(32, 7).toString("base64url");
  const expectedHash = createHash("sha256").update(token).digest("hex");
  let queriedHash;
  let selected;
  const route = loadRoute({
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200, headers: options?.headers }) } },
    "@/lib/server/razorpay": { statusTokenHash: value => createHash("sha256").update(value).digest("hex") },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({
      from: table => {
        assert.equal(table, "invoices");
        return {
          select: fields => { selected = fields; return { eq: (_field, value) => {
            queriedHash = value;
            return { maybeSingle: async () => ({ data: {
              invoice_no: "INV-1", total: "125.00", currency: "INR", status: "paid", paid_at: "2026-10-24T10:00:00Z",
              invoice_items: [{ description: "Course enrollment" }],
            }, error: null }) };
          } }; },
        };
      },
    }) },
  });
  const result = await route.GET(new Request("https://crm.example/api/invoice-status/token"), { params: Promise.resolve({ token }) });
  assert.equal(result.status, 200);
  assert.equal(queriedHash, expectedHash);
  assert.match(selected, /invoice_no,total,currency,status,paid_at,invoice_items\(description\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    invoiceNo: "INV-1", course: "Course enrollment", total: 125, currency: "INR", status: "paid", paidAt: "2026-10-24T10:00:00Z",
  });
  assert.equal("leadEmail" in result.data, false);
  assert.equal("leadName" in result.data, false);
  assert.equal(result.headers["Cache-Control"], "no-store");
});

test("malformed status tokens return the same unavailable response without database access", async () => {
  let calls = 0;
  const route = loadRoute({
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } },
    "@/lib/server/razorpay": { statusTokenHash: value => value },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { calls++; throw new Error("Should not query"); } },
  });
  const result = await route.GET(new Request("https://crm.example/api/invoice-status/token"), { params: Promise.resolve({ token: "short" }) });
  assert.equal(result.status, 404);
  assert.equal(calls, 0);
});
