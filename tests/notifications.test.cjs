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

test("notification list displays lead links and removes confirmed read reminders without discarding others", async () => {
  const row = { id, lead_id: id, type: "call_due", payload: { message: "Call is due" }, is_read: false, created_at: "2026-11-10T10:00:00Z" };
  const states = [{ notifications: [row, { ...row, id: "second", lead_id: null, payload: null }], unread: 2 }, "", ""];
  const requests = [], dispatched = [];
  let index = 0, fail = false;
  const { NotificationsWorkspace } = load("src\\components\\notifications-workspace.tsx", {
    react: { ...React, useSyncExternalStore: (_, getSnapshot) => getSnapshot(), useEffect() {}, useState: initial => {
      const key = index++; return [states[key] ?? initial, value => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
    } },
    "next/link": { __esModule: true, default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) },
    "@/lib/crm-data": { apiRequest: async (...args) => { requests.push(args); if (fail) throw new Error("Save failed"); }, errorMessage: error => error.message, formatDateTime: value => value },
  }, { window: { dispatchEvent: event => dispatched.push(event.type) } });
  const render = () => { index = 0; return NotificationsWorkspace(); };
  const tree = render();
  const html = renderToStaticMarkup(tree);
  assert.match(html, new RegExp(`href="/leads/${id}"`));
  assert.match(html, /Call is due/);
  assert.match(html, /Scheduled call reminder/);
  assert.match(html, /unread scheduled-call reminders/);
  function collect(node) {
    if (Array.isArray(node)) return node.flatMap(collect);
    if (!node?.props) return [];
    return [node, ...collect(node.props.children)];
  }
  const button = collect(tree).find(node => node.type === "button");
  button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests[0], ["/api/notifications", { method: "PATCH", body: { id } }]);
  assert.equal(states[0].unread, 1);
  assert.equal(states[0].notifications.length, 1);
  assert.equal(states[0].notifications[0].id, "second");
  assert.deepEqual(dispatched, ["crm-notifications-changed"]);
  fail = true;
  collect(render()).find(node => node.type === "button").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states[0].notifications.length, 1, "failed writes must not dismiss a reminder");
  assert.equal(states[0].unread, 1);
  assert.equal(states[1], "Save failed");
  assert.deepEqual(dispatched, ["crm-notifications-changed"]);
});

