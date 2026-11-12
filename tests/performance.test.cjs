const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function client(fetch, { browser = true, now = () => Date.now(), intl = Intl } = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(join(__dirname, "..", "src", "lib", "crm-data.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(source, {
    exports,
    require: name => name === "@/lib/permissions" ? { isCrmRole: () => true } : require(name),
    fetch,
    Date: class extends Date { static now() { return now(); } },
    Intl: intl,
    Blob,
    ...(browser ? { window: {} } : {}),
  });
  return exports;
}
const ok = value => Response.json(value);

test("ten repeat lead visits within 30 seconds use one request; manual refresh bypasses cached data", async () => {
  let requests = 0;
  const api = client(async () => ok({ version: ++requests }));
  for (let visit = 0; visit < 10; visit++) {
    assert.equal((await api.apiRequest("/api/leads", { maxAgeMs: 30000 })).version, 1);
  }
  assert.equal(requests, 1);
  assert.equal((await api.apiRequest("/api/leads")).version, 2);
  assert.equal((await api.apiRequest("/api/leads", { maxAgeMs: 30000 })).version, 3);
});

test("notification write subscribers refresh only after a persisted response, including failed writes", async () => {
  let release, completions = 0, starts = 0;
  const api = client(async () => new Promise(resolve => { release = resolve; }));
  api.subscribeApiWrites(() => { starts++; });
  const unsubscribe = api.subscribeApiWrites(() => { completions++; }, "completed");
  const write = api.apiRequest("/api/leads/record", { method: "PATCH", body: { course: "Updated" } });
  assert.equal(starts, 1);
  assert.equal(completions, 0);
  release(ok({ ok: true }));
  await write;
  assert.equal(completions, 1);
  const failure = api.apiRequest("/api/leads/record", { method: "PATCH", body: {} });
  assert.equal(completions, 1);
  release(Response.json({ error: "Write failed" }, { status: 500 }));
  await assert.rejects(failure, /Write failed/);
  assert.equal(completions, 2);
  unsubscribe();
  const next = api.apiRequest("/api/leads/record", { method: "PATCH", body: {} });
  release(ok({ ok: true })); await next;
  assert.equal(completions, 2);
});

test("binary API writes preserve image bytes instead of JSON-encoding them", async () => {
  let request;
  const image = new Blob(["image-data"], { type: "image/png" });
  const api = client(async (path, init) => { request = { path, init }; return ok({ url: "https://storage.example.test/image.png" }); });
  assert.equal((await api.apiRequest("/api/users/signature-image", { body: image })).url, "https://storage.example.test/image.png");
  assert.equal(request.path, "/api/users/signature-image");
  assert.equal(request.init.headers["Content-Type"], "image/png");
  assert.equal(request.init.body, image);
});

test("simultaneous browser reads share one request without caching invoice status", async () => {
  let requests = 0;
  let release;
  const api = client(async () => {
    requests++;
    await new Promise(resolve => { release = resolve; });
    return ok({ paid: false });
  });
  const first = api.apiRequest("/api/invoices");
  const second = api.apiRequest("/api/invoices");
  assert.equal(requests, 1);
  release();
  await Promise.all([first, second]);
  const next = api.apiRequest("/api/invoices");
  assert.equal(requests, 2);
  release();
  await next;
});

test("completed navigation data is handed off once without a second invoice request", async () => {
  let requests = 0;
  const api = client(async () => ok({ version: ++requests }));
  await api.prefetchApiRead("/api/invoices");
  await api.prefetchApiRead("/api/invoices");
  assert.equal(requests, 1, "hover and click share the prepared read even after completion");
  assert.equal(api.getCachedApiRead("/api/invoices"), undefined);
  assert.equal((await api.apiRequest("/api/invoices", { usePrefetched: true })).version, 1);
  assert.equal((await api.apiRequest("/api/invoices", { usePrefetched: true })).version, 2, "another visit does not reuse consumed financial data");
});

test("prepared navigation reads expire after five seconds and manual refresh bypasses them", async () => {
  let time = 1000, requests = 0;
  const api = client(async () => ok({ version: ++requests }), { now: () => time });
  await api.prefetchApiRead("/api/courses");
  time += 5000;
  assert.equal((await api.apiRequest("/api/courses", { usePrefetched: true })).version, 2);
  await api.prefetchApiRead("/api/invoices");
  assert.equal((await api.apiRequest("/api/invoices")).version, 4);
  assert.equal((await api.apiRequest("/api/invoices", { usePrefetched: true })).version, 5);
});

test("completed preparations render synchronously without becoming a reusable financial cache", async () => {
  let time = 1000, requests = 0;
  const api = client(async () => ok({ version: ++requests }), { now: () => time });
  assert.equal(api.getPreparedApiRead("/api/invoices"), undefined);
  await api.prefetchApiRead("/api/invoices");
  assert.equal(api.getPreparedApiRead("/api/invoices").version, 1);
  assert.equal(api.getCachedApiRead("/api/invoices"), undefined);
  await api.apiRequest("/api/invoices", { usePrefetched: true });
  assert.equal(api.getPreparedApiRead("/api/invoices"), undefined);
  await api.prefetchApiRead("/api/invoices");
  time += 5000;
  assert.equal(api.getPreparedApiRead("/api/invoices"), undefined);
  await api.prefetchApiRead("/api/courses");
  await api.apiRequest("/api/courses", { method: "POST", body: {} });
  assert.equal(api.getPreparedApiRead("/api/courses"), undefined);
  await api.prefetchApiRead("/api/users");
  api.clearApiReadCache();
  assert.equal(api.getPreparedApiRead("/api/users"), undefined);
});

test("operational screens render completed intent data immediately and consume it only once", async () => {
  const saved = { invoices: [{ status: "sent" }] }, updates = [], effects = [];
  let stateIndex = 0;
  const api = client(async () => ok(saved));
  await api.prefetchApiRead("/api/invoices");
  const { useOperationalData } = loadModule("src\\app\\integrations\\operational-ui.tsx", {
    react: {
      useState: initial => { const key = stateIndex++; return [typeof initial === "function" ? initial() : initial, value => updates.push({ key, value })]; },
      useRef: initial => ({ current: initial }), useCallback: callback => callback,
      useEffect: effect => effects.push(effect),
    },
    "@/lib/crm-data": api,
  });
  const result = useOperationalData("/api/invoices");
  assert.equal(result.loading, false);
  assert.equal(result.data.invoices[0].status, "sent");
  effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.some(update => update.key === 0 && update.value === null), false);
  assert.equal(updates.some(update => update.key === 2 && update.value === true), false);
  assert.equal(api.getPreparedApiRead("/api/invoices"), undefined);
});

test("lead typing and pagination request records only while metadata is fresh; refresh reloads metadata", async () => {
  let time = 1000;
  const reads = [];
  const metadata = { leads: [{ id: "initial" }], stages: ["stage"], profiles: ["owner"], configuration: {}, user: { id: "owner" } };
  const page = { leads: [{ id: "match" }], hasMore: false, nextCursor: null };
  const api = client(async path => {
    reads.push(path);
    return ok(path.includes("metadata=0") ? page : metadata);
  }, { now: () => time });
  const { loadLeadListData, leadQueryPath, emptyFilter } = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {}, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  const base = leadQueryPath(emptyFilter());
  await api.apiRequest(base, { maxAgeMs: 30000 });
  const path = leadQueryPath({ ...emptyFilter(), query: "new employee" });
  const result = await loadLeadListData(path, { maxAgeMs: 30000 });
  assert.equal(result.leads[0].id, "match");
  assert.deepEqual(result.profiles, metadata.profiles);
  assert.equal(new URL(reads.at(-1), "http://crm.test").searchParams.get("metadata"), "0");
  await loadLeadListData(path, { maxAgeMs: 30000 });
  assert.equal(reads.length, 2, "repeat searches reuse their paginated response");
  await loadLeadListData(path, { maxAgeMs: 0 });
  assert.equal(reads.at(-1), path, "manual refresh must fetch current profiles, permissions and settings");
  time += 30000;
  await loadLeadListData(path, { maxAgeMs: 30000 });
  assert.equal(reads.at(-1), path, "expired metadata must not be reused");
  api.clearApiReadCache();
  await loadLeadListData(path, { maxAgeMs: 30000 });
  assert.equal(reads.at(-1), path);
});

test("live searches settle after 120 ms and cancel obsolete typing timers without Enter", () => {
  const updates = [], effects = [], timers = new Map(), cleared = [];
  let id = 0;
  const { useDebouncedValue } = loadModule("src\\lib\\live-leads-client.tsx", {
    react: { useState: initial => [initial, value => updates.push(value)], useEffect: effect => effects.push(effect) },
    "@/lib/crm-data": {}, "lucide-react": {}, "@/components/searchable-dropdown": {},
    "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, {
    setTimeout: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    clearTimeout: timer => { timers.delete(timer); cleared.push(timer); },
  });
  useDebouncedValue("a");
  const cleanup = effects.shift()();
  assert.equal(timers.get(1).delay, 120);
  cleanup();
  assert.deepEqual(cleared, [1]);
  useDebouncedValue("alex");
  effects.shift()();
  timers.get(2).callback();
  assert.deepEqual(updates, ["alex"]);
});

