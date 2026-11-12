const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const actorId = "10000000-0000-4000-8000-000000000001";
const userId = "10000000-0000-4000-8000-000000000002";
const otherId = "10000000-0000-4000-8000-000000000003";
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function load(file, overrides) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  new Function("exports", "require", source)(exports, name => {
    if (name in overrides) return overrides[name];
    if (name.startsWith("@/")) return load(name.replace("@/", "src\\").replaceAll("/", "\\") + ".ts", overrides);
    return require(name);
  });
  return exports;
}
function fixture({ role = "admin", permissions = ["integrations.view", "integrations.manage"], active = true, deleted = false, fail = false, race = false } = {}) {
  const rows = new Map(), writes = [];
  let acquisitions = 0;
  const profiles = [
    { id: userId, full_name: "Test agent", email: "agent@example.test", status: active ? "active" : "inactive", deleted_at: deleted ? "2026-01-01" : null },
    { id: otherId, full_name: "Other agent", email: "other@example.test", status: "active", deleted_at: null },
  ];
  const client = { from(table) {
    assert.ok(["profiles", "telecmi_agent_mappings"].includes(table));
    const filters = [];
    let mode = "select", patch;
    async function execute(single = false) {
      if (fail) return { data: null, error: { message: "Database unavailable" } };
      const source = table === "profiles" ? profiles : [...rows.values()];
      const matches = source.filter(row => filters.every(([key, value]) => row[key] === value));
      if (mode === "select") return { data: single ? matches[0] ?? null : matches, error: null };
      if (race) return { data: null, error: mode === "insert" ? { code: "23505" } : null };
      if (mode === "insert" || mode === "update") {
        const duplicate = [...rows.values()].some(row => row.agent_id === patch.agent_id && (mode === "insert" || row.user_id !== matches[0]?.user_id));
        if (duplicate || (mode === "insert" && rows.has(patch.user_id))) return { error: { code: "23505" }, data: null };
        if (mode === "insert") rows.set(patch.user_id, patch);
        else if (matches[0]) rows.set(matches[0].user_id, { ...matches[0], ...patch });
      } else if (matches[0]) rows.delete(matches[0].user_id);
      writes.push(mode);
      return { data: mode === "insert" ? patch : matches[0] ?? null, error: null };
    }
    const query = {
      select() { return query; }, order() { return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      is(key, value) { filters.push([key, value]); return query; },
      insert(value) { mode = "insert"; patch = value; return query; },
      update(value) { mode = "update"; patch = value; return query; },
      delete() { mode = "delete"; return query; },
      maybeSingle: () => execute(true),
      then: (resolve, reject) => execute().then(resolve, reject),
    };
    return query;
  } };
  const mocks = {
    "@/lib/server/auth": {
      HttpError, readJson: request => request.json(),
      requireUser: async permission => {
        if (!permissions.includes(permission)) throw new HttpError(403, "Permission denied");
        return { user: { id: actorId, profile: { role }, permissions } };
      },
      jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
    },
    "@/lib/server/integration-settings": { assertIntegrationAdmin(user) {
      if (!["admin", "super_admin"].includes(user.profile.role) || !user.permissions.includes("integrations.manage")) throw new HttpError(403, "Only integration administrators may edit.");
    } },
    "@/lib/server/login": { checkOrigin(request) { if (request.headers.get("origin") !== "https://crm.test") throw new HttpError(403, "Invalid origin"); } },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { acquisitions++; return client; } },
    "next/server": { NextResponse: Response },
  };
  const route = load("src\\app\\api\\integrations\\telecmi\\route.ts", mocks);
  return {
    rows, writes, route, acquisitions: () => acquisitions,
    post: (body, origin = "https://crm.test") => route.POST(new Request("https://crm.test/api/integrations/telecmi", { method: "POST", headers: { origin }, body: JSON.stringify(body) })),
  };
}
test("TeleCMI agent mappings create, list, update and remove", async () => {
  const f = fixture();
  assert.equal((await f.post({ action: "save", userId, agentId: " 101_test_agent ", revision: null })).status, 200);
  const first = f.rows.get(userId);
  assert.equal(first.agent_id, "101_test_agent");
  assert.equal(first.updated_by, actorId);
  const listing = await f.route.GET();
  assert.equal(listing.headers.get("cache-control"), "no-store");
  const data = await listing.json();
  assert.equal("callingEnabled" in data, false);
  assert.equal(data.users[0].email, "agent@example.test");
  assert.equal(data.mappings[0].agent_id, "101_test_agent");
  assert.equal((await f.post({ action: "save", userId, agentId: "new_agent", revision: first.revision })).status, 200);
  const second = f.rows.get(userId);
  assert.notEqual(second.revision, first.revision);
  assert.equal((await f.post({ action: "remove", userId, revision: first.revision })).status, 409);
  assert.equal((await f.post({ action: "remove", userId, revision: second.revision })).status, 200);
  assert.equal(f.rows.size, 0);
});
test("TeleCMI mapping rejects duplicate agents, invalid users, invalid inputs and stale revisions", async () => {
  const f = fixture();
  await f.post({ action: "save", userId, agentId: "agent_1", revision: null });
  assert.equal((await f.post({ action: "save", userId: otherId, agentId: "agent_1", revision: null })).status, 409);
  assert.equal((await f.post({ action: "save", userId, agentId: "replacement", revision: null })).status, 409);
  for (const agentId of ["", "has spaces", "x".repeat(101), "<script>", "a\nb"]) {
    assert.equal((await f.post({ action: "save", userId: otherId, agentId, revision: null })).status, 400);
  }
  assert.equal((await f.post({ action: "save", userId: "invalid", agentId: "agent", revision: null })).status, 400);
  assert.equal((await f.post({ action: "save", userId: actorId, agentId: "agent", revision: null })).status, 400);
  assert.equal((await f.post({ action: "save", userId: otherId, agentId: "agent", revision: null, callingEnabled: true })).status, 400);
  for (const options of [{ active: false }, { deleted: true }]) {
    const restricted = fixture(options);
    assert.equal((await restricted.post({ action: "save", userId, agentId: "agent", revision: null })).status, 400);
    assert.equal(restricted.writes.length, 0);
  }
});
test("only integration admins can see mappings or mutate them; origin, DB errors and races surface", async () => {
  for (const options of [
    { role: "counselor" }, { role: "manager" }, { role: "team_lead" },
    { role: "admin", permissions: ["integrations.view"] },
  ]) {
    const f = fixture(options);
    const data = await (await f.route.GET()).json();
    assert.equal(data.canManage, false);
    assert.deepEqual(data.mappings, []);
    assert.deepEqual(data.users, []);
    assert.equal((await f.post({ action: "save", userId, agentId: "agent", revision: null })).status, 403);
    assert.equal(f.acquisitions(), 0);
  }
  assert.equal((await fixture({ permissions: [] }).route.GET()).status, 403);
  const crossOrigin = fixture();
  assert.equal((await crossOrigin.post({ action: "save", userId, agentId: "agent", revision: null }, "https://other.test")).status, 403);
  assert.equal(crossOrigin.acquisitions(), 0);
  assert.equal((await fixture({ fail: true }).route.GET()).status, 500);
  assert.equal((await fixture({ fail: true }).post({ action: "save", userId, agentId: "agent", revision: null })).status, 500);
  const racing = fixture({ race: true });
  assert.equal((await racing.post({ action: "save", userId, agentId: "agent", revision: null })).status, 409);
  const revision = "20000000-0000-4000-8000-000000000001";
  racing.rows.set(userId, { user_id: userId, agent_id: "agent", revision });
  assert.equal((await racing.post({ action: "save", userId, agentId: "new_agent", revision })).status, 409);
  assert.equal((await racing.post({ action: "remove", userId, revision })).status, 409);
});

