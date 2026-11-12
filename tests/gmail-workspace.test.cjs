const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { generateKeyPairSync, verify } = require("node:crypto");

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
class ConfigurationError extends Error {}
const key = "ab".repeat(32);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const account = {
  type: "service_account", client_email: "crm@project.iam.gserviceaccount.com", client_id: "123456789",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: "https://untrusted.example/token",
};
const config = {
  GOOGLE_MAILBOX_MODE: "workspace", GOOGLE_WORKSPACE_DOMAIN: "dmhca.in",
  GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(account, null, 2),
};
const user = { id: "signed-in-user", email: "guneswari@dmhca.in", permissions: ["leads.edit", "integrations.view"] };
const auth = {
  HttpError, requireUser: async permission => {
    if (permission && !user.permissions.includes(permission)) throw new HttpError(403, "Permission denied");
    return { user, supabase: {} };
  },
  jsonError: error => ({ status: error.status ?? 500, error: error.message }),
};
function load(file, mocks = {}) {
  const exports = {};
  const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  new Function("exports", "require", "fetch", output)(exports, name => {
    if (name in mocks) return mocks[name];
    if (name === "@/lib/server/auth") return auth;
    if (name === "@/lib/server/env") return {
      ConfigurationError, appUrl: () => "https://crm.example",
      requireEnv: name => name === "AUTH_ENCRYPTION_KEY" ? key : "https://crm.example",
    };
    if (name === "@/lib/server/operational") return {
      databaseError: error => { if (error) throw error; }, parseInput: (schema, value) => schema.parse(value),
    };
    if (name === "next/server") return { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } };
    if (name.startsWith("@/")) return load(`${name.replace("@/", "src\\").replaceAll("/", "\\")}.ts`, mocks);
    return require(name);
  }, mocks.fetch ?? (() => assert.fail("Unexpected network request")));
  return exports;
}
function providerFetch(email = user.email) {
  return async (url, init) => {
    assert.equal(init.redirect, "error");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "delegated-token", expires_in: 3600 });
    assert.equal(url, "https://gmail.googleapis.com/gmail/v1/users/me/profile");
    assert.equal(init.headers.Authorization, "Bearer delegated-token");
    return Response.json({ emailAddress: email });
  };
}
function gmail(mocks = {}) {
  return load("src\\lib\\server\\operational-gmail.ts", {
    "@/lib/server/integration-settings": { getIntegrationConfig: async () => config },
    fetch: providerFetch(), ...mocks,
  });
}

