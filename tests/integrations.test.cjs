const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createHmac, webcrypto } = require("node:crypto");
const z = require("zod");

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
function parseInput(schema, value) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "Invalid input");
  return parsed.data;
}
const auth = { HttpError, jsonError: (error) => ({ error: error.message, status: error.status }) };
const operational = { parseInput, uuid: z.string().uuid(), databaseError: (error) => { if (error) throw error; } };
const secret = "only-a-test-signing-secret";
const integrationConfig = {
  FACEBOOK_APP_SECRET: secret, FACEBOOK_PAGE_ID: "1234", FACEBOOK_PAGE_ACCESS_TOKEN: "private-page-token",
  FACEBOOK_GRAPH_VERSION: "v25.0", FACEBOOK_APP_ID: "9999", LEAD_INTAKE_SIGNING_KEY: secret,
  GOOGLE_REDIRECT_URI: "https://crm.example/api/auth/gmail/callback", GOOGLE_CLIENT_ID: "test", GOOGLE_CLIENT_SECRET: "test",
};
const integrationSettings = {
  getIntegrationConfig: async () => integrationConfig,
  requireIntegrationValue(config, name) {
    if (!config[name]) throw new HttpError(503, `${name} is required`);
    return config[name];
  },
  assertIntegrationAdmin(user) {
    if (!user || !["admin", "super_admin"].includes(user.profile.role) || !user.permissions.includes("integrations.manage"))
      throw new HttpError(403, "Admin only");
  },
};
function load(path, mocks = {}, globals = {}) {
  const exports = {};
  const source = readFileSync(join(__dirname, "..", ...path.split("/")), "utf8");
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, { exports, Buffer, Date, Number, Set, Map, URL, URLSearchParams, AbortSignal, Request, Response, process, console, crypto: webcrypto,
    require: (name) => name in mocks ? mocks[name] : name === "@/lib/server/integration-settings" ? integrationSettings : require(name), ...globals });
  return exports;
}
const intake = load("src/lib/server/operational-intake.ts", {
  "@/lib/server/auth": auth, "@/lib/server/operational": operational,
}, { process: { env: { NEXT_PUBLIC_APP_URL: "https://crm.example" } } });
const validLead = { name: "New enquiry", phone: "+91 98765 43210", email: "student@example.com" };
const raw = JSON.stringify({ event_id: "submission-1", lead: validLead });

test("intake signatures authenticate exact raw bytes, timestamp and signing key", () => {
  const time = String(Math.floor(Date.now() / 1000));
  const signature = "v1=" + createHmac("sha256", secret).update(`${time}.${raw}`).digest("hex");
  assert.equal(intake.intakeSignatureValid(raw, time, signature, secret), true);
  assert.equal(intake.intakeSignatureValid(raw + " ", time, signature, secret), false);
  assert.equal(intake.intakeSignatureValid(raw, String(Number(time) - 600), signature, secret), false);
  assert.equal(intake.intakeSignatureValid(raw, time, signature, "different"), false);
  assert.equal(intake.intakeSignatureValid(raw, "NaN", signature, secret), false);
});

test("public intake rejects arbitrary assignment, unknown fields and invalid lead data", () => {
  assert.equal(intake.intakeSchema.safeParse({ event_id: "1", lead: validLead }).success, true);
  for (const lead of [{ ...validLead, assignee_id: "injected" }, { ...validLead, phone: "bad" }, { ...validLead, email: "invalid" }, { ...validLead, name: "" }]) {
    assert.equal(intake.intakeSchema.safeParse({ event_id: "1", lead }).success, false);
  }
  assert.equal(intake.intakeSchema.safeParse({ event_id: "1", lead: validLead, stage_id: "injected" }).success, false);
  assert.equal(intake.intakeSchema.safeParse({ event_id: "", lead: validLead }).success, false);
});

test("source settings require a Facebook page and exact allowed origins", () => {
  const source = { name: "Web", owner_id: "10000000-0000-4000-8000-000000000001", channel: "website" };
  assert.equal(intake.sourceSchema.safeParse(source).success, true);
  assert.equal(intake.sourceSchema.safeParse({ ...source, channel: "facebook" }).success, false);
  assert.equal(intake.sourceSchema.safeParse({ ...source, allowed_origins: ["https://example.com/path"] }).success, false);
});