test("TeleCMI call action delegates only after lead-access checks", async () => {
  const requestId = "20000000-0000-4000-8000-000000000001";
  const initiated = [];
  for (const scenario of ["accessible", "hidden", "archived", "forbidden"]) {
    let writes = 0;
    const route = load("src\\app\\api\\leads\\[id]\\actions\\route.ts", {
      "next/server": { NextResponse: Response },
      "@/lib/server/auth": {
        HttpError, readJson: request => request.json(),
        requireUser: async permission => {
          assert.equal(permission, "leads.edit");
          if (scenario === "forbidden") throw new HttpError(403, "Permission denied");
          return { user: { id: actorId, profile: { role: "counselor" }, permissions: ["leads.edit"] }, supabase: { from() { writes++; throw new Error("No database writes allowed"); } } };
        },
        jsonError: error => Response.json({ error: error.message }, { status: error.status ?? 500 }),
      },
      "@/lib/crm-data": { fetchLead: async () => scenario === "hidden" ? null : { id: userId, isArchived: scenario === "archived" } },
      "@/lib/live-leads": { uuid: value => value },
      "@/lib/server/login": { checkOrigin() {} },
      "@/lib/server/telecmi": { initiateTelecmiCall: async (...args) => {
        initiated.push(args);
        return { ok: true, requestId, message: "Call request accepted." };
      } },
      "@/lib/server/operational-gmail": {}, "@/lib/server/email-signature": {},
      "@/lib/server/note-images": {}, "@/lib/supabase/server": {},
    });
    const result = await route.POST(new Request("https://crm.test/api/leads/lead/actions", {
      method: "POST", body: JSON.stringify({ action: "telecmi_call", requestId, userId: otherId, agentId: "another-agent", to: "untrusted-number" }),
    }), { params: Promise.resolve({ id: userId }) });
    assert.equal(result.status, scenario === "accessible" ? 200 : scenario === "forbidden" ? 403 : 404);
    if (scenario === "accessible") {
      assert.deepEqual(await result.json(), { ok: true, requestId, message: "Call request accepted." });
      assert.equal(initiated.at(-1)[0].id, userId);
      assert.equal(initiated.at(-1)[1].id, actorId);
      assert.equal(initiated.at(-1)[1].profile.role, "counselor");
      assert.equal(initiated.at(-1)[2], requestId);
      assert.equal(initiated.at(-1).length, 3, "client-supplied identity and destination are not forwarded");
    }
    assert.equal(writes, 0);
  }
  assert.equal(initiated.length, 1);
});

