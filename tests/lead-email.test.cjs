const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const root = path.join(__dirname, "..");
function load(file, mocks = {}) {
  const api = {};
  const code = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function("exports", "require", code)(api, name => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) {
      const base = name.replace("@/", "src\\").replaceAll("/", "\\");
      return load(`${base}${existsSync(path.join(root, `${base}.ts`)) ? ".ts" : ".tsx"}`, mocks);
    }
    return require(name);
  });
  return api;
}
const templates = load("src\\lib\\lead-email-templates.ts");
const signatures = load("src\\lib\\server\\email-signature.ts");
const invoice = { id: "invoice-1", invoiceNo: "DMHCA-42", course: "Cardiology", amount: 12500.5, currency: "INR", dueDate: "2026-11-25", status: "sent" };
const context = { doctor: "Dr. Alex", course: "Clinical research", sender: "Counsellor", phone: "9876543210", invoice };

test("all three shared templates resolve names, courses and real invoice values without placeholder leakage", () => {
  assert.equal(templates.leadEmailTemplates.length, 3);
  const enquiry = templates.createLeadEmailDraft("enquiry", context);
  assert.equal(enquiry.subject, "Your enquiry about Clinical research – DMHCA");
  assert.match(enquiry.body, /Dear Dr\. Alex,/);
  assert.match(enquiry.body, /I'm Counsellor/);
  assert.doesNotMatch(enquiry.body, /attached|brochure|\[Doctor Name\]/);
  const followup = templates.createLeadEmailDraft("follow-up", context);
  assert.equal(followup.subject, "Following up on Clinical research – DMHCA");
  assert.match(followup.body, /- Fee and payment options/);
  const reminder = templates.createLeadEmailDraft("invoice", context);
  assert.equal(reminder.subject, "Reminder: Invoice DMHCA-42 for Cardiology – due 25 Nov 2026");
  assert.match(reminder.body, /Rs\. 12,500\.50/);
  assert.match(reminder.body, /\+91 9876543210/);
  assert.doesNotMatch(reminder.body, /\[(?:Invoice|Amount|Due|Your)/);
});
test("templates reject missing course, name, invoice and invalid dates rather than fabricate data", () => {
  for (const [id, override, error] of [
    ["enquiry", { course: "" }, /course/], ["enquiry", { doctor: "" }, /name/],
    ["invoice", { invoice: undefined }, /Select an invoice/],
    ["invoice", { invoice: { ...invoice, status: "paid" } }, /unpaid/],
    ["invoice", { invoice: { ...invoice, dueDate: "2026-02-31" } }, /invalid due date/],
    ["invoice", { invoice: { ...invoice, amount: NaN } }, /valid due date or amount/],
  ]) assert.throws(() => templates.createLeadEmailDraft(id, { ...context, ...override }), error);
  const other = templates.createLeadEmailDraft("invoice", { ...context, phone: "", invoice: { ...invoice, currency: "USD" } });
  assert.match(other.body, /USD 12,500\.50/);
  assert.doesNotMatch(other.body, /\+91|Your Number/);
});
test("signature sanitizer retains useful email formatting and removes scripts, handlers, embeds and unsafe URLs/styles", () => {
  const html = signatures.sanitizeSignature('<script>alert(1)</script><table><tr><td style="color:#123456;position:fixed;background-image:url(https://tracker.test)">Doctor</td></tr></table><a href="javascript:alert(1)" onclick="bad()">Link</a><img src="data:image/svg+xml,bad" onerror="bad()"><img src="https://example.test/logo.png" width="100"><iframe src="https://example.test"></iframe>');
  assert.match(html, /<table>/);
  assert.match(html, /color:#123456/);
  assert.match(html, /src="https:\/\/example.test\/logo.png"/);
  assert.doesNotMatch(html, /script|alert|onerror|onclick|javascript|data:|iframe|position|background-image/);
  assert.equal(signatures.signatureText("<p>Alex &amp; Team<br>DMHCA</p><p>+91 123</p>"), "Alex & Team\nDMHCA\n+91 123");
});
test("Gmail MIME preserves unicode in both plain text and HTML alternatives and rejects header injection", () => {
  class HttpError extends Error {}
  const { gmailRawMessage } = load("src\\lib\\server\\operational-gmail.ts", {
    "@/lib/server/auth": { HttpError }, "@/lib/server/env": {}, "@/lib/server/login-crypto": {},
    "@/lib/server/operational": {}, "@/lib/server/integration-settings": {}, "@/lib/server/gmail-delegation": {},
  });
  const raw = Buffer.from(gmailRawMessage("sender@dmhca.in", "lead@example.test", "Course – DMHCA", "Message\nAlex", "<p>Message</p><b>Alex</b>"), "base64url").toString();
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="crm_/);
  assert.match(raw, /Content-Type: text\/plain/); assert.match(raw, /Content-Type: text\/html/);
  const bodies = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/g)].map(match => Buffer.from(match[1], "base64").toString());
  assert.deepEqual(bodies, ["Message\nAlex", "<p>Message</p><b>Alex</b>"]);
  const subject = raw.match(/Subject: ([^\r]+(?:\r\n [^\r]+)*)/)[1].replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, value) => Buffer.from(value, "base64").toString()).replace(/\r\n /g, "");
  assert.equal(subject, "Course – DMHCA");
  assert.throws(() => gmailRawMessage("sender@dmhca.in", "lead@example.test", "Hi\r\nBcc: other@example.test", "Body"));
});
function elements(node, result = []) {
  if (Array.isArray(node)) node.forEach(child => elements(child, result));
  else if (node && typeof node === "object" && node.props) { result.push(node); elements(node.props.children, result); }
  return result;
}
test("composer applies editable templates, protects drafts, sends manually, includes or omits signature and prevents duplicate submission", async () => {
  const states = [], refs = []; let stateIndex = 0, refIndex = 0, confirmed = true;
  const cache = { sender: { name: "Counsellor", phone: "9876543210", signatureHtml: "<b>Counsellor</b>" }, invoices: [invoice], canViewInvoices: true };
  const { LeadEmailComposer } = load("src\\components\\lead-email-composer.tsx", {
    react: { ...React, useEffect() {}, useState(initial) { const i = stateIndex++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], value => { states[i] = typeof value === "function" ? value(states[i]) : value; }]; },
      useRef(initial) { const i = refIndex++; return refs[i] ?? (refs[i] = { current: initial }); } },
    "@/lib/crm-data": { getPreparedApiRead: () => cache, getApiReadSnapshot: () => undefined },
  });
  const original = global.window; global.window = { confirm: () => confirmed };
  try {
    let subject = "", content = "", sends = [], finish;
    const props = { lead: { id: "lead-1", name: "Dr. Alex", course: "Clinical research", email: "lead@example.test" }, login: "sender@dmhca.in", mailbox: { email: "sender@dmhca.in", managed: true }, busy: false,
      onSubject: value => { subject = value; }, onContent: value => { content = value; }, onSend: async include => { sends.push(include); await new Promise(resolve => { finish = resolve; }); }, onConnect() {} };
    const render = () => { stateIndex = 0; refIndex = 0; return LeadEmailComposer({ ...props, subject, content }); };
    const nodes = () => elements(render());
    const template = name => nodes().find(node => node.type === "button" && node.props.children === name);
    template("Course enquiry").props.onClick();
    assert.match(subject, /Your enquiry/); assert.match(content, /Dear Dr\. Alex/);
    confirmed = false; template("Follow-up").props.onClick(); assert.match(subject, /Your enquiry/);
    confirmed = true; template("Follow-up").props.onClick(); assert.match(subject, /Following up/);
    nodes().find(node => node.type === "select").props.onChange({ target: { value: invoice.id } });
    template("Invoice reminder").props.onClick(); assert.match(subject, /DMHCA-42/);
    nodes().find(node => node.type === "input" && node.props["aria-label"] === "Email subject").props.onChange({ target: { value: "Manual subject" } });
    nodes().find(node => node.type === "textarea").props.onChange({ target: { value: "Manual body" } });
    assert.equal(subject, "Manual subject"); assert.equal(content, "Manual body");
    assert.ok(nodes().some(node => node.type?.name === "EmailSignaturePreview"));
    nodes().find(node => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: false } });
    assert.ok(!nodes().some(node => node.type?.name === "EmailSignaturePreview"));
    const submit = nodes().find(node => node.type === "form").props.onSubmit;
    const first = submit({ preventDefault() {} }); await submit({ preventDefault() {} });
    assert.deepEqual(sends, [false]); finish(); await first;
  } finally { global.window = original; }
});
test("HTML preview is isolated from CRM scripts, forms, parent navigation and referrers", () => {
  const { EmailSignaturePreview } = load("src\\components\\email-signature-preview.tsx");
  const html = renderToStaticMarkup(React.createElement(EmailSignaturePreview, { html: "<b>Signature</b>" }));
  assert.match(html, /sandbox=""/); assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.match(html, /default-src &#x27;none&#x27;/);
});

test("ready Gmail composer renders templates, editable draft and signature without loading or disabled send", () => {
  const cache = { sender: { name: "Admissions Counsellor", phone: "", signatureHtml: "<p><strong>Admissions Counsellor</strong><br><span style=\"color:#1967d2\">DMHCA</span><br>Admissions Team</p>" }, invoices: [invoice], canViewInvoices: true };
  const { LeadEmailComposer } = load("src\\components\\lead-email-composer.tsx", { "@/lib/crm-data": {
    getPreparedApiRead: () => cache, getApiReadSnapshot: () => undefined,
  } });
  const draft = templates.createLeadEmailDraft("enquiry", { ...context, sender: cache.sender.name });
  const html = renderToStaticMarkup(React.createElement(LeadEmailComposer, {
    lead: { id: otherId, name: "Dr. Alex", course: "Clinical research", email: "doctor@example.test" },
    login: "counsellor@example.test", mailbox: { email: "counsellor@example.test", managed: true }, subject: draft.subject, content: draft.body,
    busy: false, onSubject() {}, onContent() {}, async onSend() {}, onConnect() {},
  }));
  assert.match(html, /Workspace-managed/); assert.match(html, /Include my saved signature/);
  assert.doesNotMatch(html, /class="gmail-send-button" disabled|Loading your signature/);
  if (process.env.UI_FIXTURE_DIR) {
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(process.env.UI_FIXTURE_DIR, { recursive: true });
    const css = ["src\\app\\globals.css", "src\\app\\modules.css", "src\\app\\leads\\leads.css"].map(file => readFileSync(path.join(root, file), "utf8")).join("\n");
    writeFileSync(path.join(process.env.UI_FIXTURE_DIR, "gmail-composer-preview.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nbody{margin:0;background:#f6f8fc}main{max-width:1000px;margin:20px auto}.gmail-compose{margin:16px}</style></head><body><main>${html}</main></body></html>`);
  }
});

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const check = error => { if (error) throw new Error(error.message); };
const senderId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
const response = { NextResponse: { json: (body, options) => Response.json(body, options) } };
const routeAuth = user => ({
  HttpError, readJson: request => request.json(),
  requireUser: async permission => { assert.ok(user.permissions.includes(permission)); return { user, supabase: user.supabase }; },
  requireString: value => value, isEmail: () => true,
  jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
});

test("send route uses only the signed-in signature, escapes message HTML, records both bodies and supports signature omission", async () => {
  for (const includeSignature of [true, false]) {
    const writes = [], sends = [], profileReads = [];
    const user = { id: senderId, email: "sender@dmhca.in", permissions: ["leads.edit"], supabase: { from(table) {
      if (table === "profiles") return { select: () => ({ eq: (key, value) => {
        profileReads.push([key, value]);
        return { single: async () => ({ data: { email_signature_html: "<b>Sender</b><script>bad()</script>" }, error: null }) };
      } }) };
      assert.equal(table, "emails");
      return { insert(row) { writes.push(row); return { select: () => ({ single: async () => ({ data: { id: "email-row" }, error: null }) }) }; },
        update(row) { writes.push(row); return { eq: async () => ({ error: null }) }; } };
    } } };
    const api = load("src\\app\\api\\leads\\[id]\\actions\\route.ts", {
      "next/server": response, "@/lib/server/auth": routeAuth(user),
      "@/lib/crm-data": { fetchLead: async () => ({ id: otherId, email: "lead@example.test", assigneeId: otherId }) },
      "@/lib/live-leads": { uuid: value => value, dbError: check }, "@/lib/server/login": { checkOrigin() {} },
      "@/lib/supabase/server": { getSupabaseAdminClient: () => ({}) },
      "@/lib/server/operational-gmail": { prepareGmailSend: async (_admin, id, login) => { assert.equal(id, senderId); return { email: login }; },
        sendGmailMessage: async (...args) => { sends.push(args); return { id: "gmail-id" }; } },
    });
    const result = await api.POST(new Request("https://crm.example/api/leads/id/actions", { method: "POST", body: JSON.stringify({
      action: "email", subject: "Course", content: "Hello <img src=x onerror=bad()>", includeSignature, signatureHtml: "<b>Spoofed owner</b>",
    }) }), { params: Promise.resolve({ id: otherId }) });
    assert.equal(result.status, 200);
    assert.equal(writes[0].body.includes("Sender"), includeSignature);
    assert.equal(writes[0].body_html.includes("<b>Sender</b>"), includeSignature);
    assert.doesNotMatch(writes[0].body_html, /<img|<script|Spoofed/);
    assert.match(writes[0].body_html, /&lt;img/);
    assert.deepEqual(profileReads, includeSignature ? [["id", senderId]] : []);
    assert.equal(sends[0][3], writes[0].body);
    assert.equal(sends[0][4], writes[0].body_html);
    assert.equal(writes[1].status, "sent");
  }
});

test("email context scopes invoice data to the accessible lead and invoice permissions", async () => {
  for (const viewInvoices of [false, true]) {
    const invoiceFilters = [];
    const user = { id: senderId, permissions: ["leads.edit", ...(viewInvoices ? ["invoices.view"] : [])], supabase: { from(table) {
      if (table === "profiles") return { select: () => ({ eq: (_key, value) => {
        assert.equal(value, senderId);
        return { single: async () => ({ data: { full_name: "Sender", phone: "", email_signature_html: "<b>Sender</b>" }, error: null }) };
      } }) };
      assert.ok(viewInvoices); assert.equal(table, "invoices");
      const query = { select: () => query, eq: (key, value) => { invoiceFilters.push([key, value]); return query; }, order: () => query,
        limit: async () => ({ data: [{ id: invoice.id, invoice_no: invoice.invoiceNo, total: invoice.amount, currency: invoice.currency,
          due_date: invoice.dueDate, status: invoice.status, invoice_items: [{ description: invoice.course }] }], error: null }) };
      return query;
    } } };
    const api = load("src\\app\\api\\leads\\[id]\\email-context\\route.ts", {
      "next/server": response, "@/lib/server/auth": routeAuth(user),
      "@/lib/crm-data": { fetchLead: async () => ({ id: otherId, course: "Clinical research" }) },
      "@/lib/live-leads": { uuid: value => value, dbError: check },
    });
    const result = await api.GET(new Request("https://crm.example"), { params: Promise.resolve({ id: otherId }) });
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.canViewInvoices, viewInvoices);
    assert.equal(data.invoices.length, viewInvoices ? 1 : 0);
    assert.deepEqual(invoiceFilters, viewInvoices ? [["lead_id", otherId], ["status", "sent"]] : []);
    if (viewInvoices) assert.deepEqual(data.invoices[0], invoice);
  }
});

test("user creation and editing sanitize signature HTML without clearing signatures from legacy clients", async () => {
  const writes = [];
  const query = { select: () => query, eq: () => query, is: () => query,
    single: async () => ({ data: { id: otherId, email: "new@example.test" }, error: null }),
    insert: async value => { writes.push(value); return { error: null }; },
    update: value => { writes.push(value); return query; },
    then: resolve => resolve({ error: null }) };
  const user = { id: senderId, permissions: ["users.manage"], profile: { role: "super_admin" } };
  const api = load("src\\app\\api\\users\\route.ts", {
    "next/server": response, "@/lib/server/auth": routeAuth(user), "@/lib/crm-data": {},
    "@/lib/server/login": { checkOrigin() {} }, "@/lib/server/password-management": {},
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({ from: () => query,
      auth: { admin: { createUser: async () => ({ data: { user: { id: otherId } }, error: null }) } } }) },
  });
  const profile = { fullName: "Sender", email: "new@example.test", role: "counselor", status: "active", reportingTo: null,
    emailSignatureHtml: '<p>Sender<img src="https://example.test/logo.png" onerror="bad()"></p><script>bad()</script>' };
  const request = body => new Request("https://crm.example/api/users", { method: "POST", body: JSON.stringify(body) });
  assert.equal((await api.POST(request({ ...profile, password: "A-strong-password123" }))).status, 200);
  assert.match(writes[0].email_signature_html, /Sender<img src="https:/);
  assert.doesNotMatch(writes[0].email_signature_html, /script|onerror/);
  writes.length = 0;
  assert.equal((await api.PATCH(request({ action: "update", id: otherId, profile: { ...profile, emailSignatureHtml: "<b>Edited</b>" } }))).status, 200);
  assert.equal(writes[0].email_signature_html, "<b>Edited</b>");
  writes.length = 0;
  const { emailSignatureHtml, ...legacy } = profile;
  assert.equal((await api.PATCH(request({ action: "update", id: otherId, profile: legacy }))).status, 200);
  assert.ok(!("email_signature_html" in writes[0]));
  writes.length = 0;
  assert.equal((await api.POST(request({ ...profile, password: "A-strong-password123", emailSignatureHtml: "x".repeat(signatures.MAX_SIGNATURE_LENGTH + 1) }))).status, 400);
  assert.equal(writes.length, 0);
});

test("signature migration keeps existing profile/email data and enforces the signature size limit", async () => {
  const { PGlite } = require("@electric-sql/pglite");
  const db = new PGlite();
  try {
    await db.exec("create table profiles(id int primary key, full_name text); create table emails(id int primary key, body text); insert into profiles values(1,'Existing'); insert into emails values(1,'Existing message');");
    await db.exec(readFileSync(path.join(root, "supabase", "migrations", "202611100002_email_signatures.sql"), "utf8"));
    assert.deepEqual((await db.query("select * from profiles")).rows, [{ id: 1, full_name: "Existing", email_signature_html: "" }]);
    assert.deepEqual((await db.query("select * from emails")).rows, [{ id: 1, body: "Existing message", body_html: null }]);
    await assert.rejects(db.query("update profiles set email_signature_html=$1", ["x".repeat(20001)]), /check constraint/);
  } finally { await db.close(); }
});