test("source assignment changes reject inactive/inaccessible owners before privileged writes", async () => {
  let privileged = 0;
  const chain = { select: () => chain, eq: () => chain, is: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
  const route = load("src/app/api/integrations/sources/route.ts", {
    "next/server": { NextResponse: { json: (value) => value } },
    "@/lib/server/auth": { ...auth, readJson: (request) => request.json(), requireUser: async (permission) => {
      assert.equal(permission, "integrations.manage"); return {
        supabase: { from: () => chain },
        user: { id: "admin", profile: { role: "admin" }, permissions: ["integrations.manage"] },
      };
    } },
    "@/lib/server/operational": operational, "@/lib/server/operational-intake": intake,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { privileged++; throw new Error("Must not run"); } },
  });
  const result = await route.PATCH(new Request("https://crm.example/api/integrations/sources", { method: "PATCH", headers: { origin: "https://crm.example" }, body: JSON.stringify({
    id: "33000000-0000-4000-8000-000000000001", owner_id: "11000000-0000-4000-8000-000000000002", stage_id: "",
  }) }));
  assert.equal(result.status, 400);
  assert.equal(privileged, 0);
});

test("unsigned web submissions never acquire a privileged client", async () => {
  let adminCalls = 0;
  const route = load("src/app/api/webhooks/lead-intake/route.ts", {
    "next/server": { NextResponse: { json: (value) => value } }, "@/lib/server/auth": auth,
    "@/lib/server/env": { requireEnv: () => secret }, "@/lib/server/operational": operational,
    "@/lib/server/operational-intake": intake,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { adminCalls++; throw new Error("Must not run"); } },
  });
  const result = await route.POST(new Request("https://crm.example/api/webhooks/lead-intake", { method: "POST", body: raw, headers: { "Content-Type": "application/json" } }));
  assert.equal(result.status, 401);
  assert.equal(adminCalls, 0);
});

test("Facebook exact-body signatures and validated real field mapping", () => {
  const signature = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  assert.equal(intake.facebookSignatureValid(raw, signature, secret), true);
  assert.equal(intake.facebookSignatureValid(raw + " ", signature, secret), false);
  const lead = intake.facebookLead([
    { name: "full_name", values: ["Student"] }, { name: "phone_number", values: ["+919876543210"] },
    { name: "email", values: ["student@example.com"] },
  ]);
  assert.equal(lead.name, "Student");
  assert.equal(lead.phone, "+919876543210");
  assert.throws(() => intake.facebookLead([{ name: "full_name", values: ["Missing phone"] }]));
});

test("signed Facebook leadgen retrieves real Graph fields once and replays without another provider call", async () => {
  let networkCalls = 0, writes = 0, saved;
  const body = JSON.stringify({ object: "page", entry: [{ id: "1234", changes: [{ field: "leadgen", value: { page_id: "1234", form_id: "4321", leadgen_id: "5678" } }] }] });
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const admin = {
    from: (table) => {
      const result = () => ({
        error: null,
        data: table === "facebook_page_connections" ? null
          : table === "intake_source_settings" ? [{ source_id: "source", facebook_form_id: "4321" }]
            : table === "lead_sources" ? { is_active: true } : writes ? { id: "persisted-event" } : null,
      });
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => result(), then: (resolve) => resolve(result()) };
      return chain;
    },
  };
  const providerIntake = load("src/lib/server/operational-intake.ts", {
    "@/lib/server/auth": auth, "@/lib/server/operational": operational,
  }, { fetch: async (url, options) => {
    networkCalls++;
    assert.equal(new URL(url).pathname, "/v25.0/5678");
    assert.equal(new URL(url).searchParams.has("access_token"), false);
    assert.equal(options.headers.Authorization, "Bearer private-page-token");
    return Response.json({ id: "5678", form_id: "4321", field_data: [{ name: "full_name", values: ["Real student"] }, { name: "phone_number", values: ["+919876543210"] }] });
  } });
  const route = load("src/app/api/webhooks/facebook/route.ts", {
    "next/server": { NextResponse: { json: (value) => value } },
    "@/lib/server/auth": auth, "@/lib/server/operational": operational,
    "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
    "@/lib/server/operational-intake": { ...providerIntake, recordIntake: async (_admin, sourceId, input) => { assert.equal(sourceId, "source"); writes++; saved = input; } },
  });
  const request = () => new Request("https://crm.example/api/webhooks/facebook", { method: "POST", body, headers: { "x-hub-signature-256": signature } });
  assert.equal((await route.POST(request())).accepted, 1);
  assert.equal(saved.event_id, "facebook:5678");
  assert.equal(saved.lead.name, "Real student");
  assert.equal((await route.POST(request())).accepted, 1);
  assert.equal(networkCalls, 1);
  assert.equal(writes, 1);
});