test("TeleCMI isolates counsellor mappings and surfaces reservation, provider and logging failures without resending", async () => {
  const requestId = "40000000-0000-4000-8000-000000000001";
  const lead = { id: otherId, phone: "+919876543210", assigneeId: otherId };
  const originalFetch = global.fetch;
  const scenarios = [
    { name: "first counsellor", actor: actorId, agent: "agent-one" },
    { name: "second counsellor", actor: userId, agent: "agent-two" },
    { name: "missing mapping", mapping: null, status: 409, sent: 0 },
    { name: "mapping unavailable", mappingError: true, status: 503, sent: 0 },
    { name: "invalid request ID", requestId: "invalid", status: 400, sent: 0 },
    { name: "invalid phone", phone: "invalid", status: 400, sent: 0 },
    { name: "missing secret", token: "", status: 503, sent: 0 },
    { name: "cooldown", claim: null, status: 409, sent: 0 },
    { name: "claim failure", claimError: true, status: 503, sent: 0 },
    { name: "invalid claim", claim: {}, status: 503, sent: 0 },
    { name: "wrong reservation", claim: { claimed: true, id: otherId, status: "requesting", provider_request_id: null }, status: 503, sent: 0 },
    { name: "pending duplicate", claim: { claimed: false, id: requestId, status: "requesting", provider_request_id: null }, status: 409, sent: 0 },
    { name: "invalid accepted duplicate", claim: { claimed: false, id: requestId, status: "accepted", provider_request_id: null }, status: 503, sent: 0 },
    { name: "text authentication error", response: () => new Response("Unauthorized", { status: 401 }), status: 502, outcome: "rejected" },
    { name: "invalid agent", response: () => Response.json({ code: 401 }), status: 502, outcome: "rejected" },
    { name: "invalid destination", response: () => Response.json({ code: 404 }), status: 502, outcome: "rejected" },
    { name: "provider rate limit", response: () => new Response("", { status: 429 }), status: 429, outcome: "rejected" },
    { name: "timeout", response: () => { throw new Error("Provider timed out"); }, status: 502, outcome: "unknown" },
    { name: "malformed JSON", response: () => new Response("not JSON"), status: 502, outcome: "unknown" },
    { name: "missing provider ID", response: () => Response.json({ code: 200 }), status: 502, outcome: "unknown" },
    { name: "provider server error", response: () => Response.json({ code: 401 }, { status: 500 }), status: 502, outcome: "unknown" },
    { name: "logging failure", finishError: true, status: 502, outcome: "accepted" },
  ];
  try {
    for (const scenario of scenarios) {
      const actor = { id: scenario.actor ?? actorId, profile: { fullName: scenario.name, role: "counselor" }, permissions: ["leads.edit"] };
      const requests = [], writes = [], filters = [];
      const admin = {
        from(table) {
          assert.equal(table, "telecmi_agent_mappings");
          const query = {
            select() { return query; },
            eq(key, value) { filters.push([key, value]); return query; },
            maybeSingle: async () => ({
              data: scenario.mapping === null ? null : { agent_id: scenario.agent ?? "agent-one" },
              error: scenario.mappingError ? { message: "Unavailable" } : null,
            }),
          };
          return query;
        },
        async rpc(name, args) {
          writes.push({ name, args });
          if (name === "claim_telecmi_call") return {
            data: "claim" in scenario ? scenario.claim : { claimed: true, id: requestId, status: "requesting", provider_request_id: null },
            error: scenario.claimError ? { message: "Unavailable" } : null,
          };
          assert.equal(name, "finish_telecmi_call");
          return { data: !scenario.finishError, error: scenario.finishError ? { message: "Unavailable" } : null };
        },
      };
      global.fetch = async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return scenario.response ? scenario.response() : Response.json({ code: 200, request_id: "provider-id" });
      };
      const { initiateTelecmiCall } = load("src\\lib\\server\\telecmi.ts", {
        "@/lib/server/auth": { HttpError },
        "@/lib/server/integration-settings": {
          getIntegrationConfig: async () => ({ TELECMI_APP_SECRET: scenario.token ?? "test-secret" }),
          requireIntegrationValue(values, key) {
            if (!values[key]) throw new HttpError(503, "App secret is not configured.");
            return values[key];
          },
        },
        "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
      });
      const invoke = () => initiateTelecmiCall({ ...lead, phone: scenario.phone ?? lead.phone }, actor, scenario.requestId ?? requestId);
      if (scenario.status) await assert.rejects(invoke, error => {
        assert.equal(error.status, scenario.status, scenario.name);
        assert.ok(!error.message.includes("test-secret"));
        if (scenario.finishError) assert.match(error.message, /Check your agent.*before retrying/);
        return true;
      });
      else {
        assert.equal((await invoke()).requestId, "provider-id");
        assert.deepEqual(filters, [["user_id", actor.id]]);
        assert.equal(requests[0].body.agent_id, scenario.agent);
        assert.equal(writes[0].args.actor_id, actor.id);
        assert.equal(writes[0].args.actor_name, scenario.name);
        assert.equal(writes[0].args.target_lead_id, lead.id);
      }
      assert.equal(requests.length, scenario.sent ?? 1, scenario.name);
      if (scenario.outcome) assert.equal(writes.at(-1).args.outcome, scenario.outcome, scenario.name);
      if (scenario.sent === 0) assert.ok(writes.every(write => write.name === "claim_telecmi_call"), scenario.name);
    }
  } finally { global.fetch = originalFetch; }
});

