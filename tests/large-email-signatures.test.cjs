const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { PGlite } = require("@electric-sql/pglite");
const root = path.join(__dirname, "..");
function load(file, mocks = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function("exports", "require", code)(exports, name => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) {
      const base = name.replace("@/", "src\\").replaceAll("/", "\\");
      return load(`${base}${existsSync(path.join(root, `${base}.ts`)) ? ".ts" : ".tsx"}`, mocks);
    }
    return require(name);
  });
  return exports;
}
const { MAX_SIGNATURE_LENGTH } = load("src\\lib\\email-signature-policy.ts");
const signature = length => `<a href="https://dmhca.in"><img src="https://example.test/signature.png" alt="Signature"></a><p>${"x".repeat(length - 97)}</p>`;

test("increasing the database limit preserves signatures and stores one million characters without truncation", async () => {
  const db = new PGlite();
  try {
    await db.exec("create table profiles(id int primary key); create table emails(id int primary key);");
    for (const file of ["202611100002_email_signatures.sql", "202611100003_large_email_signatures.sql"])
      await db.exec(readFileSync(path.join(root, "supabase", "migrations", file), "utf8"));
    await db.query("insert into profiles(id,email_signature_html) values(1,$1)", ["Existing signature"]);
    for (const length of [20001, 100000, MAX_SIGNATURE_LENGTH]) {
      const html = "x".repeat(length);
      await db.query("update profiles set email_signature_html=$1 where id=1", [html]);
      assert.equal((await db.query("select email_signature_html from profiles where id=1")).rows[0].email_signature_html, html);
    }
    await assert.rejects(db.query("update profiles set email_signature_html=$1 where id=1", ["x".repeat(MAX_SIGNATURE_LENGTH + 1)]), /check constraint/);
  } finally { await db.close(); }
});

test("creating and editing users accepts large clickable signatures and rejects only values above the new limit", async () => {
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const id = "10000000-0000-4000-8000-000000000001";
  const writes = [];
  const query = { select: () => query, eq: () => query, is: () => query,
    single: async () => ({ data: { id, email: "sender@example.test" }, error: null }),
    insert: async value => { writes.push(value); return { error: null }; },
    update: value => { writes.push(value); return query; },
    then: resolve => resolve({ error: null }) };
  const api = load("src\\app\\api\\users\\route.ts", {
    "next/server": { NextResponse: { json: (body, options) => Response.json(body, options) } },
    "@/lib/server/auth": { HttpError, readJson: request => request.json(),
      requireUser: async () => ({ user: { id: "10000000-0000-4000-8000-000000000002", profile: { role: "super_admin" } } }),
      jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }) },
    "@/lib/crm-data": {}, "@/lib/server/login": { checkOrigin() {} }, "@/lib/server/password-management": {},
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({ from: () => query,
      auth: { admin: { createUser: async () => ({ data: { user: { id } }, error: null }) } } }) },
  });
  const profile = { fullName: "Sender", email: "sender@example.test", role: "counselor", status: "active", reportingTo: null };
  const request = body => new Request("https://crm.example/api/users", { method: "POST", body: JSON.stringify(body) });
  const { sanitizeSignature } = load("src\\lib\\server\\email-signature.ts");
  for (const html of [signature(100000), "x".repeat(MAX_SIGNATURE_LENGTH)]) {
    writes.length = 0;
    assert.equal((await api.POST(request({ ...profile, password: "A-strong-password123", emailSignatureHtml: html }))).status, 200);
    assert.equal(writes[0].email_signature_html, sanitizeSignature(html));
    writes.length = 0;
    assert.equal((await api.PATCH(request({ action: "update", id, profile: { ...profile, emailSignatureHtml: html } }))).status, 200);
    assert.equal(writes[0].email_signature_html, sanitizeSignature(html));
  }
  writes.length = 0;
  assert.equal((await api.POST(request({ ...profile, password: "A-strong-password123", emailSignatureHtml: "x".repeat(MAX_SIGNATURE_LENGTH + 1) }))).status, 400);
  assert.equal(writes.length, 0);
});
