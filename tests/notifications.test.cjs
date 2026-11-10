const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

function load(file, mocks = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function("exports", "require", ...Object.keys(globals), code)(exports, name => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) return load(`${name.replace("@/", "src\\").replaceAll("/", "\\")}.ts`, mocks, globals);
    return require(name);
  }, ...Object.values(globals));
  return exports;
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const check = error => { if (error) throw new Error(error.message); };
const auth = { HttpError, requireUser: async () => ({ user: { id: "owner" }, supabase: {} }),
  jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
  readJson: request => request.json() };
const id = "31000000-0000-4000-8000-000000000001";

test("owner email links use the public CRM without changing localhost or invoice links", () => {
  const env = load("src\\lib\\server\\env.ts");
  const keys = ["NEXT_PUBLIC_APP_URL", "NOTIFICATION_PUBLIC_URL", "INVOICE_PUBLIC_URL"];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.NOTIFICATION_PUBLIC_URL = "https://www.ibmpcrm.xyz/";
    process.env.INVOICE_PUBLIC_URL = "https://invoices.example.test";
    assert.equal(env.appUrl(), "http://localhost:3000");
    assert.equal(env.appUrl("notification"), "https://www.ibmpcrm.xyz");
    assert.equal(env.appUrl("invoice"), "https://invoices.example.test");
    for (const invalid of ["http://crm.example.test", "https://crm.example.test/path", "https://crm.example.test/?token=bad"]) {
      process.env.NOTIFICATION_PUBLIC_URL = invalid;
      assert.throws(() => env.appUrl("notification"), /NOTIFICATION_PUBLIC_URL/);
    }
    delete process.env.NOTIFICATION_PUBLIC_URL;
    assert.equal(env.appUrl("notification"), "http://localhost:3000");
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key];
    }
  }
});

test("notification links open only validated local lead URLs, including existing automation payloads", () => {
  const { notificationLeadPath } = load("src\\lib\\notifications.ts");
  assert.equal(notificationLeadPath({ lead_id: id, payload: {} }), `/leads/${id}`);
  assert.equal(notificationLeadPath({ lead_id: null, payload: { lead_id: id } }), `/leads/${id}`);
  for (const value of ["https://example.test", "../settings", "javascript:alert(1)", "", undefined])
    assert.equal(notificationLeadPath({ lead_id: value, payload: {} }), undefined);
  assert.equal(notificationLeadPath({ lead_id: null, payload: null }), undefined);
});

test("notification list displays lead links and marks alerts read without discarding other records", async () => {
  const row = { id, lead_id: id, type: "call_due", payload: { message: "Call is due" }, is_read: false, created_at: "2026-11-10T10:00:00Z" };
  const states = [{ notifications: [row, { ...row, id: "legacy", lead_id: null, payload: null, is_read: true }], unread: 1 }, "", ""];
  const requests = [], dispatched = [];
  let index = 0;
  const { NotificationsWorkspace } = load("src\\components\\notifications-workspace.tsx", {
    react: { ...React, useEffect() {}, useState: initial => {
      const key = index++; return [states[key] ?? initial, value => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
    } },
    "next/link": { __esModule: true, default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) },
    "@/lib/crm-data": { apiRequest: async (...args) => { requests.push(args); }, errorMessage: error => error.message, formatDateTime: value => value },
  }, { window: { dispatchEvent: event => dispatched.push(event.type) } });
  const render = () => { index = 0; return NotificationsWorkspace(); };
  const tree = render();
  const html = renderToStaticMarkup(tree);
  assert.match(html, new RegExp(`href="/leads/${id}"`));
  assert.match(html, /Call is due/);
  assert.match(html, /New CRM activity/);
  function collect(node) {
    if (Array.isArray(node)) return node.flatMap(collect);
    if (!node?.props) return [];
    return [node, ...collect(node.props.children)];
  }
  const button = collect(tree).find(node => node.type === "button");
  button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests[0], ["/api/notifications", { method: "PATCH", body: { id } }]);
  assert.equal(states[0].unread, 0);
  assert.equal(states[0].notifications.length, 2);
  assert.equal(states[0].notifications[0].is_read, true);
  assert.deepEqual(dispatched, ["crm-notifications-changed"]);
});

