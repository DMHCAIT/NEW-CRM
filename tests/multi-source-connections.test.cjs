const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createHmac, webcrypto } = require("node:crypto");
const z = require("zod");

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const auth = {
  HttpError, jsonError: (error) => ({ status: error.status, error: error.message }),
  readJson: (request) => request.json(),
  requireUser: async () => ({ user: { id: "admin", profile: { role: "admin" }, permissions: ["integrations.manage"] } }),
};
const operational = {
  databaseError(error) { if (error) throw error; },
  parseInput(schema, value) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "Invalid input");
    return parsed.data;
  },
  uuid: z.string().uuid(),
};
const config = { FACEBOOK_APP_SECRET: "test-app-secret", FACEBOOK_GRAPH_VERSION: "v25.0", FACEBOOK_APP_ID: "999", FACEBOOK_WEBHOOK_VERIFY_TOKEN: "verify", LEAD_INTAKE_SIGNING_KEY: "intake-secret" };
const settings = {
  getIntegrationConfig: async () => config,
  assertIntegrationAdmin(user) {
    if (!["admin", "super_admin"].includes(user?.profile.role) || !user?.permissions.includes("integrations.manage")) throw new HttpError(403, "Admin only");
  },
  encryptIntegrationValues: (values) => "encrypted:" + Buffer.from(JSON.stringify(values)).toString("base64"),
  decryptIntegrationValues: (value) => JSON.parse(Buffer.from(value.slice(10), "base64").toString()),
};
function load(path, mocks = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, "..", ...path.split("/")), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, {
    exports, Buffer, Date, URL, AbortSignal, Request, Response, console, crypto: webcrypto,
    process: { env: { NEXT_PUBLIC_APP_URL: "https://crm.example" } },
    require: (name) => name in mocks ? mocks[name] : require(name), ...globals,
  });
  return exports;
}
function helpers(fetch = () => assert.fail("Unexpected Meta call")) {
  return load("src/lib/server/operational-intake.ts", {
    "@/lib/server/auth": auth, "@/lib/server/operational": operational, "@/lib/server/integration-settings": settings,
  }, { fetch });
}
const intake = helpers();
function route(path, admin, overrides = {}, globals = {}) {
  return load(path, {
    "next/server": { NextResponse: { json: (data, options) => ({ ...data, status: options?.status ?? 200 }) } },
    "@/lib/server/auth": auth, "@/lib/server/operational": operational,
    "@/lib/server/integration-settings": settings, "@/lib/server/operational-intake": intake,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => admin }, ...overrides,
  }, globals);
}
const pagePath = "src/app/api/integrations/facebook-pages/route.ts";
const facebookPath = "src/app/api/webhooks/facebook/route.ts";
function mutation(method, body, origin = "https://crm.example") {
  return new Request("https://crm.example/api/integrations/facebook-pages", { method, body: JSON.stringify(body), headers: { origin, "content-type": "application/json" } });
}

test("sources accept multiple websites and Page/form IDs but reject cross-channel or malformed IDs", () => {
  const source = { name: "Website A", channel: "website", owner_id: "10000000-0000-4000-8000-000000000001" };
  assert.equal(intake.sourceSchema.safeParse(source).success, true);
  assert.equal(intake.sourceSchema.safeParse({ ...source, name: "Website B", channel: "chatbot" }).success, true);
  assert.equal(intake.sourceSchema.safeParse({ ...source, channel: "facebook", facebook_page_id: "123", facebook_form_id: "456" }).success, true);
  assert.equal(intake.sourceSchema.safeParse({ ...source, facebook_form_id: "456" }).success, false);
  assert.equal(intake.sourceSchema.safeParse({ ...source, channel: "facebook", facebook_page_id: "123", facebook_form_id: "bad" }).success, false);
});
test("intake accepts optional bounded enquiry messages but rejects non-string and oversized values", () => {
  const lead = { name: "Visitor", phone: "+919876543210" };
  assert.equal(intake.intakeLeadSchema.parse({ ...lead, message: "  Course question\nDetails  " }).message, "Course question\nDetails");
  for (const message of ["", " \n\t ", "x".repeat(10000)]) assert.equal(intake.intakeLeadSchema.safeParse({ ...lead, message }).success, true);
  for (const message of ["x".repeat(10001), null, {}, 42]) assert.equal(intake.intakeLeadSchema.safeParse({ ...lead, message }).success, false);
});

