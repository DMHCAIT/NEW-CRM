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

function middlewareHarness({ authenticated = true, verified = true, allowed = true, sessionError = null, permissionError = null, rpc } = {}) {
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
          auth: { getUser: async () => { events.push("getUser"); return { data: { user: authenticated ? { id: "user" } : null }, error: null }; } },
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
            return name === "touch_login_session" ? { data: verified, error: sessionError }
              : { data: allowed ? permissions.DEFAULT_ROLE_PERMISSIONS.admin : [], error: permissionError };
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

test("protected pages load session, profile and permissions concurrently in one authentication pass", async () => {
  let releaseSession;
  let releasePermission;
  const harness = middlewareHarness({ rpc: name => new Promise(resolve => {
    if (name === "touch_login_session") releaseSession = resolve;
    else releasePermission = resolve;
  }) });
  let completed = false;
  const pending = harness.run("/leads/import").then(response => { completed = true; return response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseSession, "function");
  assert.equal(typeof releasePermission, "function");
  assert.deepEqual(harness.events.map(event => typeof event === "string" ? event : event.name),
    ["client", "getUser", "touch_login_session", "profile", "my_permissions"]);
  releasePermission({ data: ["leads.import"], error: null });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, "permission alone never grants access");
  releaseSession({ data: true, error: null });
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
    if (!options.authenticated && options.authenticated !== undefined) assert.deepEqual(harness.events, ["client", "getUser"]);
    if (options.sessionError) assert.equal(harness.errors.length, 1);
  }
  assert.equal((await middlewareHarness().run("/login-secrets")).status, 200);
  assert.equal((await middlewareHarness({ authenticated: false }).run("/login-secrets")).status, 307);
});

test("private API requests reach their handler without a duplicate middleware auth round trip", async () => {
  const harness = middlewareHarness({ authenticated: false });
  for (const path of ["/api/leads", "/api/leads/record", "/api/invoices", "/api/meetings", "/api/reports", "/api/users"]) {
    assert.equal((await harness.run(path)).headers.get("x-middleware-next"), "1");
  }
  assert.deepEqual(harness.events, []);
});

function loadModule(relative, dependencies) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(join(__dirname, "..", relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, {
    exports, console, URL, URLSearchParams,
    require: name => name in dependencies ? dependencies[name] : require(name),
  });
  return exports;
}

test("API handlers still reject missing, revoked, inactive and unauthorized sessions before reading lead data", async () => {
  for (const [options, expected] of [
    [{ signedIn: false }, 401], [{ verified: false }, 401],
    [{ status: "inactive" }, 401], [{ deleted: true }, 401], [{ permissions: [] }, 403],
  ]) {
    let leadReads = 0;
    const profile = { id: "actor", status: options.status ?? "active", deleted_at: options.deleted ? "2026-10-01" : null };
    const supabase = {
      auth: { getUser: async () => ({ data: { user: options.signedIn === false ? null : { id: "actor" } } }) },
      rpc: async name => ({ data: name === "is_verified_session" ? options.verified !== false : options.permissions ?? ["leads.view"], error: null }),
      from: table => {
        if (table !== "profiles") { leadReads++; throw new Error("Unauthorized data access"); }
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) };
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
      if (/^(auth|webhooks|invoice-status)\//.test(route)) continue;
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

test("sidebar fully prefetches permitted routes and overlaps fresh operational reads without caching financial data", async () => {
  const React = require("react");
  const routes = [];
  const requests = [];
  const api = client(async path => { requests.push(path); return ok({ leads: [] }); });
  const leadsPath = `/api/leads?${new URLSearchParams({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })}`;
  const items = [
    { href: "/leads", permission: "leads.view" },
    { href: "/pipeline", permission: "pipeline.view" },
    { href: "/invoices", permission: "invoices.view" },
    { href: "/meetings", permission: "meetings.view" },
    { href: "/users", permission: "users.view" },
  ].map(item => ({ ...item, label: item.href, group: "workspace", icon: () => null }));
  const hooks = { ...React, useState: value => [value, () => {}], useEffect() {} };
  const { AppShell } = loadModule("src\\components\\app-shell.tsx", {
    react: hooks, "next/link": { default: () => null },
    "next/navigation": { usePathname: () => "/", useRouter: () => ({ prefetch: href => routes.push(href) }) },
    "@/lib/navigation": { navigationItems: items },
    "@/components/role-preview-context": { RolePreviewContext: React.createContext(null) },
    "@/lib/crm-data": api,
  });
  const tree = AppShell({ children: null, user: {
    id: "actor", profile: { role: "counselor", fullName: "Counselor" },
    permissions: ["leads.view", "pipeline.view", "invoices.view", "meetings.view"],
  } });
  const links = new Map();
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node?.props) return;
    if (node.props.onFocus && node.props.href) links.set(node.props.href, node.props);
    visit(node.props.children);
  }
  visit(tree);
  assert.equal(links.has("/users"), false);
  for (const link of links.values()) assert.equal(link.prefetch, true, "dynamic destinations must be fully prefetched");
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
  await api.apiRequest("/api/invoices");
  assert.equal(requests.filter(path => path === "/api/invoices").length, 2, "completed intent reads never replace a fresh invoice read");
  assert.deepEqual(routes, ["/leads", "/leads", "/pipeline", "/invoices", "/meetings"]);
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