test("notification scheduler authenticates before acquiring admin access and reports failed email batches", async () => {
  let acquired = 0, fail = false;
  const route = load("src\\app\\api\\cron\\notifications\\route.ts", {
    "@/lib/server/auth": auth,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { acquired++; return {}; } },
    "@/lib/server/notification-delivery": { deliverLeadNotifications: async () => ({ reminders: 1, processed: 1, failed: fail ? 1 : 0 }) },
  });
  const previous = process.env.NOTIFICATION_CRON_SECRET;
  try {
    delete process.env.NOTIFICATION_CRON_SECRET;
    assert.equal((await route.GET(new Request("https://crm.test/api/cron/notifications"))).status, 503);
    process.env.NOTIFICATION_CRON_SECRET = "notification-test-scheduler-credential-32chars";
    assert.equal((await route.GET(new Request("https://crm.test/api/cron/notifications"))).status, 401);
    assert.equal(acquired, 0);
    const request = () => new Request("https://crm.test/api/cron/notifications", { headers: { authorization: `Bearer ${process.env.NOTIFICATION_CRON_SECRET}` } });
    assert.equal((await route.GET(request())).status, 200);
    fail = true;
    assert.equal((await route.GET(request())).status, 502);
  } finally {
    if (previous === undefined) delete process.env.NOTIFICATION_CRON_SECRET; else process.env.NOTIFICATION_CRON_SECRET = previous;
  }
});