test("TeleCMI call sends the verified agent and normalized lead number, then records provider acceptance", async () => {
  const requestId = "30000000-0000-4000-8000-000000000001";
  const actor = { id: actorId, profile: { fullName: "Test agent" } };
  const rpcCalls = [];
  let duplicate = false;
  const admin = {
    from(table) {
      assert.equal(table, "telecmi_agent_mappings");
      const query = {
        select() { return query; },
        eq() { return query; },
        maybeSingle: async () => ({ data: { agent_id: "agent_101" }, error: null }),
      };
      return query;
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === "claim_telecmi_call") return { data: duplicate
        ? { claimed: false, id: requestId, status: "accepted", provider_request_id: "provider-request-1" }
        : { claimed: true, id: requestId, status: "requesting", provider_request_id: null }, error: null };
      return { data: true, error: null };
    },
  };
  const service = load("src\\lib\\server\\telecmi.ts", {
    "@/lib/server/auth": { HttpError },
    "@/lib/server/integration-settings": {
      getIntegrationConfig: async () => ({ TELECMI_APP_SECRET: "test-secret" }),
      requireIntegrationValue: (values, key) => values[key],
    },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    return Response.json({ code: 200, request_id: "provider-request-1" });
  };
  try {
    const result = await service.initiateTelecmiCall(
      { id: userId, phone: "98765 43210", countryCode: "India (+91)" },
      actor,
      requestId,
    );
    assert.equal(result.ok, true);
    assert.equal(result.requestId, "provider-request-1");
    assert.match(result.message, /Connection is not yet confirmed/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://piopiy.telecmi.com/v1/adminConnect");
    assert.equal(requests[0].init.redirect, "error");
    assert.equal(requests[0].init.cache, "no-store");
    assert.deepEqual(JSON.parse(requests[0].init.body), {
      agent_id: "agent_101", token: "test-secret", to: "919876543210", custom: requestId,
    });
    assert.deepEqual(rpcCalls.map(call => call.name), ["claim_telecmi_call", "finish_telecmi_call"]);
    assert.equal(rpcCalls[0].args.destination, "919876543210");
    assert.equal(rpcCalls[1].args.outcome, "accepted");
    assert.equal(rpcCalls[1].args.provider_id, "provider-request-1");

    duplicate = true;
    const retried = await service.initiateTelecmiCall(
      { id: userId, phone: "98765 43210", countryCode: "India (+91)" },
      actor,
      requestId,
    );
    assert.equal(retried.requestId, "provider-request-1");
    assert.equal(requests.length, 1, "an already accepted request must never be resent");
  } finally {
    global.fetch = originalFetch;
  }
});
