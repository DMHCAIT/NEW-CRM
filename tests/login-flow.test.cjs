const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const crypto = require("node:crypto");

function transpile(file, dependencies) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, { exports, require: (name) => dependencies[name] ?? require(name), Buffer, console, URL, process: { env: {} } });
  return exports;
}

function harness({ wrongPassword = false, sendFails = false, wrongCode = false, auditFails = false, deviceId } = {}) {
  const events = [];
  const cookies = new Map();
  if (deviceId) cookies.set("crm-device", deviceId);
  const writes = [];
  const user = { id: "a-user", email: "user@example.com" };
  const access = `header.${Buffer.from(JSON.stringify({ session_id: "b3d772f8-1aac-4b23-bc50-d84b04681dc4" })).toString("base64url")}.signature`;
  const session = { access_token: access, refresh_token: "refresh" };
  let challenge;
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const cryptoApi = transpile("src\\lib\\server\\login-crypto.ts", {});
  const key = cryptoApi.encryptionKey("ab".repeat(32));
  const admin = {
    rpc: async (name) => {
      if (name === "allow_login_attempt") return { data: true, error: null };
      events.push("consume");
      if (wrongCode || !challenge) return { data: [], error: null };
      const row = challenge; challenge = undefined;
      return { data: [row], error: null };
    },
    from: (table) => ({
      select: () => ({ eq: () => ({
        maybeSingle: async () => ({ data: { status: "active", deleted_at: null }, error: null }),
        single: async () => ({ data: { status: "active", deleted_at: null }, error: null }),
      }) }),
      insert: async (value) => {
        writes.push({ table, value });
        events.push(`insert:${table}`);
        if (table === "login_challenges" || table === "login_sessions") {
          assert.equal(value.device, "Unknown device");
          for (const key of ["ip_address", "location", "user_agent"]) assert.equal(key in value, false);
        }
        if (table === "login_challenges") challenge = value;
        return { error: table === "login_sessions" && auditFails ? new Error("DB unavailable") : null };
      },
      delete: () => ({ eq: async () => { challenge = undefined; return { error: null }; } }),
    }),
  };
  const api = transpile("src\\lib\\server\\login.ts", {
    "node:crypto": crypto,
    "@supabase/supabase-js": { createClient: () => ({ auth: {
      signInWithPassword: async () => ({ data: wrongPassword ? {} : { session, user }, error: wrongPassword ? new Error("invalid") : null }),
      setSession: async () => ({ data: { session, user }, error: null }),
    } }) },
    "next/headers": { cookies: async () => ({
      get: (name) => cookies.has(name) ? { value: cookies.get(name) } : undefined,
      set: (name, value, options) => { events.push("cookie"); assert.equal(options.httpOnly, true); cookies.set(name, value); },
      delete: (name) => cookies.delete(name),
    }) },
    "@/lib/supabase/server": {
      getSupabaseAdminClient: () => admin,
      getSupabaseServerClient: async () => ({ auth: { setSession: async () => { events.push("authenticated-cookie"); return { error: null }; } } }),
    },
    "@/lib/server/auth": { HttpError },
    "@/lib/server/env": { ConfigurationError: class extends Error {}, requireEnv: (name) => name === "AUTH_ENCRYPTION_KEY" ? "ab".repeat(32) : "https://crm.example.com" },
    "@/lib/server/mailer": { emailLayout: (_, html) => html, sendMail: async () => { events.push("email"); if (sendFails) throw new Error("SMTP unavailable"); } },
    "@/lib/server/login-crypto": cryptoApi,
    "@/lib/device": transpile("src\\lib\\device.ts", {}),
  });
  return { api, events, cookies, key, writes };
}
const request = { headers: new Headers({ "user-agent": "Regression browser" }) };

test("password login sends email but never grants a CRM session", async () => {
  const { api, events, cookies } = harness();
  await api.startLogin(request, "user@example.com", "password");
  assert.deepEqual(events, ["insert:login_challenges", "email", "cookie", "cookie"]);
  assert.equal(cookies.size, 2);
  assert.equal(events.includes("authenticated-cookie"), false);
});

test("bad password and failed SMTP cannot grant even a pending cookie", async () => {
  for (const options of [{ wrongPassword: true }, { sendFails: true }]) {
    const { api, events, cookies } = harness(options);
    await assert.rejects(api.startLogin(request, "user@example.com", "password"));
    assert.equal(cookies.size, 0);
    assert.equal(events.includes("authenticated-cookie"), false);
  }
});

test("verification records the exact session before setting authenticated cookies and is single-use", async () => {
  const { api, events, cookies } = harness();
  await api.startLogin(request, "user@example.com", "password");
  await api.verifyLogin("123456");
  assert.ok(events.indexOf("insert:login_sessions") < events.indexOf("authenticated-cookie"));
  assert.equal(cookies.size, 1);
  await assert.rejects(api.verifyLogin("123456"));
});

test("invalid OTP and failed audit writes never set authenticated cookies", async () => {
  for (const options of [{ wrongCode: true }, { auditFails: true }]) {
    const { api, events } = harness(options);
    await api.startLogin(request, "user@example.com", "password");
    await assert.rejects(api.verifyLogin("123456"));
    assert.equal(events.includes("authenticated-cookie"), false);
  }
});

test("authentication writes require an exact configured origin", () => {
  const { api } = harness();
  assert.doesNotThrow(() => api.checkOrigin({ headers: new Headers({ origin: "https://crm.example.com" }) }));
  for (const origin of ["https://evil.example.com", "https://crm.example.com.evil.test", "null", ""]) {
    assert.throws(() => api.checkOrigin({ headers: new Headers(origin ? { origin } : {}) }));
  }
});

test("repeat logins keep the same opaque device and bind it through verified challenges", async () => {
  const { api, cookies, writes } = harness();
  await api.startLogin(request, "user@example.com", "password");
  const device = cookies.get("crm-device");
  assert.match(device, /^[a-f0-9]{64}$/);
  await api.verifyLogin("123456");
  await api.startLogin(request, "user@example.com", "password");
  await api.verifyLogin("123456");
  assert.equal(cookies.get("crm-device"), device);
  assert.equal(new Set(writes.map(row => row.value.device_id)).size, 1);
  assert.notEqual(writes[0].value.device_id, device);
});

test("separate browsers and malformed cookies receive independent device identifiers", async () => {
  const identifiers = [];
  for (const deviceId of [undefined, undefined, "invalid"]) {
    const { api, cookies } = harness({ deviceId });
    await api.startLogin(request, "user@example.com", "password");
    identifiers.push(cookies.get("crm-device"));
  }
  assert.equal(new Set(identifiers).size, 3);
});

test("verification cannot replace a device session after the device cookie changes", async () => {
  const { api, cookies, events } = harness();
  await api.startLogin(request, "user@example.com", "password");
  cookies.set("crm-device", "ff".repeat(32));
  await assert.rejects(api.verifyLogin("123456"), /device changed/);
  assert.equal(events.includes("insert:login_sessions"), false);
  assert.equal(events.includes("authenticated-cookie"), false);
});