function gmail(fetch) {
  return load("src/lib/server/operational-gmail.ts", {
    "@/lib/server/auth": auth, "@/lib/server/operational": operational,
    "@/lib/server/env": { appUrl: () => "https://crm.example", requireEnv: (name) => name === "GOOGLE_REDIRECT_URI" ? "https://crm.example/api/auth/gmail/callback" : "test" },
    "@/lib/server/login-crypto": {},
  }, { fetch });
}
const msg = (id, labels = ["INBOX"]) => ({ id, threadId: `thread-${id}`, labelIds: labels, internalDate: "1800000000000",
  payload: { mimeType: "text/plain", body: { data: Buffer.from("Actual inbox body").toString("base64url") },
    headers: [{ name: "From", value: "Student <Student@Example.com>" }, { name: "To", value: "owner@example.com" }, { name: "Subject", value: "Enquiry" }] } });
test("Gmail bootstrap persists a queue and never advances past unprocessed messages", async () => {
  let listRequests = 0;
  const api = gmail(async (url) => {
    const value = String(url);
    if (value.includes("/messages?")) { listRequests++; return Response.json({ messages: Array.from({ length: 40 }, (_, i) => ({ id: String(i) })) }); }
    return Response.json(msg(new URL(value).pathname.split("/").pop()));
  });
  const first = await api.gmailSyncPage("token", { mode: "bootstrap", baseline: "100" }, null);
  assert.equal(first.messages.length, 25);
  assert.equal(first.state.queue.length, 15);
  assert.equal(first.historyId, null);
  assert.equal(first.more, true);
  const second = await api.gmailSyncPage("token", first.state, first.historyId);
  assert.equal(second.messages.length, 15);
  assert.equal(second.historyId, "100");
  assert.equal(second.state.mode, "history");
  assert.equal(second.more, false);
  assert.equal(listRequests, 1);
  assert.equal(second.messages[0].from_email, "student@example.com");
  assert.equal(second.messages[0].body, "Actual inbox body");
});

test("Gmail history follows page tokens, records deletes and advances only at final page", async () => {
  const requested = [];
  const api = gmail(async (url) => {
    const value = new URL(String(url)); requested.push(value);
    if (value.pathname.endsWith("/history")) {
      return Response.json(value.searchParams.has("pageToken") ? { historyId: "200", history: [{ messagesDeleted: [{ message: { id: "gone" } }] }] } :
        { historyId: "200", nextPageToken: "next", history: [{ messagesAdded: [{ message: { id: "new" } }], labelsRemoved: [{ message: { id: "archived" } }] }] });
    }
    const id = value.pathname.split("/").pop();
    return id === "gone" ? new Response("", { status: 404 }) : Response.json(msg(id, id === "archived" ? [] : ["INBOX"]));
  });
  const first = await api.gmailSyncPage("token", { mode: "history" }, "100");
  assert.equal(first.historyId, "100");
  assert.equal(first.state.pageToken, "next");
  assert.equal(first.messages.find((item) => item.gmail_message_id === "archived").in_inbox, false);
  const last = await api.gmailSyncPage("token", first.state, first.historyId);
  assert.equal(last.historyId, "200");
  assert.equal(last.messages[0].is_deleted, true);
  assert.equal(last.more, false);
  assert.ok(requested.find((url) => url.searchParams.get("pageToken") === "next" && url.searchParams.get("startHistoryId") === "100"));
});

test("Gmail errors do not manufacture message data or advance the history cursor", async () => {
  const api = gmail(async () => new Response("", { status: 503 }));
  await assert.rejects(api.gmailSyncPage("token", { mode: "history" }, "100"), /Gmail request failed/);
});

test("personal mailbox connection is available to lead editors but not viewers", () => {
  const api = gmail(() => assert.fail("No network expected"));
  api.canConnectMailbox(["leads.edit"]);
  api.canConnectMailbox(["integrations.manage"]);
  assert.throws(() => api.canConnectMailbox(["leads.view"]), /permission/);
});