test("routing prefers exact Page/form over catch-all and never routes another Page's form", async () => {
  const rows = [
    { page: "1", source_id: "catchall", facebook_form_id: null },
    { page: "1", source_id: "form-route", facebook_form_id: "20" },
    { page: "2", source_id: "other-page", facebook_form_id: "30" },
  ];
  const admin = { from() {
    let page;
    const q = { select: () => q, eq: (key, value) => { if (key === "facebook_page_id") page = value; return q; }, then: (resolve) => resolve({ data: rows.filter(row => row.page === page), error: null }) };
    return q;
  } };
  assert.equal((await intake.facebookSource(admin, "1", "20")).source_id, "form-route");
  assert.equal((await intake.facebookSource(admin, "1", "30")).source_id, "catchall");
  assert.equal(await intake.facebookSource(admin, "2", "20"), null);
});

test("Page token lookup is encrypted, Page-scoped and never falls back for a disabled DB connection", async () => {
  const encrypted = settings.encryptIntegrationValues({ FACEBOOK_PAGE_ACCESS_TOKEN: "page-one-secret" });
  const connection = { encrypted_credentials: encrypted, is_active: true };
  const admin = { from(table) {
    assert.equal(table, "facebook_page_connections");
    let page;
    const q = { select: () => q, eq: (_key, value) => { page = value; return q; }, maybeSingle: async () => ({ data: page === "1" ? connection : null, error: null }) };
    return q;
  } };
  const legacy = { FACEBOOK_PAGE_ID: "2", FACEBOOK_PAGE_ACCESS_TOKEN: "legacy-page-two" };
  assert.equal(await intake.facebookPageToken(admin, "1", legacy), "page-one-secret");
  assert.equal(await intake.facebookPageToken(admin, "2", legacy), "legacy-page-two");
  assert.equal(await intake.facebookPageToken(admin, "3", legacy), null);
  connection.is_active = false;
  assert.equal(await intake.facebookPageToken(admin, "1", { FACEBOOK_PAGE_ID: "1", FACEBOOK_PAGE_ACCESS_TOKEN: "must-not-fallback" }), null);
});

test("Page identity rejects cross-Page tokens; read-only tests check forms and subscriptions, not lead access", async () => {
  const calls = [];
  const api = helpers(async (url, options) => {
    const path = new URL(url).pathname;
    calls.push(path);
    assert.equal(options.headers.Authorization, "Bearer page-token");
    assert.equal(options.method, undefined);
    assert.equal(new URL(url).searchParams.has("access_token"), false);
    assert.equal(new URL(url).searchParams.get("appsecret_proof"), createHmac("sha256", config.FACEBOOK_APP_SECRET).update("page-token").digest("hex"));
    return Response.json(path.endsWith("/me") ? { id: "1", name: "Page One" }
      : path.endsWith("/leadgen_forms") ? { data: [{ id: "20", name: "Course enquiry" }] }
        : { data: [{ id: "999", subscribed_fields: ["leadgen"] }] });
  });
  await assert.rejects(api.checkFacebookPage("2", "page-token", config), /different Page/);
  const result = await api.testFacebookPage("1", "page-token", config);
  assert.equal(result.identityVerified, true);
  assert.equal(result.subscriptionVerified, true);
  assert.equal(result.leadAccessProven, false);
  assert.equal(result.forms[0].id, "20");
  assert.ok(calls.every(path => /\/(me|leadgen_forms|subscribed_apps)$/.test(path)));
  const missingId = await api.testFacebookPage("1", "page-token", { ...config, FACEBOOK_APP_ID: "" });
  assert.equal(missingId.subscriptionVerified, false);
  assert.equal(missingId.subscriptionCheck, "not_verified_app_id_missing");
});