test("notification page refreshes after completed writes and ignores older in-flight snapshots", async () => {
  const states = [{ notifications: [], unread: 0 }, "", ""], effects = [], requests = [];
  let index = 0, afterWrite, unsubscribed = false;
  const { NotificationsWorkspace } = load("src\\components\\notifications-workspace.tsx", {
    react: { ...React, useSyncExternalStore: (_, getSnapshot) => getSnapshot(), useEffect: effect => effects.push(effect), useState: initial => {
      const key = index++; return [states[key] ?? initial, value => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
    } },
    "next/link": { __esModule: true, default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) },
    "@/lib/crm-data": {
      apiRequest: () => new Promise(resolve => requests.push(resolve)),
      errorMessage: error => error.message,
      subscribeApiWrites: (listener, phase) => {
        assert.equal(phase, "completed"); afterWrite = listener; return () => { unsubscribed = true; };
      },
    },
  }, {
    window: { setInterval: () => 1, clearInterval() {} },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  });
  NotificationsWorkspace();
  const cleanup = effects[0]();
  assert.equal(requests.length, 1);
  afterWrite();
  assert.equal(requests.length, 2, "completed modification must not wait for an old notification request");
  requests[1]({ notifications: [], unread: 0 });
  await new Promise(resolve => setImmediate(resolve));
  requests[0]({ notifications: [{ id }], unread: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states[0], { notifications: [], unread: 0 });
  cleanup();
  assert.equal(unsubscribed, true);
});

test("notification empty state has a clear heading, explanation and no reminder actions", () => {
  let index = 0;
  const { NotificationsWorkspace } = load("src\\components\\notifications-workspace.tsx", {
    react: { ...React, useSyncExternalStore: (_, getSnapshot) => getSnapshot(), useEffect() {}, useState: () => [[{ notifications: [], unread: 0 }, "", ""][index++], () => {}] },
    "@/lib/crm-data": {},
  });
  const html = renderToStaticMarkup(NotificationsWorkspace());
  assert.match(html, /notifications-empty/);
  assert.match(html, /You&#x27;re all caught up/);
  assert.match(html, /No unread scheduled-call reminders/);
  assert.match(html, /Scheduled calls only/);
  assert.doesNotMatch(html, /Mark read|<ul/);
});

test("notification server and hydration markup stay stable even when the browser cache has a snapshot", () => {
  const { NotificationsWorkspace } = load("src\\components\\notifications-workspace.tsx", {
    "@/lib/crm-data": { getCachedApiRead: () => ({ notifications: [], unread: 2 }) },
  });
  const html = renderToStaticMarkup(React.createElement(NotificationsWorkspace));
  assert.match(html, /Loading notifications/);
  assert.match(html, /Checking reminders/);
  assert.doesNotMatch(html, /2 unread|caught up/);
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
    rpc: async name => { rpcs.push(name); return { data: { notifications: [], unread: 3 }, error: null }; },
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
  assert.deepEqual(rpcs, ["crm_notification_snapshot"]);
  assert.equal(filters.length, 0, "snapshot must not issue additional REST reads");
  const patched = await route.PATCH(new Request("https://crm.test/api/notifications", { method: "PATCH", body: JSON.stringify({ id }) }));
  assert.equal(patched.status, 200);
  assert.equal(filters.filter(([key, value]) => key === "user_id" && value === "owner").length, 1);
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
    "@/components/call-reminder-popups": { useCallReminders: () => null },
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

function reminderHarness() {
  const states = [], refs = [], effects = [], requests = [], destinations = [];
  let stateIndex = 0, refIndex = 0, pathname = "/leads", fail = false;
  const { CallReminderProvider } = load("src\\components\\call-reminder-popups.tsx", {
    react: { ...React, useEffect: (effect, deps) => effects.push({ effect, deps }),
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
      useCallback: callback => callback,
      useState(initial) {
        const key = stateIndex++;
        if (!(key in states)) states[key] = initial;
        return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
      },
    },
    "next/navigation": { usePathname: () => pathname, useRouter: () => ({ push: path => destinations.push(path) }) },
    "@/lib/crm-data": { apiRequest: async (path, options) => {
      requests.push({ path, options });
      if (fail) throw new Error("Reminder save failed");
    }, errorMessage: error => error.message },
  }, { window: { dispatchEvent() {} } });
  function render() {
    stateIndex = 0; refIndex = 0; effects.length = 0;
    return CallReminderProvider({ children: null });
  }
  const context = () => render().props.value;
  const windowProps = () => render().props.children[1].props;
  function openRoute(path) {
    pathname = path; render();
    effects[1].effect();
  }
  return { context, windowProps, openRoute, requests, destinations, fail: value => { fail = value; } };
}

test("due-call popup stays visible on lead opening and clears only confirmed updates or X", async () => {
  const h = reminderHarness();
  const rows = Array.from({ length: 3 }, (_, index) => ({
    id: `reminder-${index}`, lead_id: `31000000-0000-4000-8000-00000000000${index + 1}`,
    type: "call_due", payload: { message: `Call ${index + 1}` }, is_read: false, created_at: "2026-11-16T08:30:00Z",
  }));
  h.context().receive({ notifications: [...rows, { ...rows[0], id: "assignment", type: "lead_assigned" },
    { ...rows[0], id: "read", is_read: true }, { ...rows[0], id: "invalid", lead_id: "bad" }], unread: 6 });
  assert.equal(h.windowProps().reminders.length, 3);
  h.openRoute("/reports");
  assert.equal(h.context().reminders.length, 3, "unrelated navigation must not dismiss popups");
  h.context().open(rows[0]);
  assert.equal(h.context().queueActive, true);
  assert.deepEqual(h.destinations, [`/leads/${rows[0].lead_id}`]);
  assert.equal(h.requests.length, 0);
  h.openRoute(h.destinations[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 0, "opening the lead must not mark its reminder read");
  assert.equal(h.context().reminders.length, 3);
  assert.deepEqual(h.context().openedReminderIds, [rows[0].id]);
  h.context().open(rows[0]);
  assert.equal(h.requests.length, 0, "clicking a popup for the already-open lead must not dismiss it");
  h.context().receive({ notifications: rows, unread: 3 });
  assert.equal(h.context().reminders.length, 3, "polling must keep an opened lead's reminder visible");
  h.context().receive({ notifications: rows.slice(1), unread: 2 });
  assert.deepEqual(h.context().reminders.map(row => row.id), ["reminder-1", "reminder-2"], "a confirmed update clears only that lead");
  h.windowProps().dismiss(rows[1]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.requests[0], { path: "/api/notifications", options: { method: "PATCH", body: { id: rows[1].id } } });
  assert.deepEqual(h.context().reminders.map(row => row.id), ["reminder-2"]);
  h.context().receive({ notifications: rows.slice(1), unread: 2 });
  assert.deepEqual(h.context().reminders.map(row => row.id), ["reminder-2"], "old snapshots cannot recreate confirmed X dismissals");
  h.context().receive({ notifications: [], unread: 0 });
  assert.equal(h.windowProps().reminders.length, 0, "confirmed database lead changes clear popups");
  h.openRoute("/leads");
  assert.equal(h.context().queueActive, false, "leaving details restores filtered Next navigation");
  assert.deepEqual(h.context().openedReminderIds, []);
});

test("failed popup dismissal remains actionable without automatic retries, including multiple calls on one lead", async () => {
  const h = reminderHarness();
  const rows = [0, 1].map(index => ({ id: `call-${index}`, lead_id: id, type: "call_due", payload: null,
    is_read: false, created_at: "2026-11-16T08:30:00Z" }));
  h.context().receive({ notifications: rows, unread: 2 });
  h.fail(true);
  h.openRoute(`/leads/${id}`);
  h.context().open(rows[0]);
  assert.deepEqual(h.context().openedReminderIds, rows.map(row => row.id), "Next must skip every call reminder for the opened lead");
  assert.equal(h.requests.length, 0, "opening a lead with multiple reminders must not dismiss any of them");
  h.windowProps().dismiss(rows[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 1);
  assert.equal(h.context().reminders.length, 2);
  assert.equal(h.windowProps().error, "Reminder save failed");
  h.openRoute(`/leads/${id}`);
  assert.equal(h.requests.length, 1, "failures must not cause a write/render loop");
  h.fail(false);
  h.windowProps().dismiss(rows[0]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.context().reminders.length, 1, "X retries a failed dismissal");
  h.context().receive({ notifications: [], unread: 0 });
  assert.equal(h.windowProps().error, "", "a confirmed lead change must also clear stale dismissal errors");
});

test("bell forwards due-call snapshots to popups and ignores reads overtaken by a completed write", async () => {
  const effects = [], requests = [], snapshots = [];
  let completed;
  const { NotificationBell } = load("src\\components\\notification-bell.tsx", {
    react: { ...React, useState: initial => [initial, () => {}], useEffect: effect => effects.push(effect) },
    "next/link": { __esModule: true, default: () => null },
    "next/navigation": { usePathname: () => "/leads" },
    "@/components/call-reminder-popups": { useCallReminders: () => ({ receive: snapshot => snapshots.push(snapshot) }) },
    "@/lib/crm-data": { apiRequest: () => new Promise(resolve => requests.push(resolve)), errorMessage: error => error.message,
      subscribeApiWrites: callback => { completed = callback; return () => {}; } },
  }, {
    window: { setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  });
  NotificationBell({ userId: "owner" });
  const cleanup = effects[0]();
  completed();
  requests[1]({ notifications: [], unread: 0 });
  await new Promise(resolve => setImmediate(resolve));
  requests[0]({ notifications: [{ id }], unread: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(snapshots, [{ notifications: [], unread: 0 }]);
  cleanup();
});

test("Next visits pending popup leads rather than filters, excludes the current lead, and respects saves", async () => {
  const rows = [1, 2, 3].map(index => ({ id: `reminder-${index}`, lead_id: `31000000-0000-4000-8000-00000000000${index}`,
    type: "call_due", payload: null, is_read: false, created_at: "2026-11-16T08:30:00Z" }));
  const opened = [];
  let saving = false, current = rows[0].lead_id;
  const queue = { queueActive: true, reminders: rows, openedReminderIds: [rows[0].id], open: row => {
    opened.push(row.lead_id); current = row.lead_id; queue.openedReminderIds.push(row.id);
  } };
  const states = [];
  let index = 0;
  const { NextLeadButton } = load("src\\components\\next-lead-button.tsx", {
    react: { ...React, useEffect() {}, useRef: initial => ({ current: initial }),
      useState(initial) {
        const key = index++;
        if (!(key in states)) states[key] = initial;
        return [states[key], value => { states[key] = typeof value === "function" ? value(states[key]) : value; }];
      },
    },
    "next/navigation": { useRouter: () => ({ push: () => assert.fail("Reminder Next must use the popup queue") }) },
    "@/components/lead-filter-state": { useLeadNavigation: () => null },
    "@/components/call-reminder-popups": { useCallReminders: () => queue },
    "@/lib/live-leads-client": {},
    "@/lib/crm-data": { apiRequest: () => assert.fail("Do not query filtered leads for reminder navigation") },
  });
  function collect(node) {
    if (Array.isArray(node)) return node.flatMap(collect);
    if (!node?.props) return [];
    return [node, ...collect(node.props.children)];
  }
  const render = () => { index = 0; return collect(NextLeadButton({ lead: { id: current }, disabled: false, isSaving: () => saving })); };
  const button = () => render().find(node => node.type === "button");
  saving = true;
  button().props.onClick();
  assert.equal(opened.length, 0);
  assert.ok(render().some(node => node.props.role === "alert"));
  saving = false;
  button().props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [rows[1].lead_id], "skip the current popup without dismissing its reminder");
  button().props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [rows[1].lead_id, rows[2].lead_id]);
  assert.equal(queue.reminders.length, 3, "opened reminders remain visible while Next advances");
  assert.equal(button().props.disabled, true);
  assert.ok(render().some(node => node.props.role === "status" && node.props.children === "No more call reminder leads."));
  queue.reminders = [{ ...rows[0], id: "new-reminder" }];
  assert.equal(button().props.disabled, false, "new due calls reactivate reminder Next");
});

test("call popup uses a narrower width and keeps its controls within desktop and mobile viewports", async () => {
  const { chromium } = require("playwright-core");
  const { CallReminderProvider } = load("src\\components\\call-reminder-popups.tsx", {
    react: { ...React, useEffect() {}, useLayoutEffect() {}, useRef: initial => ({ current: initial }),
      useCallback: callback => callback, useState: initial => [initial === false ? true : initial, () => {}] },
    "react-dom": { createPortal: content => content },
    "next/navigation": { usePathname: () => "/leads", useRouter: () => ({ push() {} }) },
    "@/lib/crm-data": { formatDateTime: value => value },
  }, { document: { body: {} } });
  const windowElement = CallReminderProvider({ children: null }).props.children[1];
  const html = renderToStaticMarkup(windowElement.type({
    ...windowElement.props,
    reminders: [1, 2, 3].map(index => ({ id: `call-${index}`, type: "call_due", is_read: false, lead_id: id,
      payload: { message: `Scheduled call is due - Long lead name ${index}` }, created_at: "2026-11-16T08:30:00Z" })),
  }));
  const css = readFileSync(path.join(__dirname, "..", "src", "app", "globals.css"), "utf8");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 640 }, { width: 280, height: 480 }]) {
      const page = await browser.newPage({ viewport });
      try {
        await page.setContent(`<style>${css}</style>${html}`);
        const result = await page.evaluate(() => {
          const popup = document.querySelector(".call-reminder-popup");
          const bounds = popup.getBoundingClientRect();
          return { width: bounds.width, left: bounds.left, right: bounds.right,
            overflow: popup.scrollWidth > popup.clientWidth,
            controlsFit: [...popup.querySelectorAll(".call-reminder-dismiss")].every(button => {
              const control = button.getBoundingClientRect();
              return control.left >= bounds.left && control.right <= bounds.right;
            }) };
        });
        assert.equal(result.width, Math.min(320, viewport.width - 16));
        assert.ok(result.left >= 8 && result.right <= viewport.width - 8, JSON.stringify({ viewport, result }));
        assert.equal(result.overflow, false);
        assert.equal(result.controlsFit, true);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});