test("lead detail intent and first render reuse shared metadata, refresh never does", async () => {
  const reads = [], effects = [];
  let time = 1000;
  const metadata = { stages: ["New"], profiles: ["Employee"], configuration: { fields: [] }, user: { id: "old-user" } };
  const detail = { lead: { id: "record" }, user: { id: "current-user" }, counts: { notes: 3 } };
  const api = client(async path => { reads.push(path); return ok(path.startsWith("/api/leads?") ? metadata : detail); }, { now: () => time });
  const helpers = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {
      useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
      useEffect: effect => effects.push(effect), useRef: initial => ({ current: initial }), useCallback: callback => callback,
    }, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  const path = "/api/leads/10000000-0000-4000-8000-000000000001?section=overview";
  await api.apiRequest(helpers.leadQueryPath(helpers.emptyFilter()), { maxAgeMs: 30000 });
  const prepared = await helpers.loadLeadDetailData(path, { maxAgeMs: 30000 });
  assert.equal(new URL(reads.at(-1), "http://crm.test").searchParams.get("metadata"), "0");
  assert.deepEqual(prepared.stages, ["New"]);
  assert.equal(prepared.user.id, "current-user", "never replace current API identity with list metadata");
  const screen = helpers.useLiveLeadData(path, helpers.loadLeadDetailData, helpers.getCachedLeadDetail);
  assert.equal(screen.loading, false);
  assert.equal(screen.data.lead.id, "record");
  effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2, "hover, click and mount use one detail request");
  await screen.reload();
  assert.equal(reads.at(-1), path, "refresh includes metadata");
  api.clearApiReadCache();
  assert.equal(helpers.getCachedLeadDetail(path), undefined);
  await helpers.loadLeadDetailData(path, { maxAgeMs: 30000 });
  assert.equal(reads.at(-1), path, "a direct entry works without a prior lead-list visit");
  time += 30000;
  assert.equal(helpers.getCachedLeadDetail(path), undefined);
});

test("lead links prepare route and data once on hover/focus/touch and click starts data before routing", async () => {
  const React = require("react");
  const routes = [], reads = [], order = [];
  class Anchor {
    constructor(href) { this.href = href; this.target = ""; }
    closest() { return this; }
    hasAttribute() { return false; }
  }
  const { AppShell } = loadModule("src\\components\\app-shell.tsx", {
    react: { ...React, useEffect() {}, useLayoutEffect() {}, useRef: initial => ({ current: initial }),
      useState: initial => [initial, () => {}], useTransition: () => [false, callback => callback()] },
    "next/link": { default: () => null },
    "next/navigation": { usePathname: () => "/leads", useRouter: () => ({
      prefetch: (path, options) => { assert.equal(options.kind, "full"); routes.push(path); },
      push: path => order.push(`route:${path}`),
    }) },
    "@/lib/navigation": { navigationItems: [] },
    "@/components/role-preview-context": { RolePreviewContext: React.createContext(null) },
    "@/components/section-loading": {}, "@/components/global-lead-search": {},
    "@/lib/crm-data": { clearApiReadCache() {}, errorMessage: error => error.message },
    "@/lib/live-leads-client": { loadLeadDetailData: async path => { reads.push(path); order.push(`data:${path}`); } },
  }, { Element: Anchor, window: { location: new URL("https://crm.test/leads") } });
  const root = AppShell({ children: null, user: { id: "actor", profile: { role: "counselor", fullName: "Employee" }, permissions: ["leads.view"] } }).props.children;
  const path = "/leads/10000000-0000-4000-8000-000000000001";
  const event = { target: new Anchor(`https://crm.test${path}`) };
  root.props.onMouseOverCapture(event);
  root.props.onFocusCapture(event);
  root.props.onTouchStartCapture(event);
  assert.deepEqual(routes, [path]);
  assert.deepEqual(reads, [`/api${path}?section=overview`]);
  for (const href of ["https://crm.test/leads/new", "https://crm.test/leads/import", "https://other.test" + path]) {
    root.props.onMouseOverCapture({ target: new Anchor(href) });
  }
  assert.equal(reads.length, 1, "no speculative reads for non-detail or external links");
  root.props.onClickCapture({ ...event, button: 0, preventDefault() {} });
  assert.deepEqual(order.slice(-2), [`data:/api${path}?section=overview`, `route:${path}`]);
});

test("an open lead prepares one shared workspace for all tabs, but refresh and mutations stay fresh", async () => {
  const reads = [];
  const base = "/api/leads/10000000-0000-4000-8000-000000000001";
  const detail = { lead: { id: "record" }, stages: ["New"], profiles: [], configuration: {}, notes: ["Note"], emails: ["Email"], activities: ["Change"], sectionErrors: {} };
  const api = client(async path => { reads.push(path); return ok(detail); });
  const helpers = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {}, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  await helpers.loadLeadDetailData(`${base}?section=overview`, { maxAgeMs: 30000 });
  for (const section of ["courses", "invoices", "calls"]) {
    await helpers.loadLeadDetailData(`${base}?section=${section}`, { maxAgeMs: 30000 });
  }
  assert.equal(reads.length, 1, "record-only tabs already have the overview; no redundant lead request");
  await helpers.loadLeadDetailData(`${base}?section=workspace`, { maxAgeMs: 30000 });
  assert.equal(reads.at(-1), `${base}?section=workspace&metadata=0`, "direct entry also reuses overview metadata");
  for (const section of ["note", "email", "overview&history=1", "calls&history=1", "courses", "invoices"]) {
    const result = await helpers.loadLeadDetailData(`${base}?section=${section}`, { maxAgeMs: 30000 });
    assert.equal(result.lead.id, "record");
  }
  assert.equal(reads.length, 2, "prepared related lists add no requests on click");
  await helpers.loadLeadDetailData(`${base}?section=workspace`, { maxAgeMs: 30000, forceFresh: true });
  assert.equal(reads.length, 3, "retry bypasses completed preparations");
  await helpers.loadLeadDetailData(`${base}?section=note`, { maxAgeMs: 30000 });
  assert.equal(reads.length, 3, "a successful retry is available to subsequent tabs");
  await helpers.loadLeadDetailData(`${base}?section=note`, { maxAgeMs: 0 });
  assert.equal(reads.length, 4, "manual refresh still contacts the server");
  await api.apiRequest(base, { method: "PATCH", body: { name: "Changed" } });
  assert.equal(helpers.getCachedLeadDetail(`${base}?section=email`), undefined);
});

test("a failed prepared section is retried rather than displayed as an empty successful list", async () => {
  const reads = [], base = "/api/leads/record";
  const api = client(async path => {
    reads.push(path);
    return ok({ lead: { id: "record" }, stages: [], profiles: [], configuration: {}, sectionErrors: path.includes("workspace") ? { email: "Mailbox failed", history: "Timeline failed" } : {} });
  });
  const helpers = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {}, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  await helpers.loadLeadDetailData(`${base}?section=workspace`, { maxAgeMs: 30000 });
  await helpers.loadLeadDetailData(`${base}?section=note`, { maxAgeMs: 30000 });
  assert.equal(reads.length, 1);
  await helpers.loadLeadDetailData(`${base}?section=email`, { maxAgeMs: 30000 });
  assert.equal(reads.length, 2);
  await helpers.loadLeadDetailData(`${base}?section=calls&history=1`, { maxAgeMs: 30000 });
  assert.equal(reads.length, 3);
});

test("clicking a related list during workspace preparation shares the in-flight authorized read", async () => {
  const reads = [], base = "/api/leads/record";
  let release;
  const api = client(async path => {
    reads.push(path);
    await new Promise(resolve => { release = resolve; });
    return ok({ lead: { id: "record" }, stages: [], profiles: [], configuration: {}, notes: ["Prepared"], sectionErrors: {} });
  });
  const helpers = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {}, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  const preparing = helpers.loadLeadDetailData(`${base}?section=workspace`, { maxAgeMs: 30000 });
  const clicking = helpers.loadLeadDetailData(`${base}?section=note`, { maxAgeMs: 30000 });
  assert.equal(reads.length, 1);
  release();
  const [workspace, notes] = await Promise.all([preparing, clicking]);
  assert.deepEqual(notes.notes, workspace.notes);
  assert.equal(reads.length, 1);
});

test("a prepared tab is visible on the first render after switching, before effects run", async () => {
  const api = client(async () => ok({ lead: { id: "record" }, notes: ["Prepared"], sectionErrors: {} }));
  const states = [], refs = [];
  let stateIndex = 0, refIndex = 0, reads = 0;
  const helpers = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {
      useEffect() {}, useCallback: callback => callback,
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
      useState(initial) { const key = stateIndex++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key], value => { states[key] = value; }]; },
    }, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  await helpers.loadLeadDetailData("/api/leads/record?section=workspace", { maxAgeMs: 30000 });
  const render = path => { stateIndex = 0; refIndex = 0; return helpers.useLiveLeadData(path, async () => { reads++; }, helpers.getCachedLeadDetail); };
  render("/api/leads/record?section=overview");
  const notes = render("/api/leads/record?section=note");
  assert.equal(notes.loading, false);
  assert.deepEqual(notes.data.notes, ["Prepared"]);
  assert.equal(reads, 0);
  const other = render("/api/leads/another?section=note");
  assert.equal(other.loading, true, "never treat another lead's history as prepared");
});