test("read-only checks surface Meta permission failures without leaking the provider payload or token", async () => {
  const api = helpers(async () => Response.json({ error: { message: "secret-provider-payload" } }, { status: 403 }));
  await assert.rejects(api.testFacebookPage("1", "private-token", config), error => error.status === 502 && !/private-token|secret-provider-payload/.test(error.message));
});

test("Page CRUD blocks non-admins and foreign origins before service access", async () => {
  const api = route(pagePath, null, {
    "@/lib/supabase/server": { getSupabaseAdminClient: () => assert.fail("No service access expected") },
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user: { profile: { role: "counselor" }, permissions: ["integrations.manage"] } }) },
  });
  assert.equal((await api.GET()).status, 403);
  assert.equal((await api.POST(mutation("POST", { page_id: "1", access_token: "private-token" }))).status, 403);
  const adminApi = route(pagePath, null, { "@/lib/supabase/server": { getSupabaseAdminClient: () => assert.fail("No service access expected") } });
  assert.equal((await adminApi.PATCH(mutation("PATCH", { page_id: "1", is_active: false }, "https://attacker.example"))).status, 403);
  assert.equal((await adminApi.DELETE(mutation("DELETE", { page_id: "1" }, "https://attacker.example"))).status, 403);
});

test("Page creation stores only encrypted credentials and responds with masked metadata", async () => {
  let saved;
  const admin = { from: () => ({ insert(row) {
    saved = row;
    return { select(columns) {
      assert.equal(columns.includes("encrypted"), false);
      return { single: async () => ({ data: { page_id: row.page_id, page_name: row.page_name }, error: null }) };
    } };
  } }) };
  const api = route(pagePath, admin, { "@/lib/server/operational-intake": { ...intake, checkFacebookPage: async () => ({ id: "1", name: "Page One" }) } });
  const result = await api.POST(mutation("POST", { page_id: "1", access_token: "private-page-token" }));
  assert.equal(result.status, 201);
  assert.ok(saved.encrypted_credentials.startsWith("encrypted:"));
  assert.equal(saved.access_token, undefined);
  assert.equal(result.page.tokenConfigured, true);
  assert.equal(result.leadAccessProven, false);
  assert.equal(JSON.stringify(result).includes("private-page-token"), false);
});

test("Page list selects metadata only and token rotation verifies Page identity before writes", async () => {
  const admin = { from: () => ({ select(columns) {
    assert.equal(columns.includes("encrypted"), false);
    return { order: async () => ({ data: [{ page_id: "1", page_name: "Page One" }], error: null }) };
  }, update: () => assert.fail("Mismatched token must not be saved") }) };
  const api = route(pagePath, admin, { "@/lib/server/operational-intake": { ...intake, checkFacebookPage: async () => { throw new HttpError(400, "different Page"); } } });
  const list = await api.GET();
  assert.equal(list.pages[0].tokenMask, "••••••••");
  assert.equal((await api.PATCH(mutation("PATCH", { page_id: "1", access_token: "wrong-page-token" }))).status, 400);
});

test("Page test action decrypts only its requested connection and performs no database mutation", async () => {
  const admin = { from: () => {
    const q = { select: () => q, eq: (column, value) => { assert.equal(column, "page_id"); assert.equal(value, "2"); return q; },
      maybeSingle: async () => ({ data: { encrypted_credentials: settings.encryptIntegrationValues({ FACEBOOK_PAGE_ACCESS_TOKEN: "page-two-token" }) }, error: null }) };
    return q;
  } };
  const api = route(pagePath, admin, { "@/lib/server/operational-intake": { ...intake, testFacebookPage: async (page, token) => {
    assert.equal(page, "2"); assert.equal(token, "page-two-token");
    return { identityVerified: true, leadAccessProven: false };
  } } });
  const result = await api.PATCH(mutation("PATCH", { page_id: "2", action: "test" }));
  assert.equal(result.leadAccessProven, false);
  assert.equal(JSON.stringify(result).includes("page-two-token"), false);
});

