const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(relativePath, extra = {}) {
  const api = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, "..", relativePath), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, { exports: api, require, Buffer, ...extra });
  return api;
}
const crypto = load("src\\lib\\server\\login-crypto.ts");
const routing = load("src\\lib\\auth-routing.ts");
const key = crypto.encryptionKey("ab".repeat(32));

test("pending sessions are encrypted, randomized, authenticated and round-trip correctly", () => {
  const secret = JSON.stringify({ access_token: "private-access", refresh_token: "private-refresh" });
  const first = crypto.encryptSession(secret, key);
  const second = crypto.encryptSession(secret, key);
  assert.notEqual(first, second);
  assert.equal(first.includes("private"), false);
  assert.equal(crypto.decryptSession(first, key), secret);
  const changed = Buffer.from(first, "base64url");
  changed[changed.length - 1] ^= 1;
  assert.throws(() => crypto.decryptSession(changed.toString("base64url"), key));
  assert.throws(() => crypto.decryptSession(first, crypto.encryptionKey("cd".repeat(32))));
});

test("encryption rejects empty and malformed keys", () => {
  for (const value of ["", "abc", "z".repeat(64), "ab".repeat(31), "ab".repeat(33)]) assert.throws(() => crypto.encryptionKey(value));
});

test("OTP hashes are bound to both the random browser challenge and encryption secret", () => {
  assert.equal(crypto.loginHash("challenge:123456", key).length, 64);
  assert.notEqual(crypto.loginHash("one:123456", key), crypto.loginHash("two:123456", key));
  assert.notEqual(crypto.loginHash("one:123456", key), crypto.loginHash("one:123457", key));
});

test("post-login destinations reject external, malformed and authentication paths", () => {
  for (const value of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "/\nevil", "/login", "/login?next=x", "/api/auth/logout", "/auth/callback"])
    assert.equal(routing.safeNextPath(value), "/", String(value));
  assert.equal(routing.safeNextPath("/leads?stage=Warm"), "/leads?stage=Warm");
});

test("public-route matching has boundaries and does not expose similarly named CRM pages", () => {
  assert.equal(routing.isPublicPath("/login"), true);
  assert.equal(routing.isPublicPath("/reset-password"), true);
  assert.equal(routing.isPublicPath("/api/auth/verify"), true);
  assert.equal(routing.isPublicPath("/invoice-status/secure-token"), true);
  assert.equal(routing.isPublicPath("/api/invoice-status/secure-token"), true);
  for (const path of ["/login-secrets", "/login/admin", "/api/authentication", "/invoice-statusx/token", "/users", "/admin/login-activity"])
    assert.equal(routing.isPublicPath(path), false);
});
