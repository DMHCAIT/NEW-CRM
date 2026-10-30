const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function load(file, dependencies, globals = {}) {
  const api = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports: api, require: (name) => dependencies[name] ?? require(name), console: { error() {} }, ...globals });
  return api;
}
const passwordApi = load("src\\lib\\server\\password-management.ts", { "@/lib/server/auth": { HttpError } });
const id = "697c43c8-fa6b-4388-a393-8c116d759afa";

function adminMock(failure) {
  const events = [];
  const admin = {
    auth: { admin: { updateUserById: async (target, payload) => {
      events.push("password"); assert.equal(target, id); assert.equal(payload.password, "A-new-password123");
      return { error: failure === "password" ? { code: "weak_password", status: 422 } : null };
    } } },
    from: (table) => {
      const query = {
        update: () => query, delete: () => query, eq: () => query, is: () => query,
        then: (resolve) => { events.push(table); resolve({ error: failure === table ? { code: "failure" } : null }); },
        insert: async (row) => {
          events.push(table); assert.equal(row.action, "user.password_changed");
          assert.equal(JSON.stringify(row).includes("A-new-password123"), false);
          return { error: failure === table ? { code: "failure" } : null };
        },
      };
      return query;
    },
  };
  return { admin, events };
}

test("managed changes update Auth, revoke sessions/challenges/tokens and audit without passwords", async () => {
  const { admin, events } = adminMock();
  await passwordApi.changeManagedPassword(admin, id, "A-new-password123", id);
  assert.deepEqual(events, ["password", "login_sessions", "login_challenges", "password_setup_tokens", "audit_logs"]);
});

test("rejected passwords preserve sessions and cleanup failures report partial success explicitly", async () => {
  const rejected = adminMock("password");
  await assert.rejects(passwordApi.changeManagedPassword(rejected.admin, id, "A-new-password123", id), (error) => error.status === 400);
  assert.deepEqual(rejected.events, ["password"]);
  for (const table of ["login_sessions", "login_challenges", "password_setup_tokens", "audit_logs"]) {
    const { admin } = adminMock(table);
    await assert.rejects(passwordApi.changeManagedPassword(admin, id, "A-new-password123", id), (error) => error.status === 503 && /Password was changed/.test(error.message));
  }
});

function route(role) {
  const calls = [];
  const api = load("src\\app\\api\\users\\route.ts", {
    "next/server": { NextResponse: { json: (payload, options) => ({ payload, status: options?.status ?? 200 }) } },
    "@/lib/crm-data": {},
    "@/lib/server/auth": {
      HttpError, readJson: async (request) => request.body,
      requireUser: async (permission) => { calls.push(permission); return { user: { id, profile: { role } } }; },
      jsonError: (error) => ({ status: error.status ?? 500, payload: { error: error.message } }),
    },
    "@/lib/server/login": { checkOrigin: () => {} },
    "@/lib/server/password-management": { changeManagedPassword: async () => calls.push("change") },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => {
      calls.push("service");
      const query = { select: () => query, eq: () => query, is: () => query, single: async () => ({ data: { id, email: "user@example.com" }, error: null }) };
      return { from: () => query };
    } },
  });
  return { api, calls };
}

test("password endpoint rejects every non-Super Admin before privileged access", async () => {
  for (const role of ["counselor", "team_lead", "manager", "admin"]) {
    const { api, calls } = route(role);
    assert.equal((await api.PATCH({ body: { action: "password", id, password: "A-new-password123" } })).status, 403);
    assert.deepEqual(calls, ["users.manage"]);
  }
});

test("password endpoint rejects old email action and invalid passwords before service access", async () => {
  for (const body of [{ action: "setup", id }, { action: "password", id, password: "short" }, { action: "password", id, password: "x".repeat(129) }]) {
    const { api, calls } = route("super_admin");
    assert.equal((await api.PATCH({ body })).status, 400);
    assert.equal(calls.includes("service"), false);
  }
  const { api, calls } = route("super_admin");
  const result = await api.PATCH({ body: { action: "password", id, password: "A-new-password123" } });
  assert.equal(result.status, 200);
  assert.equal(result.payload.signInRequired, true);
  assert.equal(calls.includes("change"), true);
});

test("old email-reset endpoint is disabled", async () => {
  const api = load("src\\app\\api\\auth\\setup-password\\route.ts", {
    "next/server": { NextResponse: { json: (payload, options) => ({ payload, status: options.status }) } },
  });
  assert.equal((await api.POST()).status, 410);
});