test("Page token rotation encrypts the replacement without exposing it; deletion remains admin/origin gated", async () => {
  let saved, deleted = false;
  const admin = { from: () => ({
    update(row) {
      saved = row;
      const q = { eq: () => q, select: () => q, maybeSingle: async () => ({ data: { page_id: "1", is_active: true }, error: null }) };
      return q;
    },
    delete() {
      deleted = true;
      const q = { eq: () => q, select: () => q, maybeSingle: async () => ({ data: { page_id: "1" }, error: null }) };
      return q;
    },
  }) };
  const api = route(pagePath, admin, { "@/lib/server/operational-intake": { ...intake, checkFacebookPage: async (page, token) => {
    assert.equal(page, "1"); assert.equal(token, "replacement-page-token"); return { id: "1", name: "Renamed Page" };
  } } });
  const result = await api.PATCH(mutation("PATCH", { page_id: "1", access_token: "replacement-page-token", is_active: true }));
  assert.equal(saved.page_name, "Renamed Page");
  assert.equal(settings.decryptIntegrationValues(saved.encrypted_credentials).FACEBOOK_PAGE_ACCESS_TOKEN, "replacement-page-token");
  assert.equal(JSON.stringify(result).includes("replacement-page-token"), false);
  assert.equal((await api.DELETE(mutation("DELETE", { page_id: "1" }))).status, 200);
  assert.equal(deleted, true);
});

test("source assignment still rejects inaccessible owners before privileged writes", async () => {
  const q = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: null, error: null }) };
  const api = route("src/app/api/integrations/sources/route.ts", null, {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user: { id: "admin", profile: { role: "admin" }, permissions: ["integrations.manage"] }, supabase: { from: () => q } }) },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => assert.fail("No service access expected") },
  });

  test("source POST returns a one-time website/chatbot key, saves only its hash and explains duplicate names", async () => {
    let duplicate = false;
    const inserts = [];
    const user = { id: "admin", profile: { role: "admin" }, permissions: ["integrations.manage"] };
    const q = { select: () => q, eq: () => q, is: () => q, maybeSingle: async () => ({ data: { id: "owner" }, error: null }) };
    const admin = { from(table) { return { insert: async value => { inserts.push({ table, value }); return { error: duplicate && table === "lead_sources" ? { code: "23505", message: "duplicate name" } : null }; } }; } };
    const api = route("src/app/api/integrations/sources/route.ts", admin, {
      "@/lib/server/auth": { ...auth, requireUser: async () => ({ user, supabase: { from: () => q } }) },
    });
    for (const channel of ["website", "chatbot"]) {
      const result = await api.POST(mutation("POST", { name: `DMHCA ${channel}`, channel, owner_id: "20000000-0000-4000-8000-000000000001", stage_id: "" }));
      assert.equal(result.status, 201);
      assert.match(result.id, /^[\da-f-]{36}$/);
      assert.match(result.apiKey, /^[\w-]{43}$/);
      const source = inserts.find(entry => entry.table === "lead_sources" && entry.value.id === result.id).value;
      assert.equal(source.api_key_hash, intake.keyHash(result.apiKey));
      assert.equal(JSON.stringify(inserts).includes(result.apiKey), false);
    }
    duplicate = true;
    const result = await api.POST(mutation("POST", { name: "DMHCA website", channel: "website", owner_id: "20000000-0000-4000-8000-000000000001" }));
    assert.equal(result.status, 409);
    assert.match(result.error, /different source name/);
  });
  const result = await api.PATCH(mutation("PATCH", {
    id: "10000000-0000-4000-8000-000000000001", owner_id: "20000000-0000-4000-8000-000000000001", stage_id: "",
  }));
  assert.equal(result.status, 400);
});