test("metadata arriving during an initial workspace read does not start a second record-only preparation", async () => {
  const reads = [], base = "/api/leads/record";
  let release;
  const detail = { lead: { id: "record" }, stages: [], profiles: [], configuration: {}, sectionErrors: {} };
  const api = client(async path => {
    reads.push(path);
    if (path.includes("workspace")) await new Promise(resolve => { release = resolve; });
    return ok(detail);
  });
  const helpers = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {}, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  const initial = helpers.loadLeadDetailData(`${base}?section=workspace`, { maxAgeMs: 30000 });
  await api.apiRequest(`${base}?section=overview`, { maxAgeMs: 30000 });
  const rerender = helpers.loadLeadDetailData(`${base}?section=workspace`, { maxAgeMs: 30000 });
  assert.equal(reads.filter(path => path.includes("workspace")).length, 1);
  release();
  await Promise.all([initial, rerender]);
});

test("operational snapshots expire, are invalidated, and never replace fresh financial requests", async () => {
  let time = 1000, version = 0;
  const api = client(async () => ok({ version: ++version }), { now: () => time });
  await api.prefetchApiRead("/api/invoices?leadId=first");
  time += 6000;
  assert.equal(api.getPreparedApiRead("/api/invoices?leadId=first"), undefined);
  assert.equal(api.getApiReadSnapshot("/api/invoices?leadId=first").version, 1);
  assert.equal(api.getApiReadSnapshot("/api/invoices?leadId=second"), undefined);
  assert.equal(api.getCachedApiRead("/api/invoices?leadId=first"), undefined);
  await api.apiRequest("/api/invoices?leadId=first", { usePrefetched: true });
  assert.equal(version, 2, "an older display snapshot never satisfies a financial read");
  time += 30000;
  assert.equal(api.getApiReadSnapshot("/api/invoices?leadId=first"), undefined);
  await api.apiRequest("/api/courses");
  await api.apiRequest("/api/courses", { method: "POST", body: {} });
  assert.equal(api.getApiReadSnapshot("/api/courses"), undefined);
  await api.apiRequest("/api/courses");
  api.clearApiReadCache();
  assert.equal(api.getApiReadSnapshot("/api/courses"), undefined);
});

test("an invoice revisit shows its snapshot immediately while a new payment check is pending", async () => {
  let requests = 0, release;
  const api = client(async () => {
    requests++;
    if (requests > 1) await new Promise(resolve => { release = resolve; });
    return ok({ invoice: requests === 1 ? "unpaid" : "paid" });
  });
  await api.apiRequest("/api/invoices");
  const states = [], refs = [], effects = [];
  let index = 0, refIndex = 0;
  const { useOperationalData } = loadModule("src\\app\\integrations\\operational-ui.tsx", {
    react: {
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
      useCallback: callback => callback, useEffect: effect => effects.push(effect),
      useState(initial) { const key = index++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key], value => { states[key] = value; }]; },
    }, "@/lib/crm-data": api,
  });
  const render = () => { index = 0; refIndex = 0; return useOperationalData("/api/invoices"); };
  assert.equal(render().data.invoice, "unpaid");
  assert.equal(render().loading, false);
  effects[0]();
  assert.equal(requests, 2);
  assert.equal(render().refreshing, true);
  assert.equal(render().data.invoice, "unpaid");
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(render().data.invoice, "paid");
  assert.equal(render().refreshing, false);
});