test("delegated authorization signs RS256 with exact login, scopes, fixed audience and one-hour expiry", async () => {
  let tokenRequests = 0;
  const api = load("src\\lib\\server\\gmail-delegation.ts", {
    fetch: async (url, init) => {
      if (url === "https://oauth2.googleapis.com/token") {
        tokenRequests++;
        const assertion = init.body.get("assertion");
        const [header, payload, signature] = assertion.split(".");
        assert.equal(JSON.parse(Buffer.from(header, "base64url")).alg, "RS256");
        const claims = JSON.parse(Buffer.from(payload, "base64url"));
        assert.equal(claims.iss, account.client_email);
        assert.equal(claims.sub, user.email);
        assert.equal(claims.aud, url);
        assert.equal(claims.exp - claims.iat, 3600);
        assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
        assert.deepEqual(claims.scope.split(" "), [
          "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send",
        ]);
        assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")));
        assert.equal(init.body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
        assert.ok(!init.body.toString().includes("PRIVATE"));
      }
      return providerFetch()(url, init);
    },
  });
  assert.equal(await api.delegatedGmailToken(config, user.email.toUpperCase()), "delegated-token");
  assert.equal(tokenRequests, 1);
});

test("managed mode restricts exact domain, rejects invalid configuration and does not request outside mailboxes", async () => {
  const api = load("src\\lib\\server\\gmail-delegation.ts");
  assert.equal(api.workspaceManaged({}), false);
  assert.throws(() => api.workspaceManaged({ GOOGLE_MAILBOX_MODE: "invalid" }), /Unknown/);
  for (const email of ["user@gmail.com", "user@otherdmhca.in", "user@sub.dmhca.in", "invalid", "user@dmhca.in\r\n"])
    await assert.rejects(api.delegatedGmailToken(config, email), error => error.status === 403);
  assert.throws(() => api.workspaceCredentials({ ...config, GOOGLE_WORKSPACE_DOMAIN: "https://dmhca.in" }), /valid Google Workspace domain/);
  for (const value of ["not-json", "{}", JSON.stringify({ ...account, private_key: "invalid-private-secret" })]) {
    assert.throws(() => api.workspaceCredentials({ ...config, GOOGLE_SERVICE_ACCOUNT_JSON: value }),
      error => error.status === 400 && !error.message.includes("invalid-private-secret"));
  }
});

test("delegation errors are explicit, sanitized, and mailbox aliases cannot change the sender", async () => {
  const denied = load("src\\lib\\server\\gmail-delegation.ts", {
    fetch: async () => Response.json({ error_description: "provider-private-details" }, { status: 401 }),
  });
  await assert.rejects(denied.delegatedGmailToken(config, user.email),
    error => error.status === 502 && /domain-wide delegation/.test(error.message) && !error.message.includes("provider-private-details"));
  const wrongProfile = load("src\\lib\\server\\gmail-delegation.ts", { fetch: providerFetch("different@dmhca.in") });
  await assert.rejects(wrongProfile.delegatedGmailToken(config, user.email), error => error.status === 409 && /primary/.test(error.message));
  const malformed = load("src\\lib\\server\\gmail-delegation.ts", { fetch: async () => Response.json({ access_token: "" }) });
  await assert.rejects(malformed.delegatedGmailToken(config, user.email), /invalid Workspace access token/);
  const disabled = load("src\\lib\\server\\gmail-delegation.ts", { fetch: async (url, init) =>
    url.endsWith("/profile") ? new Response("", { status: 403 }) : providerFetch()(url, init) });
  await assert.rejects(disabled.delegatedGmailToken(config, user.email), /Gmail license/);
});

test("managed sending uses authenticated login without personal OAuth credentials or connection rows", async () => {
  const admin = { from: () => assert.fail("Managed sending must not require employee OAuth rows") };
  const api = gmail();
  const sender = await api.prepareGmailSend(admin, user.id, user.email);
  assert.deepEqual(sender, { email: user.email, accessToken: "delegated-token" });
  assert.deepEqual(await api.currentGmailMailbox(admin, user.id, user.email), { email: user.email, managed: true });
  const outside = await api.currentGmailMailbox(admin, user.id, "person@gmail.com");
  assert.equal(outside.email, "");
  assert.match(outside.reason, /restricted/);
  await assert.rejects(api.prepareGmailSend(admin, user.id, "person@gmail.com"), error => error.status === 403);
  assert.equal(await api.validGmailToken(admin, { user_id: user.id, encrypted_tokens: null }, user.email), "delegated-token");
  await assert.rejects(api.validGmailToken(admin, { user_id: user.id, encrypted_tokens: null }), error => error.status === 403);
});

test("sync provisioning is user-bound, race-safe and never overwrites existing history or OAuth credentials", async () => {
  let writes = 0;
  const admin = { from(table) {
    assert.equal(table, "gmail_connections");
    return { upsert: async (row, options) => {
      writes++;
      assert.deepEqual(row, { user_id: user.id, email: user.email, auth_mode: "workspace", encrypted_tokens: null });
      assert.deepEqual(options, { onConflict: "user_id", ignoreDuplicates: true });
      return { error: null };
    } };
  } };
  await gmail().ensureWorkspaceSync(admin, user.id, user.email);
  assert.equal(writes, 1);
  await assert.rejects(gmail().ensureWorkspaceSync(admin, user.id, "person@gmail.com"), error => error.status === 403);
  assert.equal(writes, 1);
  const failed = { from: () => ({ upsert: async () => ({ error: new Error("Database unavailable") }) }) };
  await assert.rejects(gmail().ensureWorkspaceSync(failed, user.id, user.email), /Database unavailable/);
  const oauth = gmail({ "@/lib/server/integration-settings": { getIntegrationConfig: async () => ({}) } });
  await oauth.ensureWorkspaceSync({ from: () => assert.fail("OAuth must not auto-provision") }, user.id, user.email);
  await assert.rejects(oauth.validGmailToken({}, { user_id: user.id, encrypted_tokens: null }), /Connect Gmail/);
});

test("managed setup requires domain/key instead of OAuth fields and validates private material without returning it", () => {
  const settings = load("src\\lib\\server\\integration-settings.ts");
  assert.deepEqual(settings.validateIntegrationConfig("gmail", config), config);
  const ciphertext = settings.encryptIntegrationValues(config);
  assert.ok(!ciphertext.includes(account.private_key));
  assert.deepEqual(settings.decryptIntegrationValues(ciphertext), config);
  assert.throws(() => settings.validateIntegrationConfig("gmail", { ...config, GOOGLE_SERVICE_ACCOUNT_JSON: "" }), /required/);
  assert.throws(() => settings.validateIntegrationConfig("gmail", { ...config, GOOGLE_WORKSPACE_DOMAIN: "" }), /required/);
  assert.throws(() => settings.validateIntegrationConfig("gmail", { GOOGLE_MAILBOX_MODE: "oauth" }), /required/);
  const { gmailRequiredFields } = load("src\\lib\\integration-definitions.ts");
  assert.deepEqual(gmailRequiredFields(config), ["GOOGLE_WORKSPACE_DOMAIN", "GOOGLE_SERVICE_ACCOUNT_JSON"]);
});

test("managed setup check verifies Google mailbox without sending or listing mail", async () => {
  const requests = [];
  const checks = load("src\\lib\\server\\integration-checks.ts", {
    "@/lib/server/smtp-transport": {},
    "@/lib/server/integration-settings": { requireIntegrationValue: (values, name) => values[name] },
    fetch: async (url, init) => { requests.push(url); return providerFetch()(url, init); },
  });
  assert.match(await checks.checkIntegration("gmail", config, user.email), /No email was sent/);
  assert.deepEqual(requests, ["https://oauth2.googleapis.com/token", "https://gmail.googleapis.com/gmail/v1/users/me/profile"]);
  await assert.rejects(checks.checkIntegration("gmail", config), /CRM login mailbox is required/);
});

test("managed inbox status does not claim Google authorization was verified and disables individual connection actions", async () => {
  let connection = null;
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: connection, error: null }) };
  const route = load("src\\app\\api\\integrations\\gmail\\route.ts", {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user: { ...user, permissions: ["leads.edit"] }, supabase: { from: () => query } }) },
    "@/lib/server/operational-gmail": { canConnectMailbox: () => {}, canSyncMailbox: permissions => {
      assert.deepEqual(permissions, ["leads.edit"]);
    } },
    "@/lib/server/login": { checkOrigin: () => {} },
    "@/lib/server/integration-settings": { getIntegrationConfig: async () => config },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({ from: () => query }) },
  });
  const result = await route.GET();
  assert.equal(result.data.managed, true);
  assert.equal(result.data.connection.email, user.email);
  assert.equal(result.data.connection.last_synced_at, null);
  assert.equal(result.data.canSync, true);
  assert.equal(result.data.canConnect, false);
  assert.equal(Object.hasOwn(result.data, "messages"), false, "mailbox status never returns a general inbox list");
  assert.ok(!JSON.stringify(result).includes(account.private_key));
  connection = { email: user.email, auth_mode: "workspace", sync_state: { mode: "history" }, sync_lock_at: new Date(Date.now() - 16 * 60000).toISOString() };
  assert.equal((await route.GET()).data.connection.syncInProgress, false, "expired sync leases must not leave the mailbox locked in the UI");
  connection.sync_lock_at = new Date().toISOString();
  assert.equal((await route.GET()).data.connection.syncInProgress, true);
  assert.equal((await route.DELETE(new Request("https://crm.example"))).status, 409);
});