test("source GET includes form routing metadata but never selects source API keys", async () => {
  const user = { id: "admin", profile: { role: "admin" }, permissions: ["integrations.manage"] };
  const q = { select: () => q, eq: () => q, is: () => q, order: async () => ({ data: [], error: null }) };
  const admin = { from(table) {
    assert.equal(table, "lead_sources");
    return { select(columns) {
      assert.equal(columns.includes("facebook_form_id"), true);
      assert.equal(columns.includes("api_key"), false);
      return { order: async () => ({ data: [], error: null }) };
    } };
  } };
  const api = route("src/app/api/integrations/sources/route.ts", admin, {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user, supabase: { from: () => q } }) },
  });
  const result = await api.GET();
  assert.equal(result.canManage, true);
  assert.match(result.facebookRouting, /precedence/);
});

test("source GET gives non-admin managers and counselors a safe read-only shape without sensitive reads", async () => {
  for (const [role, permissions] of [
    ["manager", ["integrations.view", "integrations.manage"]],
    ["counselor", ["integrations.view", "integrations.manage"]],
    ["counselor", ["integrations.view"]],
  ]) {
    const api = route("src/app/api/integrations/sources/route.ts", null, {
      "@/lib/server/auth": { ...auth, requireUser: async (permission) => {
        assert.equal(permission, "integrations.view");
        return {
          user: { id: "viewer", profile: { role }, permissions },
          supabase: { from: () => assert.fail("Read-only viewers must not query source owners or stages") },
        };
      } },
      "@/lib/supabase/server": { getSupabaseAdminClient: () => assert.fail("Read-only viewers must not acquire the service client") },
    });
    const result = await api.GET();
    assert.equal(result.status, 200);
    assert.equal(result.canManage, false);
    assert.equal(result.sources.length, 0);
    assert.equal(result.owners.length, 0);
    assert.equal(result.stages.length, 0);
    assert.equal(result.facebookRouting, undefined);
  }
});

function facebookRequest(event, secret = config.FACEBOOK_APP_SECRET) {
  const body = JSON.stringify(event);
  return new Request("https://crm.example/api/webhooks/facebook", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") } });
}
function facebookHarness({ disabled = false, fetchedForm = "20" } = {}) {
  const writes = [], calls = [];
  let recorded = false;
  const admin = { from(table) {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({
      data: table === "lead_sources" ? { is_active: !disabled } : recorded ? { id: "event" } : null, error: null,
    }) };
    return q;
  } };
  const api = route(facebookPath, admin, { "@/lib/server/operational-intake": {
    ...intake,
    facebookPageToken: async (_admin, page) => page === "1" ? "token-one" : page === "2" ? "token-two" : null,
    facebookSource: async (_admin, page, form) => ({ source_id: `${page}:${form}` }),
    facebookGraph: async (id, token) => {
      calls.push({ id, token });
      return { id, ...(fetchedForm === null ? {} : { form_id: fetchedForm }), field_data: [{ name: "full_name", values: ["Student"] }, { name: "phone_number", values: ["+919876543210"] }] };
    },
    recordIntake: async (_admin, source, input) => { writes.push({ source, input }); recorded = true; },
  } });
  return { api, writes, calls };
}
const entry = (page, form, lead) => ({ id: page, changes: [{ field: "leadgen", value: { page_id: page, leadgen_id: lead, ...(form ? { form_id: form } : {}) } }] });

test("webhook verifies app-wide signatures before privileged access", async () => {
  const api = route(facebookPath, null, { "@/lib/supabase/server": { getSupabaseAdminClient: () => assert.fail("Must not run") } });
  assert.equal((await api.POST(facebookRequest({ object: "page", entry: [] }, "wrong-secret"))).status, 401);
  const verified = await api.GET(new Request("https://crm.example/api/webhooks/facebook?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123"));
  assert.equal(await verified.text(), "123");
});

test("webhook uses each Page's token, exact form source, and persisted replay protection", async () => {
  const h = facebookHarness();
  const event = { object: "page", entry: [entry("1", "20", "100")] };
  assert.equal((await h.api.POST(facebookRequest(event))).accepted, 1);
  assert.equal(h.writes[0].source, "1:20");
  assert.equal(h.writes[0].input.event_id, "facebook:100");
  assert.equal((await h.api.POST(facebookRequest(event))).accepted, 1);
  assert.equal(h.calls.length, 1);
  const second = facebookHarness();
  assert.equal((await second.api.POST(facebookRequest({ object: "page", entry: [entry("2", "20", "200")] }))).accepted, 1);
  assert.equal(second.calls[0].token, "token-two");
  assert.equal(h.calls[0].token, "token-one");
});