test("click-to-call records an attempt with the actor, without pretending that a call connected", async () => {
  const saved = [];
  const route = load("src\\app\\api\\leads\\[id]\\actions\\route.ts", {
    "@/lib/crm-data": { fetchLead: async () => ({ id, isArchived: false }) },
    "@/lib/server/auth": { ...auth, requireUser: async permission => {
      assert.equal(permission, "leads.edit");
      return { user: { id: "owner", profile: { fullName: "Lead Owner" } }, supabase: {
        from: table => ({ insert: async value => { saved.push({ table, value }); return { error: null }; } }),
      } };
    } },
    "@/lib/live-leads": { dbError: check, uuid: value => value },
    "@/lib/server/operational-gmail": {}, "@/lib/supabase/server": {},
    "@/lib/server/login": { checkOrigin() {} },
  });
  const response = await route.POST(new Request("https://crm.test/api/leads/record/actions", {
    method: "POST", body: JSON.stringify({ action: "call_started" }),
  }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  assert.deepEqual(saved, [{ table: "activities", value: {
    lead_id: id, user_id: "owner", type: "call", description: "Phone app opened to call lead", meta: { actor_name: "Lead Owner" },
  } }]);
});

test("SMTP worker sends escaped owner mail with a lead link and records retryable errors with claim fencing", async () => {
  const sent = [], saved = [], calls = [];
  const rows = [
    { id: "first", claim_token: "lease-1", recipient: "owner@example.test", message: '<img src=x onerror="bad"> Lead updated', lead_id: id },
    { id: "missing", claim_token: "lease-2", recipient: null, message: "Owner missing", lead_id: id },
    { id: "failed", claim_token: "lease-3", recipient: "other@example.test", message: "Call due", lead_id: id },
  ];
  const admin = {
    rpc: async name => { calls.push(name); return { data: name === "claim_notification_emails" ? rows : 1, error: null }; },
    from: table => ({ update: value => {
      assert.equal(table, "notification_email_queue");
      const filters = [];
      const query = { eq: (key, value) => { filters.push([key, value]); return query; }, select: () => query,
        maybeSingle: async () => { saved.push({ value, filters }); return { data: { id: filters[0][1] }, error: null }; } };
      return query;
    } }),
  };
  const mailer = load("src\\lib\\server\\mailer.ts", {
    "@/lib/server/integration-settings": {}, "@/lib/server/smtp-transport": {},
  });
  const worker = load("src\\lib\\server\\notification-delivery.ts", {
    "@/lib/live-leads": { dbError: check }, "@/lib/server/env": { appUrl: () => "https://crm.test" },
    "@/lib/server/mailer": { ...mailer, sendMail: async mail => {
      if (mail.to === "other@example.test") throw new Error("SMTP unavailable");
      sent.push(mail);
    } },
  });
  const result = await worker.deliverLeadNotifications(admin);
  assert.deepEqual(result, { reminders: 1, processed: 3, failed: 2 });
  assert.deepEqual(calls, ["release_due_call_notifications", "claim_notification_emails"]);
  assert.equal(sent[0].to, "owner@example.test");
  assert.match(sent[0].html, /&lt;img/);
  assert.doesNotMatch(sent[0].html, /<img src=x/);
  assert.match(sent[0].text, new RegExp(`/leads/${id}`));
  const outcomes = saved.filter(item => item.value.status);
  assert.equal(outcomes[0].value.status, "sent");
  assert.equal(outcomes[1].value.status, "failed");
  assert.match(outcomes[2].value.last_error, /SMTP unavailable/);
  assert.deepEqual(outcomes[2].filters, [["id", "failed"], ["claim_token", "lease-3"]]);
  assert.equal(saved.filter(item => item.value.claimed_at).length, 3, "renew each fenced lease before SMTP to protect late batch items");
});

test("SMTP acceptance followed by a save failure is surfaced, not silently reported as delivered", async () => {
  let sends = 0;
  const query = { eq: () => query, select: () => query, maybeSingle: async () => ({ data: null, error: { message: "Database unavailable" } }) };
  const worker = load("src\\lib\\server\\notification-delivery.ts", {
    "@/lib/live-leads": { dbError: check }, "@/lib/server/env": { appUrl: () => "https://crm.test" },
    "@/lib/server/mailer": { escapeHtml: value => value, emailLayout: (_, value) => value, sendMail: async () => { sends++; } },
  });
  await assert.rejects(worker.deliverLeadNotifications({
    rpc: async name => ({ data: name === "claim_notification_emails" ? [{ id: "one", claim_token: "lease", recipient: "owner@example.test", message: "Due", lead_id: id }] : 1, error: null }),
    from: () => ({ update: value => value.status ? query : (() => {
      const lease = { eq: () => lease, select: () => lease, maybeSingle: async () => ({ data: { id: "one" }, error: null }) };
      return lease;
    })() }),
  }), /Database unavailable/);
  assert.equal(sends, 1);
});

test("a reassigned email lease cannot send from an obsolete worker", async () => {
  let sends = 0;
  const query = { eq: () => query, select: () => query, maybeSingle: async () => ({ data: null, error: null }) };
  const worker = load("src\\lib\\server\\notification-delivery.ts", {
    "@/lib/live-leads": { dbError: check }, "@/lib/server/env": { appUrl: () => "https://crm.test" },
    "@/lib/server/mailer": { sendMail: async () => { sends++; } },
  });
  await assert.rejects(worker.deliverLeadNotifications({
    rpc: async name => ({ data: name === "claim_notification_emails" ? [{ id: "one", claim_token: "old", recipient: "owner@example.test", message: "Due", lead_id: id }] : 1, error: null }),
    from: () => ({ update: () => query }),
  }), /reassigned before sending/);
  assert.equal(sends, 0);
});

test("notification API reads owner-only data without caching and marks only the owner's alert", async () => {
  const filters = [], rpcs = [];
  const admin = {
    rpc: async name => { rpcs.push(name); return { data: 0, error: null }; },
    from: () => {
      let head = false, write = false;
      const query = {
        select: (_, options) => { head = Boolean(options?.head); return query; },
        eq: (key, value) => { filters.push([key, value]); return query; },
        order: () => query, limit: () => query,
        update: value => { assert.deepEqual(value, { is_read: true }); write = true; return query; },
        maybeSingle: async () => ({ data: { id }, error: null }),
        then: resolve => resolve({ data: write ? { id } : [], count: head ? 3 : undefined, error: null }),
      };
      return query;
    },
  };
  const route = load("src\\app\\api\\notifications\\route.ts", {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user: { id: "owner" }, supabase: admin }) },
    "@/lib/live-leads": { dbError: check }, "@/lib/server/login": { checkOrigin() {} },
  });
  const response = await route.GET();
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { notifications: [], unread: 3 });
  assert.deepEqual(rpcs, ["release_my_due_call_notifications"]);
  assert.equal(filters.filter(([key, value]) => key === "user_id" && value === "owner").length, 2);
  const patched = await route.PATCH(new Request("https://crm.test/api/notifications", { method: "PATCH", body: JSON.stringify({ id }) }));
  assert.equal(patched.status, 200);
  assert.equal(filters.filter(([key, value]) => key === "user_id" && value === "owner").length, 3);
  assert.equal((await route.PATCH(new Request("https://crm.test/api/notifications", { method: "PATCH", body: '{"id":"invalid"}' }))).status, 400);
});