const React = require("react");
const profile = { id, fullName: "Test User", email: "test@example.com", role: "super_admin", reportingTo: null, status: "active", phone: "", ivrExtension: "" };
function usersForm({ self = false, mismatch = false, creating = false, download = true, failSave = false } = {}) {
  const states = [
    { profiles: [profile], activity: [], canManage: true }, creating ? "new" : null, profile,
    "", "", false, "", creating ? null : profile, "A-new-password123", mismatch ? "different" : "A-new-password123", download, null, "",
  ];
  const calls = [], redirects = [];
  let index = 0;
  const api = load("src\\app\\users\\page.tsx", {
    react: { ...React, useEffect() {}, useState: () => {
      const position = index++;
      return [states[position], (value) => { states[position] = value; }];
    } },
    "@/lib/crm-data": {
      apiRequest: async (path, options) => {
        calls.push({ path, options });
        if (options && failSave) throw new Error("Creation rejected");
        return options ? { signInRequired: self } : states[0];
      },
      formatDateTime: () => "", errorMessage: (error) => error.message,
    },
    "@/lib/credential-pdf": {
      createCredentialPdf: async (email, password) => { calls.push({ pdf: { email, password } }); return new Uint8Array([1]); },
      downloadCredentialPdf: () => { calls.push({ download: true }); },
    },
  }, { window: { location: { assign: (url) => redirects.push(url) } } });
  const tree = api.default();
  function find(node, type) {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map((child) => find(child, type)).find(Boolean);
    if (node.type === type) return node;
    return find(node.props?.children, type);
  }
  return { states, calls, redirects, form: find(tree, "form") };
}

test("Users form clears secrets and redirects self changes without refreshing revoked session", async () => {
  const view = usersForm({ self: true });
  await view.form.props.onSubmit({ preventDefault() {} });
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0].options.body.action, "password");
  assert.deepEqual(view.redirects, ["/login?passwordUpdated=1"]);
  assert.equal(view.states[8], "");
  assert.equal(view.states[9], "");
  assert.equal(view.states[7], null);
});

test("Users form refuses mismatched passwords and handles other-user changes without redirect", async () => {
  const invalid = usersForm({ mismatch: true });
  await invalid.form.props.onSubmit({ preventDefault() {} });
  assert.equal(invalid.calls.length, 0);
  assert.match(invalid.states[3], /do not match/);
  const valid = usersForm();
  await valid.form.props.onSubmit({ preventDefault() {} });
  assert.equal(valid.redirects.length, 0);
  assert.match(valid.states[4], /must sign in again/);
  assert.equal(valid.states[8], "");
});

test("new-user form supplies chosen password rather than requesting setup mail", async () => {
  const view = usersForm({ creating: true });
  view.form.props.onSubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(view.calls[0].pdf.password, "A-new-password123");
  assert.equal(view.calls[1].options.method, "POST");
  assert.equal(view.calls[1].options.body.password, "A-new-password123");
  assert.equal(view.calls[2].download, true);
  assert.equal(view.states[8], "");
  assert.match(view.states[4], /User created/);
});

test("credential PDF is optional and never downloaded when user creation fails", async () => {
  const skipped = usersForm({ creating: true, download: false });
  skipped.form.props.onSubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(skipped.calls.some((call) => call.pdf || call.download), false);
  const rejected = usersForm({ creating: true, failSave: true });
  rejected.form.props.onSubmit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected.calls.some((call) => call.download), false);
  assert.match(rejected.states[3], /Creation rejected/);
});

test("delete endpoint rejects non-Super Admins and self deletion", async () => {
  for (const role of ["counselor", "team_lead", "manager", "admin"]) {
    const { api, calls } = route(role);
    assert.equal((await api.DELETE({ body: { id, email: "test@example.com" } })).status, 403);
    assert.deepEqual(calls, ["users.manage"]);
  }
  const { api, calls } = route("super_admin");
  assert.equal((await api.DELETE({ body: { id, email: "test@example.com" } })).status, 400);
  assert.equal(calls.includes("service"), false);
});

test("permanent deletion confirms email, deletes Auth account and audits without credentials", async () => {
  const targetId = "10000000-0000-4000-8000-000000000005";
  for (const failure of [null, "delete", "audit", "missing", "mismatch"]) {
    const events = [];
    const query = {
      select: () => query, eq: () => query, is: () => query,
      maybeSingle: async () => ({ data: failure === "missing" ? null : { id: targetId, email: "target@example.com" }, error: null }),
      insert: async (row) => { events.push(row.action); return { error: failure === "audit" ? { code: "test" } : null }; },
    };
    const api = load("src\\app\\api\\users\\route.ts", {
      "next/server": { NextResponse: { json: (payload, options) => ({ payload, status: options?.status ?? 200 }) } },
      "@/lib/crm-data": {},
      "@/lib/server/auth": { HttpError, readJson: async (request) => request.body, requireUser: async () => ({ user: { id, profile: { role: "super_admin" } } }), jsonError: (error) => ({ status: error.status ?? 500, message: error.message }) },
      "@/lib/server/login": { checkOrigin() {} },
      "@/lib/server/password-management": {},
      "@/lib/supabase/server": { getSupabaseAdminClient: () => ({
        from: () => query,
        auth: { admin: { deleteUser: async (target) => { assert.equal(target, targetId); events.push("delete"); return { error: failure === "delete" ? { code: "test" } : null }; } } },
      }) },
    });
    const result = await api.DELETE({ body: { id: targetId, email: failure === "mismatch" ? "wrong@example.com" : "target@example.com" } });
    assert.equal(result.status, failure === "missing" ? 404 : failure === "mismatch" ? 400 : failure ? 503 : 200);
    assert.deepEqual(events, failure === "missing" || failure === "mismatch" ? [] : failure === "delete" ? ["delete"] : ["delete", "user.deleted"]);
    if (failure === "audit") assert.match(result.message, /was deleted/);
  }
});