test("missing event form ID is fetched for routing; unknown Pages and disabled routes do not create leads", async () => {
  const h = facebookHarness();
  assert.equal((await h.api.POST(facebookRequest({ object: "page", entry: [entry("1", null, "100")] }))).accepted, 1);
  assert.equal(h.writes[0].source, "1:20");
  const disabled = facebookHarness({ disabled: true });
  assert.equal((await disabled.api.POST(facebookRequest({ object: "page", entry: [entry("1", "20", "100"), entry("3", "20", "300")] }))).accepted, 0);
  assert.equal(disabled.writes.length, 0);
  assert.equal(disabled.calls.length, 0);
});

test("Page/form mismatches and ambiguous missing form IDs fail without creating leads", async () => {
  const h = facebookHarness({ fetchedForm: "21" });
  assert.equal((await h.api.POST(facebookRequest({ object: "page", entry: [entry("1", "20", "100")] }))).status, 502);
  assert.equal(h.writes.length, 0);
  // Explicitly omit form_id from Graph, rather than relying on an event catch-all.
  const noForm = facebookHarness({ fetchedForm: null });
  assert.equal((await noForm.api.POST(facebookRequest({ object: "page", entry: [entry("1", null, "100")] }))).status, 502);
  assert.equal(noForm.writes.length, 0);
  const mismatched = entry("1", "20", "100");
  mismatched.changes[0].value.page_id = "2";
  assert.equal((await h.api.POST(facebookRequest({ object: "page", entry: [mismatched] }))).status, 400);
});

test("website/chatbot intake keeps independent source keys, origin gates, and replay responses", async () => {
  const sourceId = "10000000-0000-4000-8000-000000000001";
  const sourceKey = "a".repeat(43);
  let writes = 0;
  const admin = { from() {
    const q = { select: () => q, eq: (column, value) => {
      if (column === "id") assert.equal(value, sourceId);
      if (column === "api_key_hash") assert.equal(value, intake.keyHash(sourceKey));
      return q;
    }, maybeSingle: async () => ({ data: { id: sourceId, allowed_origins: ["https://website-one.example"], intake_source_settings: { channel: "chatbot" } }, error: null }) };
    return q;
  } };
  const api = route("src/app/api/webhooks/lead-intake/route.ts", admin, { "@/lib/server/operational-intake": { ...intake, recordIntake: async () => { writes++; return { status: "replayed" }; } } });
  const body = JSON.stringify({ event_id: "website-one:123", lead: { name: "Student", phone: "+919876543210" } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const send = (origin) => api.POST(new Request("https://crm.example/api/webhooks/lead-intake", { method: "POST", body, headers: {
    "content-type": "application/json", origin, authorization: ["Bearer", sourceKey].join(" "), "x-crm-source": sourceId, "x-crm-timestamp": timestamp,
    "x-crm-signature": "v1=" + createHmac("sha256", config.LEAD_INTAKE_SIGNING_KEY).update(`${timestamp}.${body}`).digest("hex"),
  } }));
  assert.equal((await send("https://website-two.example")).status, 403);
  assert.equal(writes, 0);
  const accepted = await send("https://website-one.example");
  assert.equal(accepted.status, 202);
  assert.equal(accepted.replayed, true);
  assert.equal(accepted.lead_id, undefined);
});

test("migration makes credentials service-only and enforces both routing uniqueness constraints", () => {
  const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "202610230006_multi_source_connections.sql"), "utf8");
  assert.match(sql, /drop index public\.intake_facebook_page_unique/);
  assert.match(sql, /on public\.intake_source_settings\(facebook_page_id,facebook_form_id\)/);
  assert.match(sql, /where channel = 'facebook' and facebook_form_id is null/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on public\.facebook_page_connections from public, anon, authenticated/);
  assert.doesNotMatch(sql, /grant select.*to authenticated/i);
});