test("notification bell refreshes automatically, suppresses overlapping/hidden reads and renders unread count", async () => {
  const states = [], effects = [], timers = new Map(), listeners = new Map();
  let index = 0, reads = 0, release, writeListener;
  const document = { visibilityState: "visible", addEventListener: (key, callback) => listeners.set(key, callback), removeEventListener: key => listeners.delete(key) };
  const window = {
    setInterval: (callback, ms) => { assert.equal(ms, 15000); timers.set("interval", callback); return 1; }, clearInterval: () => timers.delete("interval"),
    setTimeout: callback => { timers.set("write", callback); return 2; }, clearTimeout() {},
    addEventListener: (key, callback) => listeners.set(key, callback), removeEventListener: key => listeners.delete(key),
  };
  const { NotificationBell } = load("src\\components\\notification-bell.tsx", {
    react: { ...React, useEffect: effect => effects.push(effect), useState: initial => {
      const key = index++; if (!(key in states)) states[key] = initial;
      return [states[key], value => { states[key] = value; }];
    } },
    "next/link": { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) },
    "next/navigation": { usePathname: () => "/leads" },
    "@/lib/crm-data": {
      apiRequest: async () => { reads++; return new Promise(resolve => { release = resolve; }); },
      errorMessage: error => error.message,
      subscribeApiWrites: (listener, phase) => { assert.equal(phase, "completed"); writeListener = listener; return () => { writeListener = null; }; },
    },
  }, { window, document });
  const render = () => { index = 0; return renderToStaticMarkup(NotificationBell({ userId: "owner" })); };
  render(); const cleanup = effects[0]();
  assert.equal(reads, 1);
  timers.get("interval")(); assert.equal(reads, 1, "pending reads cannot overlap");
  release({ unread: 4 }); await new Promise(resolve => setImmediate(resolve));
  assert.match(render(), /Notifications \(4 unread\)/);
  document.visibilityState = "hidden"; timers.get("interval")(); assert.equal(reads, 1);
  document.visibilityState = "visible"; listeners.get("visibilitychange")(); assert.equal(reads, 2);
  release({ unread: 0 }); await new Promise(resolve => setImmediate(resolve));
  writeListener(); assert.equal(reads, 3);
  release({ unread: 1 }); await new Promise(resolve => setImmediate(resolve));
  cleanup();
  assert.equal(timers.has("interval"), false);
  assert.equal(writeListener, null);
});
