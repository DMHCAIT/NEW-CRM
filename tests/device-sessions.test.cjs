const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
function load(file, dependencies = {}) {
  const api = {};
  new Function("exports", "require", ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText)(api, name => dependencies[name] ?? require(name));
  return api;
}
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const sessionId = "10000000-0000-4000-8000-000000000099";
function harness({ role = "super_admin", self = false, absent = false, auditFails = false, dbFails = false, invalidOrigin = false, unauthenticated = false } = {}) {
  const events = [];
  const api = load("src\\app\\api\\admin\\sessions\\route.ts", {
    "next/server": { NextResponse: { json: payload => ({ status: 200, payload }) } },
    "@/lib/server/auth": {
      HttpError, readJson: async request => request.body,
      requireUser: async () => {
        if (unauthenticated) throw new HttpError(401, "Not signed in");
        return { user: { id: "actor", profile: { role } }, supabase: { auth: { getClaims: async () => ({ data: { claims: { session_id: self ? sessionId : "other" } }, error: null }) } } };
      },
      jsonError: error => ({ status: error.status ?? 500, message: error.message }),
    },
    "@/lib/server/login": { checkOrigin: () => { if (invalidOrigin) throw new HttpError(403, "Bad origin"); } },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => {
      events.push("service");
      const chain = {
        update: payload => { events.push("revoke"); assert.ok(payload.signed_out_at); return chain; },
        eq: (key, value) => { assert.equal(key, "session_id"); assert.equal(value, sessionId); return chain; },
        is: (key, value) => { assert.equal(key, "signed_out_at"); assert.equal(value, null); return chain; },
        gt: (key) => { assert.equal(key, "expires_at"); return chain; },
        select: () => chain,
        maybeSingle: async () => ({ data: absent ? null : { session_id: sessionId, user_id: "target" }, error: dbFails ? new Error("Unavailable") : null }),
        insert: async row => { events.push("audit"); assert.equal(row.action, "session.revoked"); assert.equal(row.entity_id, sessionId); return { error: auditFails ? { code: "test" } : null }; },
      };
      return { from: () => chain };
    } },
  });
  return { api, events };
}
test("device classification retains no browser name or raw user-agent", () => {
  const { deviceLabel } = load("src\\lib\\device.ts");
  for (const [agent, expected] of [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155 Safari/537.36", "Windows computer"],
    ["iPhone OS 18 Safari", "iPhone"], ["iPad Safari", "iPad"], ["Macintosh Mobile Safari", "iPad"],
    ["Android 15 Mobile Chrome", "Android phone"], ["Linux Android 14 Chrome", "Android tablet"],
    ["X11 CrOS x86_64 Chrome", "Chromebook"], ["Macintosh Intel Mac OS X Safari", "Mac"],
    ["X11 Linux x86_64 Firefox", "Linux computer"], [null, "Unknown device"], ["unrecognized", "Unknown device"],
  ]) assert.equal(deviceLabel(agent), expected);
});
test("only an authenticated Super Admin with matching origin can revoke sessions", async () => {
  for (const role of ["admin", "manager", "team_lead", "counselor"]) {
    const { api, events } = harness({ role });
    assert.equal((await api.DELETE({ body: { sessionId } })).status, 403);
    assert.deepEqual(events, []);
  }
  for (const options of [{ invalidOrigin: true }, { unauthenticated: true }]) {
    const { api, events } = harness(options);
    assert.equal((await api.DELETE({ body: { sessionId } })).status, options.invalidOrigin ? 403 : 401);
    assert.deepEqual(events, []);
  }
});
test("session revocation is targeted, audited and redirects only the revoked caller", async () => {
  for (const self of [false, true]) {
    const { api, events } = harness({ self });
    const result = await api.DELETE({ body: { sessionId } });
    assert.equal(result.status, 200);
    assert.equal(result.payload.signInRequired, self);
    assert.deepEqual(events, ["service", "revoke", "audit"]);
  }
});
test("session revocation rejects invalid or inactive sessions and reports failures", async () => {
  const invalid = harness();
  assert.equal((await invalid.api.DELETE({ body: { sessionId: "bad" } })).status, 400);
  assert.deepEqual(invalid.events, []);
  for (const [options, status] of [[{ absent: true }, 409], [{ dbFails: true }, 500], [{ auditFails: true }, 503]]) {
    const { api } = harness(options);
    const result = await api.DELETE({ body: { sessionId } });
    assert.equal(result.status, status);
    if (options.auditFails) assert.match(result.message, /was signed out/);
  }
});