test("lead record links do not launch automatic viewport route requests", () => {
  for (const relative of ["src\\components\\leads-workspace.tsx", "src\\app\\pipeline\\page.tsx", "src\\components\\global-lead-search.tsx", "src\\lib\\live-leads-client.tsx"]) {
    const source = readFileSync(join(__dirname, "..", relative), "utf8");
    const links = source.match(/<Link\b[^>]*href=\{`\/leads\/[^>]*>/g) ?? [];
    assert.ok(links.length, relative);
    for (const link of links) assert.match(link, /prefetch=\{false\}/, relative);
  }
});

test("top-bar search requests results on change without Enter and ignores late responses", async () => {
  const React = require("react");
  const states = [], refs = [], effects = [], requests = [], pending = new Map();
  let stateIndex = 0, refIndex = 0;
  const { GlobalLeadSearch } = loadModule("src\\components\\global-lead-search.tsx", {
    react: {
      ...React, useId: () => "search-results",
      useState(initial) {
        const key = stateIndex++;
        if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
        return [states[key], value => { states[key] = value; }];
      },
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
      useEffect: effect => effects.push(effect),
    },
    "next/link": { default: () => null }, "next/navigation": { usePathname: () => "/" },
    "@/lib/crm-data": {
      errorMessage: error => error.message,
      apiRequest: path => {
        const params = new URLSearchParams(path.split("?")[1]);
        const query = JSON.parse(params.get("filter")).query;
        assert.equal(params.get("metadata"), "0");
        requests.push(query);
        return new Promise((resolve, reject) => pending.set(query, { resolve, reject }));
      },
    },
    "@/lib/live-leads-client": {
      useDebouncedValue: value => value,
      emptyFilter: () => ({ criteria: [], query: "" }),
      leadQueryPath: filter => `/api/leads?${new URLSearchParams({ filter: JSON.stringify(filter) })}`,
    },
  });
  const nodes = [];
  function collect(node) {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (!node?.props) return;
    nodes.push(node); collect(node.props.children);
  }
  const render = () => {
    stateIndex = refIndex = 0; effects.length = nodes.length = 0;
    collect(GlobalLeadSearch());
    return nodes.find(node => node.type === "input");
  };
  render().props.onChange({ target: { value: "old" } });
  render();
  const cleanup = effects[1]();
  assert.deepEqual(requests, ["old"]);
  render().props.onChange({ target: { value: "new employee" } });
  render(); cleanup(); effects[1]();
  pending.get("new employee").resolve({ leads: [{ id: "new", name: "New employee", email: "new@example.com" }], hasMore: false });
  await new Promise(resolve => setImmediate(resolve));
  pending.get("old").resolve({ leads: [{ id: "old", name: "Old response" }], hasMore: false });
  await new Promise(resolve => setImmediate(resolve));
  render();
  assert.ok(nodes.some(node => node.props.href === "/leads/new"));
  assert.ok(!nodes.some(node => node.props.href === "/leads/old"));
  assert.ok(nodes.some(node => node.props.href === "/leads?q=new%20employee"));
  nodes.find(node => node.props.onKeyDown).props.onKeyDown({ key: "Escape" });
  render();
  assert.ok(!nodes.some(node => node.props.id === "search-results"));
  render().props.onChange({ target: { value: "" } });
  render(); effects[1]();
  assert.equal(requests.length, 2, "clearing search must not fetch the entire lead list");
});

test("an in-flight navigation read is consumed without launching another request", async () => {
  let release, requests = 0;
  const api = client(async () => {
    requests++;
    await new Promise(resolve => { release = resolve; });
    return ok({ ready: true });
  });
  const preparing = api.prefetchApiRead("/api/meetings");
  const consuming = api.apiRequest("/api/meetings", { usePrefetched: true });
  assert.equal(requests, 1);
  release();
  await Promise.all([preparing, consuming]);
});

test("mutations and identity changes discard prepared data including still-running preparations", async () => {
  for (const action of ["write", "identity"]) {
    let release, reads = 0;
    const api = client(async (_url, init) => {
      if (init.method !== "GET") return ok({ saved: true });
      reads++;
      if (reads === 1) await new Promise(resolve => { release = resolve; });
      return ok({ version: reads });
    });
    const prepared = api.prefetchApiRead("/api/invoices");
    if (action === "write") await api.apiRequest("/api/invoices", { method: "POST", body: {} });
    else api.clearApiReadCache();
    release();
    await prepared;
    await api.apiRequest("/api/invoices", { usePrefetched: true });
    assert.equal(reads, 2);
  }
});

test("failed navigation preparations are retried and auth/server requests never retain preparations", async () => {
  let requests = 0;
  const api = client(async () => ++requests === 1 ? Response.json({ error: "Unavailable" }, { status: 503 }) : ok({ version: requests }));
  await assert.rejects(api.prefetchApiRead("/api/invoices"), /Unavailable/);
  assert.equal((await api.apiRequest("/api/invoices", { usePrefetched: true })).version, 2);
  for (const [options, path] of [[{ browser: false }, "/api/courses"], [{ browser: true }, "/api/auth/session"]]) {
    let count = 0;
    const isolated = client(async () => ok({ version: ++count }), options);
    await isolated.prefetchApiRead(path);
    await isolated.apiRequest(path, { usePrefetched: true });
    assert.equal(count, 2);
  }
});

test("lead cache expires and remains separate for each path", async () => {
  let time = 1000;
  let requests = 0;
  const api = client(async () => ok({ version: ++requests }), { now: () => time });
  await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  await api.apiRequest("/api/leads?view=pipeline", { maxAgeMs: 30000 });
  assert.equal(requests, 2);
  time += 30001;
  assert.equal((await api.apiRequest("/api/leads", { maxAgeMs: 30000 })).version, 3);
});

test("writes invalidate lead data before and after the mutation", async () => {
  let requests = 0;
  const api = client(async () => ok({ version: ++requests }));
  await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  await api.apiRequest("/api/leads/record", { method: "PATCH", body: { name: "Updated" } });
  assert.equal((await api.apiRequest("/api/leads", { maxAgeMs: 30000 })).version, 3);
});

test("a read started before a write cannot repopulate the cache with stale data", async () => {
  let release;
  let reads = 0;
  const api = client(async (_url, init) => {
    if (init.method !== "GET") return ok({ saved: true });
    reads++;
    if (reads === 1) await new Promise(resolve => { release = resolve; });
    return ok({ version: reads });
  });
  const pending = api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  await api.apiRequest("/api/leads", { method: "POST", body: {} });
  release();
  await pending;
  await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  assert.equal(reads, 2);
});

test("errors are not cached and authorization failures clear existing cached reads", async () => {
  let requests = 0;
  const api = client(async path => {
    requests++;
    return path === "/api/denied" ? Response.json({ error: "Not signed in" }, { status: 401 }) : ok({ version: requests });
  });
  await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  await assert.rejects(api.apiRequest("/api/denied"), /Not signed in/);
  await assert.rejects(api.apiRequest("/api/denied"), /Not signed in/);
  assert.equal((await api.apiRequest("/api/leads", { maxAgeMs: 30000 })).version, 4);
});

test("server requests and authentication requests never reuse browser data", async () => {
  for (const options of [{ browser: false }, { browser: true }]) {
    let requests = 0;
    const api = client(async () => ok({ version: ++requests }), options);
    const path = options.browser ? "/api/auth/session" : "/api/leads";
    await api.apiRequest(path, { maxAgeMs: 30000 });
    await api.apiRequest(path, { maxAgeMs: 30000 });
    assert.equal(requests, 2);
  }
});

test("identity changes explicitly discard browser response data", async () => {
  let requests = 0;
  const api = client(async () => ok({ version: ++requests }));
  await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  api.clearApiReadCache();
  assert.equal((await api.apiRequest("/api/leads", { maxAgeMs: 30000 })).version, 2);
});

test("1000 lead dates reuse one formatter without changing localized output", () => {
  let constructions = 0;
  const api = client(undefined, { intl: { DateTimeFormat: class {
    constructor(...args) { constructions++; return new Intl.DateTimeFormat(...args); }
  } } });
  for (const value of [null, undefined, "", "invalid"]) assert.equal(api.formatDateTime(value), "");
  assert.equal(constructions, 0, "invalid dates do not initialize the formatter");
  const formatter = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" });
  for (let index = 0; index < 1000; index++) {
    const value = new Date(Date.UTC(2026, 9, 20, 9, index)).toISOString();
    assert.equal(api.formatDateTime(value), formatter.format(new Date(value)));
  }
  assert.equal(constructions, 1);
});

test("all dashboard chart targets use Next navigation and preserve their filter URLs", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const destinations = [];
  const exports = {};
  const source = ts.transpileModule(readFileSync(join(__dirname, "..", "src", "components", "dashboard-bar-chart.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, require: name => name === "next/link" ? {
    __esModule: true,
    default: ({ children, ...props }) => { destinations.push(props.href); return React.createElement("a", props, children); },
  } : require(name) });
  const category = "/leads?filter=country";
  const segment = "/leads?filter=country-stage";
  const legend = "/leads?filter=stage";
  const html = renderToStaticMarkup(React.createElement(exports.DashboardBarChart, {
    label: "Leads by country", emptyMessage: "No leads",
    categories: [{ label: "India", href: category, segments: [{ label: "New", value: 3, color: "#7187a3", href: segment }] }],
    legend: [{ label: "New", color: "#7187a3", href: legend }],
  }));
  assert.deepEqual(destinations, [category, segment, category, legend]);
  assert.match(html, /India, New: 3 leads/);
  assert.match(html, /<rect/);
});

function requestActor(id, permissions, profile = {}) {
  return { id, email: `${id}@example.test`, profile: {
    id, fullName: "User", email: `${id}@example.test`, phone: "", role: "admin",
    reportingTo: null, status: "active", ivrExtension: "", deletedAt: null, ...profile,
  }, permissions };
}

function middlewareHarness({ authenticated = true, verified = true, allowed = true, sessionError = null, permissionError = null, rpc, getUser } = {}) {
  const { NextRequest, NextResponse } = require("next/server");
  const events = [];
  const errors = [];
  const permissions = loadModule("src\\lib\\permissions.ts", {});
  const crm = loadModule("src\\lib\\crm-data.ts", { "@/lib/permissions": permissions });
  const currentUser = loadModule("src\\lib\\current-user.ts", {
    "@/lib/crm-data": crm, "@/lib/permissions": permissions,
  });
  const routing = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, "..", "src", "lib", "auth-routing.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: routing });
  const exports = {};
  const source = ts.transpileModule(readFileSync(join(__dirname, "..", "src", "middleware.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  vm.runInNewContext(source, {
    exports,
    Headers,
    process: { env: { NEXT_PUBLIC_SUPABASE_URL: "https://project.example", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-public-key" } },
    console: { error: (...args) => errors.push(args) },
    require: name => ({
      "next/server": { NextResponse },
      "@/lib/auth-routing": routing,
      "@/lib/current-user": currentUser,
      "@supabase/ssr": { createServerClient: () => {
        events.push("client");
        return {
          auth: { getUser: async () => { events.push("getUser"); return getUser ? getUser() : { data: { user: authenticated ? { id: "user" } : null }, error: null }; } },
          from: table => {
            assert.equal(table, "profiles");
            return { select: () => ({ eq: () => ({ maybeSingle: async () => {
              events.push("profile");
              return { data: { id: "user", full_name: "User", email: "user@example.com", phone: null,
                role: "admin", reporting_to: null, status: "active", ivr_extension: null, deleted_at: null }, error: null };
            } }) }) };
          },
          rpc: async (name, args) => {
            events.push({ name, args });
            if (rpc) return rpc(name, args);
            assert.equal(name, "crm_request_context");
            assert.equal(args.touch_session, true);
            return { data: verified ? requestActor("user", allowed ? permissions.DEFAULT_ROLE_PERMISSIONS.admin : []) : null,
              error: sessionError ?? permissionError };
          },
        };
      } },
    })[name] ?? require(name),
  });
  return { events, errors, currentUser, run: (path, headers) => exports.middleware(new NextRequest(`https://crm.example${path}`, { headers })) };
}

test("public handlers perform no middleware auth requests; login redirects are preserved", async () => {
  const harness = middlewareHarness();
  for (const path of ["/api/auth/login", "/api/auth/verify", "/api/auth/logout", "/api/auth/activity", "/reset-password", "/invoice-status/token", "/api/invoice-status/token", "/api/webhooks/provider"]) {
    assert.equal((await harness.run(path)).status, 200);
  }
  assert.equal(harness.events.length, 0);
  const login = await harness.run("/login");
  assert.equal(login.status, 307);
  assert.equal(login.headers.get("location"), "https://crm.example/");
});

test("protected pages verify Auth and fetch one live context concurrently without trusting either alone", async () => {
  let releaseAuth, releaseContext;
  const harness = middlewareHarness({
    getUser: () => new Promise(resolve => { releaseAuth = resolve; }),
    rpc: () => new Promise(resolve => { releaseContext = resolve; }),
  });
  let completed = false;
  const pending = harness.run("/leads/import").then(response => { completed = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseAuth, "function");
  assert.equal(typeof releaseContext, "function");
  assert.deepEqual(harness.events.map(event => typeof event === "string" ? event : event.name),
    ["client", "getUser", "crm_request_context"]);
  releaseContext({ data: requestActor("user", ["leads.import"]), error: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, "database context alone never grants access");
  releaseAuth({ data: { user: { id: "user" } }, error: null });
  assert.equal((await pending).status, 200);
});

test("parallel middleware checks still deny unverified sessions, missing permissions and validation errors", async () => {
  for (const [options, status] of [
    [{ verified: false }, 307],
    [{ allowed: false }, 403],
    [{ sessionError: { message: "Session service unavailable" } }, 503],
    [{ permissionError: { message: "Permission service unavailable" } }, 503],
    [{ authenticated: false }, 307],
  ]) {
    const harness = middlewareHarness(options);
    const response = await harness.run("/settings/access/users?tab=active");
    assert.equal(response.status, status);
    if (status === 307) assert.equal(new URL(response.headers.get("location")).searchParams.get("next"), "/settings/access/users?tab=active");
    if (options.authenticated === false) assert.deepEqual(harness.events.map(event => typeof event === "string" ? event : event.name),
      ["client", "getUser", "crm_request_context"]);
    if (options.sessionError) assert.equal(harness.errors.length, 1);
  }
  assert.equal((await middlewareHarness().run("/login-secrets")).status, 200);
  assert.equal((await middlewareHarness({ authenticated: false }).run("/login-secrets")).status, 307);
});

test("request context cannot replace the verified Auth identity or invent permissions", async () => {
  for (const context of [
    requestActor("other", ["leads.view"]),
    { ...requestActor("user", ["leads.view"]), profile: requestActor("other", []).profile },
    requestActor("user", ["unknown.permission"]),
  ]) {
    const harness = middlewareHarness({ rpc: async () => ({ data: context, error: null }) });
    assert.equal((await harness.run("/leads")).status, 503);
    assert.equal(harness.errors.length, 1);
  }
  const harness = middlewareHarness({ getUser: async () => ({ data: { user: null }, error: { message: "Auth rejected" } }) });
  assert.equal((await harness.run("/leads")).status, 307, "a live database context cannot replace Auth verification");
});

test("notification page reuses the bell's fresh snapshot immediately, expires it and invalidates on writes", async () => {
  const React = require("react");
  let time = 1000, requests = 0;
  const saved = { notifications: [], unread: 2 };
  const api = client(async () => { requests++; return ok(saved); }, { now: () => time });
  const { NotificationsWorkspace } = loadModule("src\\components\\notifications-workspace.tsx", {
    react: { ...React, useSyncExternalStore: (_, getSnapshot) => getSnapshot(), useEffect() {}, useState: initial => [typeof initial === "function" ? initial() : initial, () => {}] },
    "next/link": { default: () => null }, "@/lib/crm-data": api,
    "@/lib/notifications": loadModule("src\\lib\\notifications.ts", {}),
  });
  const { renderToStaticMarkup } = require("react-dom/server");
  await api.apiRequest("/api/notifications", { maxAgeMs: 15000 });
  assert.match(renderToStaticMarkup(NotificationsWorkspace()), /Recent notifications \(2 unread\)/);
  assert.doesNotMatch(renderToStaticMarkup(NotificationsWorkspace()), /Loading notifications/);
  await api.apiRequest("/api/notifications", { maxAgeMs: 15000 });
  assert.equal(requests, 1, "bell, intent and workspace share one fresh response");
  time += 15000;
  assert.match(renderToStaticMarkup(NotificationsWorkspace()), /Loading notifications/);
  await api.apiRequest("/api/notifications", { maxAgeMs: 15000 });
  assert.equal(requests, 2);
  await api.apiRequest("/api/notifications", { method: "PATCH", body: { id: "notification" } });
  assert.match(renderToStaticMarkup(NotificationsWorkspace()), /Loading notifications/);
  api.clearApiReadCache();
  assert.equal(api.getCachedApiRead("/api/notifications"), undefined);
});

test("private API requests reach their handler without a duplicate middleware auth round trip", async () => {
  const harness = middlewareHarness({ authenticated: false });
  for (const path of ["/api/leads", "/api/leads/record", "/api/invoices", "/api/meetings", "/api/reports", "/api/users"]) {
    assert.equal((await harness.run(path)).headers.get("x-middleware-next"), "1");
  }
  assert.deepEqual(harness.events, []);
});

function loadModule(relative, dependencies, globals = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(join(__dirname, "..", relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, {
    exports, console, URL, URLSearchParams, process, ...globals,
    require: name => name in dependencies ? dependencies[name]
      : name === "@/components/notification-bell" ? { NotificationBell: () => null }
      : name === "@/lib/section-preparation" ? loadModule("src\\lib\\section-preparation.ts", { "@/lib/navigation": dependencies["@/lib/navigation"] ?? { navigationItems: [] } }, globals)
      : require(name),
  });
  return exports;
}

test("API handlers still reject missing, revoked, inactive and unauthorized sessions before reading lead data", async () => {
  for (const [options, expected] of [
    [{ signedIn: false }, 401], [{ verified: false }, 401],
    [{ status: "inactive" }, 401], [{ deleted: true }, 401], [{ permissions: [] }, 403],
  ]) {
    let leadReads = 0;
    const supabase = {
      auth: { getUser: async () => ({ data: { user: options.signedIn === false ? null : { id: "actor" } } }) },
      rpc: async name => {
        assert.equal(name, "crm_request_context");
        return { data: options.verified === false ? null : requestActor("actor", options.permissions ?? ["leads.view"], {
          status: options.status ?? "active", deletedAt: options.deleted ? "2026-10-01" : null,
        }), error: null };
      },
      from: table => {
        leadReads++; throw new Error("Unauthorized data access");
      },
    };
    const auth = loadModule("src\\lib\\server\\auth.ts", {
      "react": { cache: callback => callback },
      "@/lib/supabase/server": { getSupabaseServerClient: async () => supabase },
      "@/lib/crm-data": { mapProfile: row => row, PROFILE_SELECT: "*" },
      "@/lib/server/env": { ConfigurationError: class extends Error {} },
      "@/lib/current-user": loadModule("src\\lib\\current-user.ts", {
        "@/lib/crm-data": { mapProfile: row => row, PROFILE_SELECT: "*" },
        "@/lib/permissions": loadModule("src\\lib\\permissions.ts", {}),
      }),
    });
    const route = loadModule("src\\app\\api\\leads\\route.ts", {
      "@/lib/server/auth": auth, "@/lib/crm-data": {},
      "@/lib/live-leads": {}, "@/lib/server/login": {}, "@/lib/lead-filters": {},
      "@/lib/server/lead-query": {},
    });
    const response = await route.GET(new Request("https://crm.example/api/leads"));
    assert.equal(response.status, expected);
    assert.match((await response.json()).error, /Sign in|permission/);
    assert.equal(leadReads, 0);
  }
});

test("every private API handler explicitly invokes requireUser", () => {
  const { readdirSync } = require("node:fs");
  const { relative } = require("node:path");
  const root = join(__dirname, "..", "src", "app", "api");
  let handlers = 0;
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { inspect(file); continue; }
      if (entry.name !== "route.ts") continue;
      const route = relative(root, file).replaceAll("\\", "/");
      if (/^(auth|webhooks|invoice-status)\//.test(route) || ["cron/invoices/route.ts", "cron/notifications/route.ts"].includes(route)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
      for (const node of source.statements) {
        if (!ts.isFunctionDeclaration(node) || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(node.name?.text ?? "")) continue;
        let guarded = false;
        function visit(child) {
          if (ts.isAwaitExpression(child) && ts.isCallExpression(child.expression) && child.expression.expression.getText(source) === "requireUser") guarded = true;
          ts.forEachChild(child, visit);
        }
        visit(node);
        assert.ok(guarded, `${route} ${node.name.text} must await its authentication guard`);
        handlers++;
      }
    }
  }
  inspect(root);
  assert.ok(handlers > 0, "private API handlers were discovered");
});

test("cached lead snapshots are synchronous, expire, and disappear on mutation or identity change", async () => {
  let time = 1000;
  let requests = 0;
  const api = client(async () => ok({ version: ++requests }), { now: () => time });
  assert.equal(api.getCachedApiRead("/api/leads"), undefined);
  const saved = await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  assert.equal(api.getCachedApiRead("/api/leads"), saved);
  assert.equal(api.getCachedApiRead("/api/leads", 0), undefined);
  assert.equal(requests, 1);
  time += 30000;
  assert.equal(api.getCachedApiRead("/api/leads"), undefined);
  await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  await api.apiRequest("/api/leads/record", { method: "PATCH", body: {} });
  assert.equal(api.getCachedApiRead("/api/leads"), undefined);
  await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  api.clearApiReadCache();
  assert.equal(api.getCachedApiRead("/api/leads"), undefined);
});

test("a prefetched lead screen renders its cached data without a loading flash", async () => {
  const saved = { leads: [] };
  const updates = [];
  const effects = [];
  const crm = {
    getCachedApiRead: path => path === "/api/leads" ? saved : undefined,
    apiRequest: async () => saved,
  };
  const hooks = {
    useState: initial => [typeof initial === "function" ? initial() : initial, value => updates.push(value)],
    useRef: value => ({ current: value }), useCallback: callback => callback,
    useEffect: effect => effects.push(effect),
  };
  const { useLiveLeadData } = loadModule("src\\lib\\live-leads-client.tsx", {
    react: hooks, "@/lib/crm-data": crm, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  });
  const result = useLiveLeadData();
  assert.equal(result.data, saved);
  assert.equal(result.loading, false);
  effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.includes(null), false);
  assert.equal(updates.includes(true), false);
});

test("a save completed after a section switch refreshes the current section instead of reviving an obsolete URL", async () => {
  const states = [], refs = [], requests = [];
  let stateIndex = 0, refIndex = 0;
  const { useLiveLeadData } = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {
      useState(initial) { const key = stateIndex++; if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial; return [states[key], value => { states[key] = value; }]; },
      useRef(initial) { const key = refIndex++; return refs[key] ?? (refs[key] = { current: initial }); },
      useCallback: callback => callback, useEffect() {},
    },
    "@/lib/crm-data": { getCachedApiRead: () => undefined, apiRequest: async path => { requests.push(path); return { path }; } },
    "lucide-react": {}, "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  });
  const render = path => { stateIndex = 0; refIndex = 0; return useLiveLeadData(path); };
  const oldReload = render("/api/leads/record?section=overview").reload;
  render("/api/leads/record?section=note");
  await oldReload();
  assert.deepEqual(requests, ["/api/leads/record?section=note"]);
  const current = render("/api/leads/record?section=note");
  assert.equal(current.data.path, "/api/leads/record?section=note");
  assert.equal(current.loading, false);
});

test("sidebar intent explicitly prepares full routes once and keeps payment reads fresh", async () => {
  const React = require("react");
  const routes = [];
  const requests = [];
  const api = client(async path => { requests.push(path); return ok({ leads: [] }); });
  const leadsPath = `/api/leads?${new URLSearchParams({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}`;
  const items = [
    { href: "/", permission: "dashboard.view" },
    { href: "/leads", permission: "leads.view" },
    { href: "/pipeline", permission: "pipeline.view" },
    { href: "/invoices", permission: "invoices.view" },
    { href: "/meetings", permission: "meetings.view" },
    { href: "/users", permission: "users.view" },
  ].map(item => ({ ...item, label: item.href, group: "workspace", icon: () => null }));
  const states = [];
  let stateIndex = 0;
  const hooks = { ...React, useState: initial => {
    const key = stateIndex++;
    if (!(key in states)) states[key] = initial;
    return [states[key], value => { states[key] = value; }];
  }, useRef: initial => ({ current: initial }), useEffect() {}, useLayoutEffect() {}, useTransition: () => [false, callback => callback()] };
  const { AppShell } = loadModule("src\\components\\app-shell.tsx", {
    react: hooks, "next/link": { default: () => null },
    "next/navigation": { usePathname: () => "/", useRouter: () => ({ prefetch: href => routes.push(href) }) },
    "@/lib/navigation": { navigationItems: items },
    "@/components/role-preview-context": { RolePreviewContext: React.createContext(null) },
    "@/lib/crm-data": api,
    "@/components/section-loading": loadModule("src\\components\\section-loading.tsx", {}),
    "@/components/global-lead-search": { GlobalLeadSearch: () => null },
    "@/lib/live-leads-client": { loadLeadDetailData: () => assert.fail("No detail intent expected") },
  });
  const props = { children: null, user: {
    id: "actor", profile: { role: "counselor", fullName: "Counselor" },
    permissions: ["dashboard.view", "leads.view", "pipeline.view", "invoices.view", "meetings.view"],
  } };
  const tree = AppShell(props);
  const links = new Map();
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node?.props) return;
    if (node.props.onFocus && node.props.href) links.set(node.props.href, node.props);
    visit(node.props.children);
  }
  visit(tree);
  assert.equal(links.has("/users"), false);
  for (const link of links.values()) assert.equal(link.prefetch, false, "mounting a sidebar must not trigger every destination");
  assert.deepEqual(routes, []);
  assert.deepEqual(requests, []);
  links.get("/leads").onFocus();
  links.get("/leads").onMouseEnter();
  assert.deepEqual(requests, [leadsPath]);
  await new Promise(resolve => setImmediate(resolve));
  await api.apiRequest(leadsPath, { maxAgeMs: 30000 });
  assert.equal(requests.length, 1, "destination reuses intent data");
  links.get("/pipeline").onTouchStart();
  links.get("/invoices").onMouseEnter();
  links.get("/meetings").onFocus();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [leadsPath, `${leadsPath}&view=pipeline`, "/api/invoices", "/api/meetings"]);
  assert.equal(api.getCachedApiRead("/api/invoices"), undefined);
  assert.equal(api.getCachedApiRead("/api/meetings"), undefined);
  await api.apiRequest("/api/invoices", { usePrefetched: true });
  assert.equal(requests.filter(path => path === "/api/invoices").length, 1, "the initial destination consumes its completed intent read once");
  await api.apiRequest("/api/invoices");
  assert.equal(requests.filter(path => path === "/api/invoices").length, 2, "manual refresh still reads live payment status");
  stateIndex = 0;
  visit(AppShell(props));
  assert.equal(links.get("/meetings").prefetch, false, "explicit full prefetch avoids a duplicate Link request");
  assert.equal(links.get("/invoices").prefetch, false);
  assert.deepEqual(routes, ["/leads", "/pipeline", "/invoices", "/meetings"]);
  links.get("/").onFocus();
  assert.deepEqual(routes, ["/leads", "/pipeline", "/invoices", "/meetings", "/"],
    "Dashboard intent prepares its complete server-rendered summary too");
});

test("sidebar preparation is permission-bound, limited to two sections, and stops on cleanup or hidden tabs", async () => {
  const items = [
    { href: "/", permission: "dashboard.view" }, { href: "/leads", permission: "leads.view" },
    { href: "/pipeline", permission: "pipeline.view" }, { href: "/invoices", permission: "invoices.view" },
    { href: "/courses" }, { href: "/users", permission: "users.view" },
    { href: "/admin/login-activity", permission: "access.manage" },
  ];
  const helpers = loadModule("src\\lib\\section-preparation.ts", { "@/lib/navigation": { navigationItems: items } }, { Intl });
  const user = { permissions: ["leads.view", "pipeline.view", "invoices.view", "dashboard.view", "access.manage"] };
  const started = [], pending = new Map(), errors = [];
  let visible = true;
  const task = helpers.prepareSidebarSections(user, "/", path => {
    started.push(path);
    return new Promise((resolve, reject) => pending.set(path, { resolve, reject }));
  }, { isVisible: () => visible, onError: error => errors.push(error.message) });
  assert.deepEqual(started, ["/leads", "/pipeline"]);
  pending.get("/leads").resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["/leads", "/pipeline", "/invoices"]);
  pending.get("/pipeline").reject(new Error("Cannot prepare pipeline"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ["Cannot prepare pipeline"]);
  assert.deepEqual(started, ["/leads", "/pipeline", "/invoices", "/courses"]);
  task.cancel();
  pending.get("/invoices").resolve(); pending.get("/courses").resolve();
  await task.done;
  assert.equal(started.includes("/users"), false);
  assert.equal(started.includes("/admin/login-activity"), false, "server-rendered session activity is not cached ahead of time");
  visible = false;
  const hidden = helpers.prepareSidebarSections(user, "/", () => assert.fail("hidden tab must not warm requests"), { isVisible: () => visible, onError: () => {} });
  await hidden.done;
});

test("Dashboard is prepared before a return click, without preparing unauthorized sections", async () => {
  const items = [
    { href: "/", permission: "dashboard.view" }, { href: "/leads", permission: "leads.view" },
    { href: "/pipeline", permission: "pipeline.view" },
  ];
  const helpers = loadModule("src\\lib\\section-preparation.ts", { "@/lib/navigation": { navigationItems: items } }, { Intl });
  const prepared = [];
  const options = { isVisible: () => true, onError: error => assert.fail(error.message) };
  await helpers.prepareSidebarSections({ permissions: ["dashboard.view", "leads.view"] }, "/leads",
    async href => { prepared.push(href); }, options).done;
  assert.deepEqual(prepared, ["/"]);
  prepared.length = 0;
  await helpers.prepareSidebarSections({ permissions: ["leads.view"] }, "/leads",
    async href => { prepared.push(href); }, options).done;
  assert.deepEqual(prepared, []);
});

test("automatic lead preparation is deduplicated, limited to four records and two concurrent reads", async () => {
  const helpers = loadModule("src\\lib\\section-preparation.ts", { "@/lib/navigation": { navigationItems: [] } });
  const started = [], pending = new Map(), errors = [];
  const task = helpers.prepareLeadLinks(["one", "one", "two", "three", "four", "five"], href => {
    started.push(href);
    return new Promise((resolve, reject) => pending.set(href, { resolve, reject }));
  }, { isVisible: () => true, onError: error => errors.push(error.message) });
  assert.deepEqual(started, ["/leads/one", "/leads/two"]);
  pending.get("/leads/one").resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["/leads/one", "/leads/two", "/leads/three"]);
  pending.get("/leads/two").reject(new Error("Cannot prepare lead"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ["Cannot prepare lead"]);
  assert.deepEqual(started, ["/leads/one", "/leads/two", "/leads/three", "/leads/four"]);
  pending.get("/leads/three").resolve(); pending.get("/leads/four").resolve();
  await task.done;
  const releases = [];
  const cancelled = helpers.prepareLeadLinks(["one", "two", "three"], async () => {
    await new Promise(resolve => { releases.push(resolve); });
  }, { isVisible: () => true, onError: error => assert.fail(error.message) });
  cancelled.cancel();
  releases.forEach(release => release());
  await cancelled.done;
  assert.equal(releases.length, 2, "cleanup prevents the third read from starting");
  const hidden = helpers.prepareLeadLinks(["one"], () => assert.fail("hidden tab must not prepare records"),
    { isVisible: () => false, onError: error => assert.fail(error.message) });
  await hidden.done;
});

test("prepared lead links have synchronous overview data and opening them needs no additional API read", async () => {
  const reads = [], routes = [], effects = [], timers = [];
  const api = client(async path => {
    reads.push(path);
    return ok({ lead: { id: path.split("/")[3].split("?")[0] }, stages: [], profiles: [], configuration: {} });
  });
  const helpers = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {}, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  const { LeadNavigationPreparation } = loadModule("src\\components\\lead-navigation-preparation.tsx", {
    react: { useEffect: effect => effects.push(effect), useState: initial => [initial, () => {}] },
    "next/navigation": { useRouter: () => ({ prefetch: (href, options) => { assert.equal(options.kind, "full"); routes.push(href); } }) },
    "@/lib/crm-data": api, "@/lib/live-leads-client": helpers,
  }, { window: { setTimeout: (callback, delay) => { assert.equal(delay, 0); timers.push(callback); }, clearTimeout() {} },
    document: { visibilityState: "visible" } });
  LeadNavigationPreparation({ leads: Array.from({ length: 10 }, (_, index) => ({ id: `record-${index}` })) });
  const cleanup = effects[0]();
  assert.equal(reads.length, 0, "preparation yields until the page has rendered");
  timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 4);
  assert.equal(routes.length, 4);
  for (let index = 0; index < 4; index++) {
    const path = `/api/leads/record-${index}?section=overview`;
    assert.equal(helpers.getCachedLeadDetail(path).lead.id, `record-${index}`);
    await helpers.loadLeadDetailData(path, { maxAgeMs: 30000 });
  }
  assert.equal(reads.length, 4, "all four overview visits use their completed preparations");
  cleanup();
  effects.length = 0;
  LeadNavigationPreparation({ leads: [{ id: "unauthorized" }], enabled: false });
  effects[0]();
  assert.equal(timers.length, 1, "no automatic reads without lead-view permission");
});

test("filtered lead revisits synchronously combine cached pages with current metadata", async () => {
  const reads = [];
  const api = client(async path => {
    reads.push(path);
    return ok(path.includes("metadata=0") ? { leads: [{ id: "match" }], hasMore: false, nextCursor: null }
      : { leads: [], profiles: [], stages: [], configuration: {}, user: { id: "actor" } });
  });
  const helpers = loadModule("src\\lib\\live-leads-client.tsx", {
    react: {}, "@/lib/crm-data": api, "lucide-react": {},
    "@/components/searchable-dropdown": {}, "@/lib/lead-filters": {}, "@/lib/lead-picklists": {},
  }, { window: {}, Intl });
  await helpers.loadLeadListData(helpers.leadQueryPath(helpers.emptyFilter()), { maxAgeMs: 30000 });
  const path = helpers.leadQueryPath({ ...helpers.emptyFilter(), query: "match" });
  assert.equal(helpers.getCachedLeadListData(path), undefined);
  await helpers.loadLeadListData(path, { maxAgeMs: 30000 });
  const prepared = helpers.getCachedLeadListData(path);
  assert.equal(prepared.leads[0].id, "match");
  assert.equal(prepared.user.id, "actor");
  assert.equal(reads.length, 2);
  api.clearApiReadCache();
  assert.equal(helpers.getCachedLeadListData(path), undefined);
});

test("shell identity invalidation precedes the initial page request instead of discarding it on mount", async () => {
  const React = require("react");
  const layouts = [], effects = [];
  let release;
  const api = client(async () => { await new Promise(resolve => { release = resolve; }); return ok({ leads: ["initial"] }); });
  const { AppShell } = loadModule("src\\components\\app-shell.tsx", {
    react: { ...React, useLayoutEffect: effect => layouts.push(effect), useEffect: effect => effects.push(effect),
      useRef: initial => ({ current: initial }), useState: initial => [initial, () => {}],
      useTransition: () => [false, callback => callback()] },
    "next/navigation": { usePathname: () => "/leads", useRouter: () => ({}) },
    "next/link": { default: () => null }, "@/lib/navigation": { navigationItems: [] },
    "@/components/role-preview-context": { RolePreviewContext: React.createContext(null) },
    "@/components/section-loading": {}, "@/components/global-lead-search": {},
    "@/lib/crm-data": api, "@/lib/live-leads-client": {},
  });
  AppShell({ children: null, user: { id: "actor", permissions: ["leads.view"], profile: { role: "counselor", fullName: "Actor" } } });
  assert.equal(layouts.length, 1, "identity invalidation must run during layout, before child passive loading effects");
  layouts[0]();
  const first = api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  assert.equal(api.getPendingApiRead("/api/leads") !== undefined, true);
  release();
  await first;
  assert.deepEqual(api.getCachedApiRead("/api/leads").leads, ["initial"]);
});

test("short-lived route reuse is paired with router invalidation after successful and failed writes", async () => {
  const config = readFileSync(join(__dirname, "..", "next.config.ts"), "utf8");
  assert.match(config, /staleTimes:\s*\{\s*dynamic:\s*30,\s*static:\s*30\s*\}/);
  let version = 0, fail = false, notifications = 0;
  const api = client(async () => fail ? Response.json({ error: "Write failed" }, { status: 500 }) : ok({ version: ++version }));
  await api.apiRequest("/api/leads", { maxAgeMs: 30000 });
  const unsubscribe = api.subscribeApiWrites(() => {
    notifications++;
    assert.equal(api.getCachedApiRead("/api/leads"), undefined);
    assert.equal(api.getApiReadSnapshot("/api/leads"), undefined);
  });
  await api.apiRequest("/api/leads/record", { method: "PATCH", body: { name: "Saved" } });
  assert.equal(notifications, 1);
  fail = true;
  await assert.rejects(api.apiRequest("/api/leads/record", { method: "PATCH", body: { name: "Failed" } }), /Write failed/);
  assert.equal(notifications, 2, "failed writes may have partially applied; do not retain server-rendered summaries");
  unsubscribe();
  fail = false;
  await api.apiRequest("/api/leads/record", { method: "PATCH", body: { name: "Saved" } });
  assert.equal(notifications, 2, "unmounted shells no longer receive notifications");
  const source = readFileSync(join(__dirname, "..", "src", "components", "app-shell.tsx"), "utf8");
  assert.match(source, /subscribeApiWrites\([\s\S]*?"completed"/);
  assert.match(source, /router\.refresh\(\)/);
});

test("middleware replaces forged page identities and only forwards them as request headers", async () => {
  const harness = middlewareHarness();
  const response = await harness.run("/invoices", { "x-crm-page-user": "forged" });
  const encoded = response.headers.get("x-middleware-request-x-crm-page-user");
  assert.equal(harness.currentUser.decodePageUser(encoded).id, "user");
  assert.equal(response.headers.has("x-crm-page-user"), false);
  const api = await harness.run("/api/invoices", { "x-crm-page-user": "forged" });
  assert.equal(api.headers.has("x-middleware-request-x-crm-page-user"), false);
  const publicPage = await harness.run("/reset-password", { "x-crm-page-user": "forged" });
  assert.equal(publicPage.headers.has("x-middleware-request-x-crm-page-user"), false);
});

test("development opens only intended sections and shell refresh waits for persisted writes", async () => {
  const React = require("react");
  const effects = [], routes = [];
  let release, refreshes = 0;
  const api = client(async () => new Promise(resolve => { release = resolve; }));
  const { AppShell } = loadModule("src\\components\\app-shell.tsx", {
    react: { ...React, useEffect: effect => effects.push(effect), useLayoutEffect() {},
      useRef: value => ({ current: value }), useState: value => [value, () => {}],
      useTransition: () => [false, callback => callback()] },
    "next/link": { default: () => null },
    "next/navigation": { usePathname: () => "/leads", useRouter: () => ({
      prefetch: href => routes.push(href), refresh: () => { refreshes++; },
    }) },
    "@/lib/navigation": { navigationItems: [{ href: "/", permission: "dashboard.view", group: "workspace", icon: () => null }] },
    "@/components/role-preview-context": { RolePreviewContext: React.createContext(null) },
    "@/lib/crm-data": api, "@/lib/live-leads-client": {},
    "@/components/section-loading": {}, "@/components/global-lead-search": {},
  }, { process: { env: { NODE_ENV: "development" } },
    window: { setTimeout: () => assert.fail("development must not compile speculative sections") } });
  AppShell({ children: null, user: { id: "actor", permissions: ["dashboard.view"], profile: { role: "admin", fullName: "Actor" } } });
  const unsubscribe = effects[0]();
  assert.equal(effects[1](), undefined);
  assert.deepEqual(routes, []);
  const save = api.apiRequest("/api/leads/record", { method: "PATCH", body: { name: "Saved" } });
  assert.equal(refreshes, 0, "route refresh must not race the database write");
  release(ok({ ok: true })); await save;
  assert.equal(refreshes, 1);
  const failure = api.apiRequest("/api/leads/record", { method: "PATCH", body: {} });
  assert.equal(refreshes, 1);
  release(Response.json({ error: "Save failed" }, { status: 500 }));
  await assert.rejects(failure, /Save failed/);
  assert.equal(refreshes, 2, "a potentially partial write still invalidates rendered routes");
  unsubscribe();
  const afterUnmount = api.apiRequest("/api/leads/record", { method: "PATCH", body: {} });
  release(ok({ ok: true })); await afterUnmount;
  assert.equal(refreshes, 2);
});

test("production background reads do not also launch unbounded route preparations", async () => {
  const React = require("react");
  const effects = [], timers = [], routes = [], reads = [];
  const items = [
    { href: "/", permission: "dashboard.view" }, { href: "/leads", permission: "leads.view" },
    { href: "/pipeline", permission: "pipeline.view" }, { href: "/meetings", permission: "meetings.view" },
  ].map(item => ({ ...item, group: "workspace", icon: () => null }));
  const api = client(async path => { reads.push(path); return ok({}); });
  const { AppShell } = loadModule("src\\components\\app-shell.tsx", {
    react: { ...React, useEffect: effect => effects.push(effect), useLayoutEffect() {},
      useRef: value => ({ current: value }), useState: value => [value, () => {}],
      useTransition: () => [false, callback => callback()] },
    "next/link": { default: () => null },
    "next/navigation": { usePathname: () => "/leads", useRouter: () => ({ prefetch: href => routes.push(href) }) },
    "@/lib/navigation": { navigationItems: items },
    "@/components/role-preview-context": { RolePreviewContext: React.createContext(null) },
    "@/lib/crm-data": api, "@/lib/live-leads-client": {},
    "@/components/section-loading": {}, "@/components/global-lead-search": {},
  }, { process: { env: { NODE_ENV: "production" } }, Intl,
    document: { visibilityState: "visible" },
    window: { setTimeout: callback => { timers.push(callback); return 1; }, clearTimeout() {} } });
  AppShell({ children: null, user: { id: "actor", permissions: items.map(item => item.permission), profile: { role: "admin", fullName: "Actor" } } });
  const cleanup = effects[1]();
  timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(routes, ["/"], "only the server-rendered Dashboard needs a speculative RSC request");
  assert.equal(reads.length, 2);
  assert.ok(reads.some(path => path.includes("view=pipeline")));
  assert.ok(reads.includes("/api/meetings"));
  cleanup();
});

test("a section click immediately replaces the old page with its destination, while native links keep their behavior", async () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const states = [], routes = [], preparations = [], requests = [];
  let index = 0, pending = false, pathname = "/";
  class Anchor {
    constructor(href, target = "", download = false) { this.href = href; this.target = target; this.download = download; }
    closest() { return this; }
    hasAttribute(name) { return name === "download" && this.download; }
  }
  const { AppShell } = loadModule("src\\components\\app-shell.tsx", {
    react: { ...React, useEffect() {}, useLayoutEffect() {}, useRef: initial => ({ current: initial }), useState(initial) {
      const key = index++;
      if (!(key in states)) states[key] = initial;
      return [states[key], value => { states[key] = value; }];
    }, useTransition: () => [pending, callback => { pending = true; callback(); }] },
    "next/link": { default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) },
    "next/navigation": { usePathname: () => pathname, useRouter: () => ({ push: href => routes.push(href), prefetch: href => preparations.push(href) }) },
    "@/lib/navigation": loadModule("src\\lib\\navigation.ts", {}),
    "@/components/role-preview-context": { RolePreviewContext: React.createContext(null) },
    "@/components/section-loading": loadModule("src\\components\\section-loading.tsx", {}),
    "@/components/global-lead-search": { GlobalLeadSearch: () => null },
    "@/lib/live-leads-client": { loadLeadDetailData: async path => { requests.push(path); } },
    "@/lib/crm-data": { apiRequest: async path => { requests.push(path); }, prefetchApiRead: async path => { requests.push(path); }, clearApiReadCache() {}, errorMessage: error => error.message },
  }, { Element: Anchor, window: { location: new URL("http://localhost/") } });
  const user = { id: "actor", profile: { role: "admin", fullName: "CRM Admin" }, permissions: ["dashboard.view", "invoices.view"] };
  const render = children => { index = 0; return AppShell({ user, children }); };
  const root = tree => tree.props.children;
  const click = (href, options = {}) => {
    let prevented = false;
    root(render("OLD DASHBOARD")).props.onClickCapture({
      button: 0, target: new Anchor(href, options.target, options.download), ...options,
      preventDefault() { prevented = true; },
    });
    return prevented;
  };
  for (const [href, options] of [
    ["/invoices", { ctrlKey: true }], ["/invoices", { metaKey: true }],
    ["/invoices", { shiftKey: true }], ["/invoices", { altKey: true }],
    ["/invoices", { button: 1 }], ["/invoices", { defaultPrevented: true }],
    ["/invoices", { target: "_blank" }], ["/invoices", { download: true }],
    ["https://example.com", {}], ["/api/invoices/record/pdf", {}], ["/#workspace-content", {}],
  ]) assert.equal(click(href, options), false, href);
  assert.deepEqual(routes, []);
  assert.equal(click("/invoices"), true);
  assert.deepEqual(routes, ["/invoices"]);
  assert.deepEqual(preparations, [], "clicking navigates once instead of racing a second route prefetch against the navigation");
  const html = renderToStaticMarkup(render("OLD DASHBOARD"));
  assert.match(html, /class="section-content" hidden="" inert="">OLD DASHBOARD<\/div>/, "previous content stays mounted but cannot be seen or focused");
  assert.match(html, /Opening invoices/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /nav-link-active" href="\/invoices"/);
  pending = false; pathname = "/invoices";
  assert.match(renderToStaticMarkup(render("ACTUAL INVOICE RECORDS")), /ACTUAL INVOICE RECORDS/);
  assert.deepEqual(requests, ["/api/invoices"]);
});

test("operational screens ignore old responses after a section or lead changes and refresh existing data in place", async () => {
  const states = [], effects = [], pending = new Map(), ref = { current: 0 };
  const reads = [];
  let index = 0;
  const { useOperationalData } = loadModule("src\\app\\integrations\\operational-ui.tsx", {
    react: { useRef: () => ref, useCallback: callback => callback, useEffect: effect => effects.push(effect),
      useState(initial) {
        const key = index++;
        if (!(key in states)) states[key] = typeof initial === "function" ? initial() : initial;
        return [states[key], value => { states[key] = value; }];
      } },
    "@/lib/crm-data": { getPreparedApiRead: () => undefined, getApiReadSnapshot: () => undefined, apiRequest: (url, options) => {
      reads.push({ url, options });
      return new Promise(resolve => pending.set(url, resolve));
    } },
  });
  const render = url => { index = 0; return useOperationalData(url); };
  assert.equal(render("/api/invoices?leadId=first").loading, true);
  const cleanup = effects.shift()();
  assert.equal(reads[0].options.usePrefetched, true);
  render("/api/invoices?leadId=second");
  cleanup();
  effects.shift()();
  pending.get("/api/invoices?leadId=second")({ invoice: "SECOND" });
  await new Promise(resolve => setImmediate(resolve));
  pending.get("/api/invoices?leadId=first")({ invoice: "OLD" });
  await new Promise(resolve => setImmediate(resolve));
  const current = render("/api/invoices?leadId=second");
  assert.equal(current.data.invoice, "SECOND");
  assert.equal(current.loading, false);
  const refreshing = current.refresh();
  assert.equal(reads.at(-1).options.usePrefetched, false, "refresh must not consume an old navigation preparation");
  assert.equal(render("/api/invoices?leadId=second").data.invoice, "SECOND");
  pending.get("/api/invoices?leadId=second")({ invoice: "FRESH" });
  await refreshing;
  assert.equal(render("/api/invoices?leadId=second").data.invoice, "FRESH");
});

test("server pages reuse only their middleware identity while API guards always reauthenticate", async () => {
  const permissions = loadModule("src\\lib\\permissions.ts", {});
  const currentUser = loadModule("src\\lib\\current-user.ts", {
    "@/lib/permissions": permissions, "@/lib/crm-data": {},
  });
  const user = { id: "actor", email: "actor@example.com", permissions: ["invoices.view"],
    profile: { id: "actor", fullName: "Actor \u00e9", email: "actor@example.com", phone: "",
      role: "admin", reportingTo: null, status: "active", ivrExtension: "", deletedAt: null } };
  let authentications = 0;
  let supplied = currentUser.encodePageUser(user);
  const auth = loadModule("src\\lib\\server\\auth.ts", {
    react: { cache: callback => callback },
    "next/headers": { headers: async () => new Headers(supplied === null ? {} : { "x-crm-page-user": supplied }) },
    "@/lib/current-user": { ...currentUser, loadCurrentUser: async () => { authentications++; return user; } },
    "@/lib/supabase/server": { getSupabaseServerClient: async () => ({}) },
    "@/lib/server/env": { ConfigurationError: class extends Error {} },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(await auth.getCurrentUser())), user);
  assert.equal(authentications, 0, "render adds no remote authentication after middleware");
  assert.equal((await auth.requirePageUser("invoices.view")).user.id, "actor");
  assert.equal(authentications, 0, "server page guards reuse the middleware identity too");
  await assert.rejects(auth.requirePageUser("users.manage"), /permission/);
  await auth.requireUser("invoices.view");
  assert.equal(authentications, 1, "API authentication ignores the page identity");
  supplied = currentUser.encodePageUser(null);
  assert.equal(await auth.getCurrentUser(), null);
  assert.equal(authentications, 1, "signed-out page result also avoids repeated auth");
  supplied = null;
  await auth.getCurrentUser();
  assert.equal(authentications, 2, "requests without middleware context still authenticate");
  supplied = "%not-valid";
  await assert.rejects(auth.getCurrentUser());
});