test("managed mode refuses new OAuth connections and pending callbacks before credential writes", async () => {
  const mocks = {
    "@/lib/server/login": { checkOrigin: () => {} },
    "@/lib/server/operational-gmail": { canConnectMailbox: () => {} },
    "@/lib/server/integration-settings": { getIntegrationConfig: async () => config },
    "@/lib/supabase/server": {},
    "@/lib/server/operational-intake": {},
    "next/headers": {},
  };
  const connect = load("src\\app\\api\\integrations\\gmail\\connect\\route.ts", mocks);
  assert.equal((await connect.POST(new Request("https://crm.example"))).status, 409);
  const callback = load("src\\app\\api\\auth\\gmail\\callback\\route.ts", mocks);
  assert.equal((await callback.GET(new Request("https://crm.example"))).status, 409);
});

test("OAuth callback explains when Workspace settings are not active after a Gmail API 403", async () => {
  const state = "a".repeat(43);
  const oauthConfig = { GOOGLE_MAILBOX_MODE: "oauth" };
  const query = {
    delete: () => query, eq: () => query, gt: () => query, select: () => query,
    maybeSingle: async () => ({ data: { encrypted_verifier: "stored-verifier" }, error: null }),
  };
  const admin = { from: () => query };
  const callback = load("src\\app\\api\\auth\\gmail\\callback\\route.ts", {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user, supabase: {} }) },
    "@/lib/server/env": { appUrl: () => "https://crm.example" },
    "@/lib/server/integration-settings": { getIntegrationConfig: async () => oauthConfig },
    "@/lib/server/login-crypto": { decryptSession: () => "verifier" },
    "@/lib/server/operational": { databaseError: error => { if (error) throw error; } },
    "@/lib/server/operational-intake": { secureEqual: () => true },
    "@/lib/server/operational-gmail": {
      canConnectMailbox() {}, crmSessionId: async () => "session",
      gmailCallback: () => "https://crm.example/api/auth/gmail/callback", gmailCookie: "oauth-cookie",
      gmailCryptoKey: () => "key", gmailScopes: ["read", "send"],
      googleTokenRequest: async () => ({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "read send" }),
      gmailRequest: async () => { throw new HttpError(403, "Gmail request failed (Google HTTP 403)."); },
      oauthStateHash: () => "hash",
    },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
    "next/headers": { cookies: async () => ({ get: () => ({ value: state }), set() {} }) },
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } },
  });
  const result = await callback.GET(new Request(`https://crm.example/api/auth/gmail/callback?state=${state}&code=authorization-code`));
  assert.equal(result.status, 403);
  assert.match(result.error, /individual OAuth/);
  assert.match(result.error, /live CRM has saved Workspace mode/);
});