test("Gmail MIME encodes Unicode safely, folds headers and rejects header injection", () => {
  const api = gmail(() => assert.fail("No network expected"));
  const subject = "Course details \u{1F393}".repeat(12);
  const message = Buffer.from(api.gmailRawMessage("owner@gmail.com", "lead@example.com", subject, "Hello \u00e9"), "base64url").toString();
  assert.match(message, /From: owner@gmail.com\r\nTo: lead@example.com/);
  assert.ok(message.split("\r\n").every(line => line.length <= 78));
  const encodedSubject = message.match(/Subject: ([\s\S]*?)\r\nMIME-Version/)[1];
  const decoded = [...encodedSubject.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(match => Buffer.from(match[1], "base64").toString()).join("");
  assert.equal(decoded, subject);
  assert.equal(Buffer.from(message.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString(), "Hello \u00e9");
  assert.throws(() => api.gmailRawMessage("owner@gmail.com", "lead@example.com", "Subject\r\nBcc: other@example.com", "body"), /headers/);
  assert.throws(() => api.gmailRawMessage("owner@gmail.com\r\nBcc: other@example.com", "lead@example.com", "Subject", "body"), /headers/);
});

test("Gmail sending posts the real mailbox message and surfaces authorization errors", async () => {
  let sent;
  const api = gmail(async (url, options) => {
    assert.equal(url, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer personal-token");
    sent = Buffer.from(JSON.parse(options.body).raw, "base64url").toString();
    return Response.json({ id: "google-message-id" });
  });
  const result = await api.sendGmailMessage({ email: "owner@gmail.com", accessToken: "personal-token" }, "lead@example.com", "Course", "Message");
  assert.equal(result.id, "google-message-id");
  assert.match(sent, /From: owner@gmail.com/);
  const denied = gmail(async () => new Response("", { status: 403 }));
  await assert.rejects(denied.sendGmailMessage({ email: "owner@gmail.com", accessToken: "expired" }, "lead@example.com", "Course", "Message"), /Reconnect/);
});

test("personal Gmail sender uses only the current user's connection and rejects old read-only consent", async () => {
  const cryptoHelpers = load("src/lib/server/login-crypto.ts");
  const key = Buffer.alloc(32, 8);
  const api = load("src/lib/server/operational-gmail.ts", {
    "@/lib/server/auth": auth, "@/lib/server/operational": operational,
    "@/lib/server/env": { requireEnv: () => key.toString("hex") },
    "@/lib/server/login-crypto": cryptoHelpers,
  }, { fetch: () => assert.fail("Unexpired access token needs no network") });
  let connection = null;
  const admin = { from(table) {
    assert.equal(table, "gmail_connections");
    const chain = { select: () => chain, eq: (column, value) => { assert.equal(column, "user_id"); assert.equal(value, "signed-in-user"); return chain; }, maybeSingle: async () => ({ data: connection, error: null }) };
    return chain;
  } };
  await assert.rejects(api.prepareGmailSend(admin, "signed-in-user", "actual-mailbox@gmail.com"), /Connect your Gmail/);
  const tokens = { access_token: "personal-token", refresh_token: "refresh", expires_at: Date.now() + 3600000, scope: "https://www.googleapis.com/auth/gmail.readonly" };
  connection = { user_id: "signed-in-user", email: "actual-mailbox@gmail.com", encrypted_tokens: cryptoHelpers.encryptSession(JSON.stringify(tokens), key) };
  await assert.rejects(api.prepareGmailSend(admin, "signed-in-user", "actual-mailbox@gmail.com"), /Reconnect Gmail/);
  tokens.scope += " https://www.googleapis.com/auth/gmail.send";
  connection.encrypted_tokens = cryptoHelpers.encryptSession(JSON.stringify(tokens), key);
  const sender = await api.prepareGmailSend(admin, "signed-in-user", "ACTUAL-MAILBOX@gmail.com");
  assert.equal(sender.email, "actual-mailbox@gmail.com");
  assert.equal(sender.accessToken, "personal-token");
  connection.encrypted_tokens = "must-not-decrypt-mismatched-mailbox";
  await assert.rejects(api.prepareGmailSend(admin, "signed-in-user", "other-counselor@dmhca.in"), /mailbox for your CRM login/);
});

test("Google Workspace mailbox must match each counselor's login email", () => {
  const api = gmail(() => assert.fail("No provider call expected"));
  assert.equal(api.requireLoginMailbox("guneswari@dmhca.in", "guneswari@dmhca.in"), "guneswari@dmhca.in");
  assert.equal(api.requireLoginMailbox("counselor@dmhca.in", "COUNSELOR@dmhca.in"), "counselor@dmhca.in");
  assert.throws(() => api.requireLoginMailbox("personal@gmail.com", "guneswari@dmhca.in"), /different email account/);
  assert.throws(() => api.requireLoginMailbox("guneswari@dmhca.in", "counselor@dmhca.in"), /different email account/);
  assert.throws(() => api.requireLoginMailbox("guneswari@dmhca.in", ""), /different email account/);
});

test("Gmail OAuth callback rejects wrong-browser state before service access or token exchange", async () => {
  let privileged = 0;
  const route = load("src/app/api/auth/gmail/callback/route.ts", {
    "next/server": { NextResponse: { json: (value) => value } },
    "next/headers": { cookies: async () => ({ get: () => ({ value: "different-browser-state" }) }) },
    "@/lib/server/auth": { ...auth, requireUser: async () => ({ user: { id: "user", permissions: ["leads.edit"] }, supabase: {} }) },
    "@/lib/server/login-crypto": {}, "@/lib/server/env": {}, "@/lib/server/operational": operational,
    "@/lib/server/operational-intake": intake, "@/lib/server/operational-gmail": { gmailCookie: "crm_gmail_oauth", canConnectMailbox() {} },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { privileged++; throw new Error("Must not run"); } },
  });
  const result = await route.GET(new Request("https://crm.example/api/auth/gmail/callback?state=" + "a".repeat(43) + "&code=test"));
  assert.equal(result.status, 403);
  assert.equal(privileged, 0);
});

test("Gmail OAuth checks login mailbox before storing tokens and consumes verified-session-bound state once", async () => {
  let consumed = false, exchanges = 0, saved;
  let mailboxEmail = "someone-else@gmail.com";
  const state = "a".repeat(43);
  const cryptoHelpers = load("src/lib/server/login-crypto.ts");
  const key = Buffer.alloc(32, 8);
  const route = load("src/app/api/auth/gmail/callback/route.ts", {
    "next/server": { NextResponse: { json: (value) => value, redirect: (url) => ({ redirect: url }) } },
    "next/headers": { cookies: async () => ({ get: () => ({ value: state }), set: () => {} }) },
    "@/lib/server/auth": { ...auth, requireUser: async (permission) => {
      assert.equal(permission, undefined); return { user: { id: "verified-owner", email: "owner@gmail.com", permissions: ["leads.edit", "integrations.view"] }, supabase: {} };
    } },
    "@/lib/server/login-crypto": cryptoHelpers,
    "@/lib/server/env": { appUrl: () => "https://crm.example" },
    "@/lib/server/operational": operational, "@/lib/server/operational-intake": intake,
    "@/lib/server/operational-gmail": {
      gmailCookie: "crm_gmail_oauth", crmSessionId: async () => "verified-session", oauthStateHash: (value) => "hash-" + value,
      canConnectMailbox() {}, gmailScopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
      requireLoginMailbox: gmail(() => assert.fail("No provider call expected")).requireLoginMailbox,
      gmailCryptoKey: () => key, gmailCallback: () => "https://crm.example/api/auth/gmail/callback",
      googleTokenRequest: async (input) => {
        exchanges++; assert.equal(input.code_verifier, "pkce-verifier");
        return { access_token: "private-access-token", refresh_token: "private-refresh-token", expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send" };
      },
      gmailRequest: async () => ({ emailAddress: mailboxEmail, historyId: "100" }),
    },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({
      from: (table) => {
        assert.equal(table, "gmail_oauth_states");
        const chain = {
          delete: () => chain, eq: (field, value) => {
            if (field === "user_id") assert.equal(value, "verified-owner");
            if (field === "session_id") assert.equal(value, "verified-session");
            return chain;
          }, gt: () => chain, select: () => chain,
          maybeSingle: async () => { const data = consumed ? null : { encrypted_verifier: cryptoHelpers.encryptSession("pkce-verifier", key) }; consumed = true; return { data, error: null }; },
        };
        return chain;
      },
      rpc: async (name, input) => { assert.equal(name, "integration_set_gmail"); saved = input; return { error: null }; },
    }) },
  });
  const request = () => new Request("https://crm.example/api/auth/gmail/callback?state=" + state + "&code=oauth-code");
  const mismatch = await route.GET(request());
  assert.equal(mismatch.status, 409);
  assert.equal(saved, undefined);
  assert.equal(consumed, true);
  consumed = false; mailboxEmail = "owner@gmail.com";
  assert.equal((await route.GET(request())).redirect, "https://crm.example/integrations?gmail=connected");
  assert.equal(exchanges, 2);
  assert.equal(saved.p_user_id, "verified-owner");
  assert.equal(saved.p_encrypted_tokens.includes("private-access-token"), false);
  const tokens = JSON.parse(cryptoHelpers.decryptSession(saved.p_encrypted_tokens, key));
  assert.equal(tokens.refresh_token, "private-refresh-token");
  assert.ok(tokens.scope.includes("gmail.send"));
  assert.equal((await route.GET(request())).status, 403);
  assert.equal(exchanges, 2);
});
