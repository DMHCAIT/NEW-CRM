const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.join(__dirname, "..");
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
class ConfigurationError extends Error {}
const key = "ab".repeat(32);
function load(file, overrides = {}) {
  const exports = {};
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  new Function("exports", "require", "fetch", output)(exports, name => {
    if (name in overrides) return overrides[name];
    if (name.startsWith("@/")) return load(`${name.replace("@/", "src\\").replaceAll("/", "\\")}.ts`, overrides);
    return require(name);
  }, overrides.fetch ?? global.fetch);
  return exports;
}
function fixture({ role = "admin", permission = true, failRead = false } = {}) {
  const rows = new Map(), requests = [];
  let checkFailure = false, race = false;
  const user = { id: "10000000-0000-4000-8000-000000000001", email: "admin@example.com", profile: { role }, permissions: permission ? ["integrations.manage"] : [] };
  const client = { from(table) {
    assert.equal(table, "integration_credentials");
    let mode = "select", patch, filters = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push([key, value]); return query; },
      update(value) { mode = "update"; patch = value; return query; },
      insert: async value => { if (rows.has(value.provider)) return { error: { code: "23505" } }; rows.set(value.provider, value); return { error: null }; },
      maybeSingle: async () => {
        if (failRead) return { error: { message: "db unavailable" }, data: null };
        const entry = [...rows.values()].find(row => filters.every(([key, value]) => row[key] === value));
        if (!entry || (race && mode === "update")) return { data: null, error: null };
        if (mode === "update") Object.assign(entry, patch);
        return { data: entry, error: null };
      },
      then(resolve, reject) { return query.maybeSingle().then(resolve, reject); },
    };
    return query;
  } };
  const mocks = {
    "@/lib/server/auth": { HttpError, requireUser: async permission => { requests.push(permission); return { user }; }, jsonError: error => ({ status: error.status ?? 500, error: error.message }), readJson: request => request.json() },
    "@/lib/server/env": { ConfigurationError, requireEnv: name => { if (name === "AUTH_ENCRYPTION_KEY") return key; if (name === "NEXT_PUBLIC_APP_URL") return "https://crm.example"; throw new Error(`Missing ${name}`); }, appUrl: () => "https://crm.example" },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => client },
    "@/lib/server/login": { checkOrigin: request => { if (request.headers.get("origin") !== "https://crm.example") throw new HttpError(403, "Invalid origin"); } },
    "@/lib/server/integration-checks": { checkIntegration: async (...args) => { requests.push(args); if (checkFailure) throw new HttpError(502, "Provider authentication failed"); return "Provider check passed; delivery not proven."; } },
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } },
  };
  const settings = load("src\\lib\\server\\integration-settings.ts", mocks);
  const route = load("src\\app\\api\\integrations\\settings\\route.ts", { ...mocks, "@/lib/server/integration-settings": settings });
  const post = (body, origin = "https://crm.example") => route.POST(new Request("https://crm.example/api/integrations/settings", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return { rows, requests, settings, route, post, setCheckFailure: () => { checkFailure = true; }, setRace: () => { race = true; } };
}
const smtp = { SMTP_HOST: "smtp.example.com", SMTP_PORT: "587", SMTP_USER: "finance@example.com", SMTP_PASSWORD: "top-secret-password", SMTP_FROM: "Finance <finance@example.com>", SMTP_SECURE: "false" };
test("TeleCMI setup saves encrypted secrets and performs a local-only connection check", async () => {
  const f = fixture();
  const values = { TELECMI_PRODUCT: "Account API awaiting confirmation", TELECMI_APP_ID: "test-app", TELECMI_APP_SECRET: "test-only-app-secret", TELECMI_API_DOCS_URL: "https://doc.telecmi.com/chub-india/docs/click-to-call-admin/", TELECMI_DEVICE_ROUTING_CONFIRMED: "true" };
  const saved = await f.post({ provider: "telecmi", action: "save", values, revision: null });
  assert.equal(saved.status, 200);
  assert.match(saved.data.message, /Credentials saved encrypted/);
  const row = f.rows.get("telecmi");
  assert.ok(!row.encrypted_values.includes(values.TELECMI_APP_SECRET));
  assert.deepEqual(f.settings.decryptIntegrationValues(row.encrypted_values), values);
  const metadata = (await f.route.GET()).data.settings.find(item => item.provider === "telecmi");
  assert.equal(metadata.saved.TELECMI_APP_SECRET, true);
  assert.equal(metadata.values.TELECMI_APP_SECRET, undefined);
  assert.ok(!JSON.stringify(metadata).includes(values.TELECMI_APP_SECRET));
  assert.deepEqual(await f.settings.integrationStatus("telecmi"), { configured: true, required: ["TELECMI_APP_SECRET"], missing: [] });
  const check = await f.post({ provider: "telecmi", action: "test", revision: row.revision });
  assert.equal(check.status, 200);
  assert.equal(check.data.message, "Provider check passed; delivery not proven.");
  assert.equal(f.requests.filter(Array.isArray).length, 1);
  assert.equal(f.requests.find(Array.isArray)[0], "telecmi");
  assert.equal(f.rows.get("telecmi").test_status, "passed");
  assert.equal((await f.post({ provider: "telecmi", action: "test_email", revision: row.revision })).status, 400);
  assert.equal((await f.post({ provider: "telecmi", action: "save", values: { TELECMI_ENABLED: "true" }, revision: row.revision })).status, 400);
  for (const invalid of [
    { TELECMI_DEVICE_ROUTING_CONFIRMED: "yes" }, { TELECMI_PRODUCT: "x".repeat(151) },
    { TELECMI_API_DOCS_URL: "javascript:alert(1)" }, { TELECMI_API_DOCS_URL: "http://example.test/docs" },
    { TELECMI_API_DOCS_URL: "https://user:password@example.test/docs" },
  ]) assert.equal((await f.post({ provider: "telecmi", action: "save", values: invalid, revision: row.revision })).status, 400);
  assert.equal((await f.post({ provider: "telecmi", action: "save", values: {}, revision: null })).status, 409);
  assert.equal((await fixture({ role: "counselor" }).post({ provider: "telecmi", action: "save", values: {}, revision: null })).status, 403);
});
test("pasting a service account automatically enables Workspace and verifies before activating", async () => {
  const { privateKey } = require("node:crypto").generateKeyPairSync("rsa", { modulusLength: 2048 });
  const json = JSON.stringify({ type: "service_account", client_email: "crm@project.iam.gserviceaccount.com", client_id: "123456789", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
  const f = fixture();
  const result = await f.post({ provider: "gmail", action: "save", values: { GOOGLE_SERVICE_ACCOUNT_JSON: json }, revision: null });
  assert.equal(result.status, 200);
  assert.match(result.data.message, /Workspace connected/);
  const saved = f.settings.decryptIntegrationValues(f.rows.get("gmail").encrypted_values);
  assert.equal(saved.GOOGLE_MAILBOX_MODE, "workspace");
  assert.equal(saved.GOOGLE_WORKSPACE_DOMAIN, "example.com");
  assert.equal(f.rows.get("gmail").test_status, "passed");
  assert.equal(f.requests.find(Array.isArray)[2], "admin@example.com");
  const previous = f.rows.get("gmail");
  f.setCheckFailure();
  const failed = await f.post({ provider: "gmail", action: "save", values: { GOOGLE_SERVICE_ACCOUNT_JSON: json }, revision: previous.revision });
  assert.equal(failed.status, 502);
  assert.equal(f.rows.get("gmail"), previous, "failed delegation must not replace the active configuration");
  const fresh = fixture(); fresh.setCheckFailure();
  assert.equal((await fresh.post({ provider: "gmail", action: "save", values: { GOOGLE_SERVICE_ACCOUNT_JSON: json }, revision: null })).status, 502);
  assert.equal(fresh.rows.size, 0);
});
test("credential ciphertext round-trips and tampering fails authentication", () => {
  const { settings } = fixture();
  const encrypted = settings.encryptIntegrationValues(smtp);
  assert.ok(!encrypted.includes(smtp.SMTP_PASSWORD));
  assert.deepEqual(settings.decryptIntegrationValues(encrypted), smtp);
  const bytes = Buffer.from(encrypted, "base64url"); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => settings.decryptIntegrationValues(bytes.toString("base64url")));
});
test("only admin and super admin with integration permission can change shared credentials", async () => {
  for (const role of ["manager", "team_lead", "counselor"]) {
    const { post, rows } = fixture({ role });
    assert.equal((await post({ provider: "smtp", action: "save", values: smtp, revision: null })).status, 403);
    assert.equal(rows.size, 0);
  }
  assert.equal((await fixture({ permission: false }).post({ provider: "smtp", action: "save", values: smtp, revision: null })).status, 403);
  for (const role of ["admin", "super_admin"]) assert.equal((await fixture({ role }).post({ provider: "smtp", action: "save", values: smtp, revision: null })).status, 200);
});
test("saving encrypts secrets, read metadata never includes saved secret values", async () => {
  const { post, route, rows } = fixture();
  assert.equal((await post({ provider: "smtp", action: "save", values: smtp, revision: null })).status, 200);
  assert.ok(!rows.get("smtp").encrypted_values.includes(smtp.SMTP_PASSWORD));
  const result = await route.GET();
  assert.equal(result.status, 200);
  assert.ok(!JSON.stringify(result).includes(smtp.SMTP_PASSWORD));
  const metadata = result.data.settings.find(row => row.provider === "smtp");
  assert.equal(metadata.saved.SMTP_PASSWORD, true);
  assert.equal(metadata.values.SMTP_HOST, smtp.SMTP_HOST);
  assert.equal(metadata.values.SMTP_PASSWORD, undefined);
});
test("blank secret edits preserve saved values, clear tests and reject stale revisions", async () => {
  const { post, rows, settings } = fixture();
  await post({ provider: "smtp", action: "save", values: smtp, revision: null });
  const previous = rows.get("smtp").revision;
  rows.get("smtp").test_status = "passed";
  assert.equal((await post({ provider: "smtp", action: "save", values: { SMTP_PASSWORD: "", SMTP_HOST: "smtp2.example.com" }, revision: previous })).status, 200);
  assert.equal(settings.decryptIntegrationValues(rows.get("smtp").encrypted_values).SMTP_PASSWORD, smtp.SMTP_PASSWORD);
  assert.equal(rows.get("smtp").test_status, null);
  assert.notEqual(rows.get("smtp").revision, previous);
  assert.equal((await post({ provider: "smtp", action: "save", values: {}, revision: previous })).status, 409);
});
test("origin failures, unknown provider keys and malformed configuration cannot persist", async () => {
  const { post, rows } = fixture();
  assert.equal((await post({ provider: "smtp", action: "save", values: smtp, revision: null }, "https://evil.example")).status, 403);
  assert.equal((await post({ provider: "smtp", action: "save", values: { ...smtp, EXTRA_SECRET: "x" }, revision: null })).status, 400);
  assert.equal((await post({ provider: "smtp", action: "save", values: { ...smtp, SMTP_HOST: "127.0.0.1" }, revision: null })).status, 400);
  assert.equal((await post({ provider: "smtp", action: "save", values: { ...smtp, SMTP_FROM: "a@example.com\r\nBcc:b@example.com" }, revision: null })).status, 400);
  assert.equal(rows.size, 0);
});
test("saved credentials drive connection checks and failures are persisted honestly", async () => {
  const f = fixture();
  await f.post({ provider: "smtp", action: "save", values: smtp, revision: null });
  const revision = f.rows.get("smtp").revision;
  assert.equal((await f.post({ provider: "smtp", action: "test", revision })).status, 200);
  assert.equal(f.rows.get("smtp").test_status, "passed");
  assert.deepEqual(f.requests.find(value => Array.isArray(value)), ["smtp", smtp, undefined]);
  f.setCheckFailure();
  assert.equal((await f.post({ provider: "smtp", action: "test", revision })).status, 502);
  assert.equal(f.rows.get("smtp").test_status, "failed");
  assert.ok(!f.rows.get("smtp").test_message.includes(smtp.SMTP_PASSWORD));
});
test("SMTP test email is restricted to the admin's login address", async () => {
  const f = fixture();
  await f.post({ provider: "smtp", action: "save", values: smtp, revision: null });
  const revision = f.rows.get("smtp").revision;
  assert.equal((await f.post({ provider: "smtp", action: "test_email", revision, recipient: "other@example.com" })).status, 400);
  assert.equal((await f.post({ provider: "smtp", action: "test_email", revision, recipient: "admin@example.com" })).status, 200);
  assert.equal(f.requests.find(value => Array.isArray(value))[2], "admin@example.com");
});
test("connection tests reject unsaved edits and optimistic writes detect concurrent change", async () => {
  const f = fixture();
  await f.post({ provider: "smtp", action: "save", values: smtp, revision: null });
  const revision = f.rows.get("smtp").revision;
  assert.equal((await f.post({ provider: "smtp", action: "test", values: { SMTP_HOST: "changed.example.com" }, revision })).status, 400);
  f.setRace();
  assert.equal((await f.post({ provider: "smtp", action: "save", values: smtp, revision })).status, 409);
});
test("runtime uses encrypted CRM values over environment and never swallows database errors", async () => {
  const f = fixture();
  await f.post({ provider: "smtp", action: "save", values: smtp, revision: null });
  assert.equal((await f.settings.getIntegrationConfig("smtp")).SMTP_PASSWORD, smtp.SMTP_PASSWORD);
  await assert.rejects(() => fixture({ failRead: true }).settings.getIntegrationConfig("smtp"), /could not be loaded/);
});
test("non-admin viewers receive no organization credential metadata", async () => {
  const result = await fixture({ role: "counselor" }).route.GET();
  assert.deepEqual(result.data.settings, []);
  assert.equal(result.data.canManage, false);
});
test("Google callback and Meta version are validated before saving", async () => {
  const { settings } = fixture();
  assert.throws(() => settings.validateIntegrationConfig("gmail", { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://evil.example/callback" }), /exactly match/);
  assert.throws(() => settings.validateIntegrationConfig("facebook", { FACEBOOK_APP_ID: "12", FACEBOOK_APP_SECRET: "secret", FACEBOOK_WEBHOOK_VERIFY_TOKEN: "token", FACEBOOK_GRAPH_VERSION: "latest" }), /Graph version/);
  assert.throws(() => settings.validateIntegrationConfig("intake", { LEAD_INTAKE_SIGNING_KEY: "short" }), /32 characters/);
});
test("Gmail callback is environment-specific while saved OAuth client credentials remain shared", async t => {
  const previous = process.env.GOOGLE_REDIRECT_URI;
  t.after(() => {
    if (previous === undefined) delete process.env.GOOGLE_REDIRECT_URI;
    else process.env.GOOGLE_REDIRECT_URI = previous;
  });
  const { settings, rows, route, post, requests } = fixture();
  const saved = {
    GOOGLE_CLIENT_ID: "shared-client", GOOGLE_CLIENT_SECRET: "shared-secret",
    GOOGLE_REDIRECT_URI: "https://crm.example/api/auth/gmail/callback",
  };
  rows.set("gmail", { provider: "gmail", encrypted_values: settings.encryptIntegrationValues(saved) });
  process.env.GOOGLE_REDIRECT_URI = "http://localhost:3000/api/auth/gmail/callback";
  assert.deepEqual(await settings.getIntegrationConfig("gmail"), { ...saved, GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI });
  process.env.GOOGLE_REDIRECT_URI = "https://crm.example/api/auth/gmail/callback";
  assert.deepEqual(await settings.getIntegrationConfig("gmail"), saved);
  rows.get("gmail").encrypted_values = settings.encryptIntegrationValues({ ...saved, GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/gmail/callback" });
  rows.get("gmail").revision = "10000000-0000-4000-8000-000000000011";
  const result = await route.GET();
  assert.equal(result.data.settings.find(item => item.provider === "gmail").values.GOOGLE_REDIRECT_URI, saved.GOOGLE_REDIRECT_URI);
  assert.equal((await post({ provider: "gmail", action: "test", revision: rows.get("gmail").revision })).status, 200);
  assert.equal(requests.find(item => Array.isArray(item) && item[0] === "gmail")[1].GOOGLE_REDIRECT_URI, saved.GOOGLE_REDIRECT_URI);
  delete process.env.GOOGLE_REDIRECT_URI;
  assert.deepEqual(await settings.getIntegrationConfig("gmail"), { ...saved, GOOGLE_REDIRECT_URI: "http://localhost:3000/api/auth/gmail/callback" });
});
test("SMTP destination checks reject private, local and mapped addresses", () => {
  const transport = load("src\\lib\\server\\smtp-transport.ts", {
    "@/lib/server/env": { ConfigurationError },
    "@/lib/server/integration-settings": { requireIntegrationValue: (config, key) => config[key] },
  });
  for (const address of ["127.0.0.1", "10.0.0.2", "172.16.0.2", "192.168.1.2", "169.254.169.254", "::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) assert.equal(transport.publicSmtpAddress(address), false, address);
  for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) assert.equal(transport.publicSmtpAddress(address), true, address);
});

test("provider checks use fixed endpoints, bounded requests and never create meetings, charges or leads", async () => {
  const requests = [];
  let response = { ok: true, status: 200, json: async () => ({ access_token: "short-lived-token", id: "1234" }) };
  const { checkIntegration } = load("src\\lib\\server\\integration-checks.ts", {
    "@/lib/server/auth": { HttpError },
    "@/lib/server/integration-settings": { requireIntegrationValue: (config, name) => { if (!config[name]) throw new Error(`Missing ${name}`); return config[name]; } },
    "@/lib/server/smtp-transport": {},
    fetch: async (url, init) => { requests.push({ url, init }); return response; },
  });

  test("SMTP transport pins public DNS, verifies the original TLS hostname and rejects mixed private answers", async () => {
    let options, answers = [{ address: "2606:4700:4700::1111", family: 6 }, { address: "8.8.8.8", family: 4 }];
    const { smtpTransport } = load("src\\lib\\server\\smtp-transport.ts", {
      nodemailer: { default: { createTransport: value => { options = value; return { test: true }; } } },
      "node:dns/promises": { lookup: async (host, flags) => { assert.equal(host, smtp.SMTP_HOST); assert.equal(flags.all, true); return answers; } },
      "@/lib/server/env": { ConfigurationError },
      "@/lib/server/integration-settings": { requireIntegrationValue: (config, key) => config[key] },
    });
    await smtpTransport(smtp);
    assert.equal(options.host, "8.8.8.8");
    assert.equal(options.tls.servername, smtp.SMTP_HOST);
    assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.requireTLS, true);
    assert.equal(options.secure, false);
    assert.equal(options.auth.pass, smtp.SMTP_PASSWORD);
    assert.ok(options.connectionTimeout > 0 && options.socketTimeout > 0);
    await smtpTransport({ ...smtp, SMTP_PORT: "465", SMTP_SECURE: "true" });
    assert.equal(options.secure, true);
    answers.push({ address: "127.0.0.1", family: 4 });
    options = undefined;
    await assert.rejects(smtpTransport(smtp), /public internet/);
    assert.equal(options, undefined);
  });
  await checkIntegration("zoom", { ZOOM_CLIENT_ID: "client", ZOOM_CLIENT_SECRET: "secret", ZOOM_ACCOUNT_ID: "account", ZOOM_HOST_USER: "host@example.com" });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.method, "POST");
  assert.match(requests[0].url, /^https:\/\/zoom.us\/oauth\/token\?/);
  assert.equal(requests[1].url, "https://api.zoom.us/v2/users/host%40example.com");
  assert.equal(requests[1].init.headers.Authorization, "Bearer short-lived-token");
  await checkIntegration("razorpay", { RAZORPAY_KEY_ID: "key", RAZORPAY_KEY_SECRET: "secret" });
  assert.equal(requests.at(-1).url, "https://api.razorpay.com/v1/payment_links?count=1");
  await checkIntegration("facebook", { FACEBOOK_APP_ID: "1234", FACEBOOK_APP_SECRET: "secret", FACEBOOK_GRAPH_VERSION: "v25.0" });
  assert.equal(requests.at(-1).url, "https://graph.facebook.com/v25.0/1234?fields=id%2Cname");
  for (const { init } of requests) {
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.ok(requests.slice(1).every(({ init }) => !init.method || init.method === "GET"));
  const before = requests.length;
  assert.match(await checkIntegration("telecmi", { TELECMI_APP_SECRET: "test-only-secret", TELECMI_DEVICE_ROUTING_CONFIRMED: "true" }), /local check only/);
  assert.equal(requests.length, before, "TeleCMI must not contact a guessed API");
  assert.match(await checkIntegration("gmail", { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REDIRECT_URI: "https://crm.example/api/auth/gmail/callback" }), /local check only/);
  assert.match(await checkIntegration("intake", { LEAD_INTAKE_SIGNING_KEY: "x".repeat(32) }), /No external website was contacted/);
  assert.equal(requests.length, before, "local checks do not pretend to authenticate external providers");
  response = { ok: false, status: 401, json: async () => ({ error: "contains-provider-secret" }) };
  await assert.rejects(checkIntegration("razorpay", { RAZORPAY_KEY_ID: "key", RAZORPAY_KEY_SECRET: "secret" }), error => error.status === 502 && !error.message.includes("contains-provider-secret"));
});

test("SMTP checks distinguish authentication, accepted mail and rejected recipients and always close transport", async () => {
  let verified = 0, closed = 0, rejected = [], sent;
  const { checkIntegration } = load("src\\lib\\server\\integration-checks.ts", {
    "@/lib/server/auth": { HttpError },
    "@/lib/server/integration-settings": { requireIntegrationValue: (config, name) => config[name] },
    "@/lib/server/smtp-transport": { smtpTransport: async () => ({
      verify: async () => { verified++; },
      sendMail: async value => { sent = value; return { rejected }; },
      close() { closed++; },
    }) },
  });
  assert.match(await checkIntegration("smtp", smtp), /authentication passed/);
  assert.equal(sent, undefined);
  assert.match(await checkIntegration("smtp", smtp, "admin@example.com"), /accepted the test email/);
  assert.equal(sent.from, smtp.SMTP_FROM);
  assert.equal(sent.to, "admin@example.com");
  rejected = ["admin@example.com"];
  await assert.rejects(checkIntegration("smtp", smtp, "admin@example.com"), /rejected/);
  assert.equal(verified, 3);
  assert.equal(closed, 3);
});