test("OAuth connect accepts new domain users, supplies Google domain hint and requires credentials", async () => {
  const oauthConfig = {
    GOOGLE_MAILBOX_MODE: "oauth", GOOGLE_CLIENT_ID: "test-client", GOOGLE_CLIENT_SECRET: "test-secret",
    GOOGLE_REDIRECT_URI: "https://crm.example/api/auth/gmail/callback",
  };
  let email = "new.employee@dmhca.in", writes = 0;
  const query = { delete: () => query, lt: async () => ({ error: null }),
    insert: async row => { writes++; assert.equal(row.user_id, user.id); return { error: null }; } };
  const mocks = {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user: { ...user, email }, supabase: {} }) },
    "@/lib/server/integration-settings": {
      getIntegrationConfig: async () => oauthConfig,
      requireIntegrationValue: (values, name) => {
        if (!values[name]) throw new HttpError(503, `${name} is not configured`);
        return values[name];
      },
    },
    "@/lib/server/operational-gmail": {
      ...load("src\\lib\\server\\operational-gmail.ts"),
      crmSessionId: async () => "verified-session",
    },
    "@/lib/server/login": { checkOrigin: () => {} },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({ from: () => query }) },
    "next/headers": { cookies: async () => ({ set: () => {} }) },
  };
  const route = load("src\\app\\api\\integrations\\gmail\\connect\\route.ts", mocks);
  const request = () => new Request("https://crm.example", { method: "POST" });
  const url = new URL((await route.POST(request())).data.url);
  assert.equal(url.searchParams.get("hd"), "dmhca.in");
  assert.equal(url.searchParams.get("login_hint"), email);
  assert.equal(url.searchParams.get("client_id"), "test-client");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal(writes, 1);
  email = "outsider@gmail.com";
  assert.equal((await route.POST(request())).status, 403);
  email = "another.new.employee@dmhca.in";
  oauthConfig.GOOGLE_CLIENT_ID = "";
  assert.equal((await route.POST(request())).status, 503);
  oauthConfig.GOOGLE_CLIENT_ID = "test-client";
  oauthConfig.GOOGLE_CLIENT_SECRET = "";
  assert.equal((await route.POST(request())).status, 503);
  assert.equal(writes, 1, "Rejected accounts and missing setup must not create OAuth state");
});

test("OAuth status hides old outside-domain mailboxes and disables connect and sync", async () => {
  let email = "outside@gmail.com";
  const query = { select: () => query, eq: () => query, order: () => query,
    limit: async () => ({ data: [{ subject: "old mail" }], error: null }),
    maybeSingle: async () => ({ data: { email, auth_mode: "oauth" }, error: null }) };
  const mocks = {
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user: { ...user, email }, supabase: { from: () => query } }) },
    "@/lib/server/integration-settings": { getIntegrationConfig: async () => ({ GOOGLE_MAILBOX_MODE: "oauth" }) },
    "@/lib/server/login": { checkOrigin: () => {} },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({ from: () => query }) },
  };
  const route = load("src\\app\\api\\integrations\\gmail\\route.ts", mocks);
  const outside = (await route.GET()).data;
  assert.equal(outside.canConnect, false);
  assert.equal(outside.canSync, false);
  assert.equal(outside.connection, null);
  assert.equal(Object.hasOwn(outside, "messages"), false);
  assert.match(outside.unavailableReason, /@dmhca.in/);
  const api = load("src\\lib\\server\\operational-gmail.ts", mocks);
  const mailbox = await api.currentGmailMailbox({}, user.id, email);
  assert.equal(mailbox.email, "");
  assert.match(mailbox.reason, /@dmhca.in/);
  await assert.rejects(api.validGmailToken({}, { user_id: user.id, encrypted_tokens: "must-not-decrypt" }, email), error => error.status === 403);
  email = "new.employee@dmhca.in";
  const inside = (await route.GET()).data;
  assert.equal(inside.canConnect, true);
  assert.equal(inside.canSync, true);
  assert.equal(inside.connection.email, email);
});

test("sync automatically initializes only the authenticated mailbox and commits under its lease", async () => {
  const writes = [], commits = [];
  let connectionEmail = user.email, cleaned = 0, tokenRequests = 0;
  const admin = {
    from(table) {
      assert.equal(table, "gmail_connections");
      return {
        upsert: async (row, options) => { writes.push(row); assert.equal(options.ignoreDuplicates, true); return { error: null }; },
        update(values) {
          const query = {
            eq(column, value) { if (column === "user_id") assert.equal(value, user.id); return query; },
            or: () => query, select: () => query,
            maybeSingle: async () => ({ data: { user_id: user.id, email: connectionEmail, encrypted_tokens: null, sync_state: { mode: "bootstrap" }, history_id: null }, error: null }),
            then(resolve, reject) { cleaned++; assert.equal(values.sync_lock_at, null); return Promise.resolve({ error: null }).then(resolve, reject); },
          };
          return query;
        },
      };
    },
    rpc: async (name, args) => { commits.push({ name, args }); return { error: null }; },
  };
  const settings = { getIntegrationConfig: async () => config, integrationStatus: async () => ({ configured: true }) };
  const mocks = {
    "@/lib/server/integration-settings": settings,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
    "@/lib/server/login": { checkOrigin: () => {} },
    fetch: async (url, init) => { if (url.endsWith("/token")) tokenRequests++; return providerFetch()(url, init); },
  };
  const helpers = load("src\\lib\\server\\operational-gmail.ts", mocks);
  const route = load("src\\app\\api\\integrations\\gmail\\sync\\route.ts", {
    ...mocks, "@/lib/server/auth": { ...auth, requireUser: async permission => {
      assert.equal(permission, undefined);
      return { user: { ...user, permissions: ["leads.edit"] }, supabase: { from: () => assert.fail("No sender means no lead lookup") } };
    } },
    "@/lib/server/operational-gmail": { ...helpers, gmailSyncPage: async token => {
      assert.equal(token, "delegated-token");
      return { messages: [], more: false, state: { mode: "history" }, historyId: "100" };
    } },
  });
  const response = await route.POST(new Request("https://crm.example", {
    method: "POST", body: JSON.stringify({ user_id: "another-user", email: "someone-else@dmhca.in" }),
  }));
  assert.equal(response.status, 200, response.error);
  assert.equal(writes[0].user_id, user.id);
  assert.equal(writes[0].email, user.email);
  assert.equal(commits[0].name, "integration_commit_gmail");
  assert.equal(commits[0].args.p_user_id, user.id);
  assert.equal(commits[0].args.p_history_id, "100");
  assert.equal(tokenRequests, 1);
  connectionEmail = "previous-login@dmhca.in";
  assert.equal((await route.POST(new Request("https://crm.example", { method: "POST" }))).status, 409);
  assert.equal(tokenRequests, 1, "mismatched stored mailbox must not request a Google token");
  assert.equal(commits.length, 1, "mismatched stored mailbox must not advance history");
  assert.equal(cleaned, 1);
});
