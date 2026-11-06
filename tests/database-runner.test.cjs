const { test } = require("node:test");
const assert = require("node:assert/strict");
const { migrationBody, pendingMigrations, databaseOptions, missingSchemaColumns } = require("../scripts/database.cjs");
const { PGlite } = require("@electric-sql/pglite");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("migration wrapper removes only outer transactions and preserves function bodies", () => {
  const body = "create function example() returns void language plpgsql as $$ begin return; end; $$;";
  assert.equal(migrationBody(`begin;\n${body}\ncommit;\n`), body);
  assert.equal(migrationBody(body), body);
});

test("migration planning skips recorded files and rejects modified or out-of-order history", () => {
  const files = [{ filename: "001.sql", sha256: "a" }, { filename: "002.sql", sha256: "b" }];
  assert.equal(pendingMigrations(files, []).length, 2);
  assert.deepEqual(pendingMigrations(files, [{ filename: "001.sql", sha256: "a" }]), [files[1]]);
  assert.deepEqual(pendingMigrations(files, files), []);
  assert.throws(() => pendingMigrations(files, [{ filename: "001.sql", sha256: "changed" }]), /differs/);
  assert.throws(() => pendingMigrations(files, [{ filename: "missing.sql", sha256: "a" }]), /differs/);
  assert.throws(() => pendingMigrations(files, [{ filename: "002.sql", sha256: "b" }]), /out of order/);
});

test("database connections require verified TLS except explicitly disabled loopback servers", () => {
  const options = databaseOptions({
    DATABASE_URL: "postgresql://test:password@db.example.com:5432/postgres?sslmode=disable",
  });
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.ok(options.ssl.ca.includes("BEGIN CERTIFICATE"));
  assert.equal(new URL(options.connectionString).searchParams.has("sslmode"), false);
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(databaseOptions({ DATABASE_URL: `postgresql://test:password@${host}:5432/postgres`, DATABASE_SSL_MODE: "disable" }).ssl, false);
  }
  assert.throws(() => databaseOptions({ DATABASE_URL: "postgresql://test:password@db.example.com/postgres", DATABASE_SSL_MODE: "disable" }), /only for a local loopback/);
  assert.throws(() => databaseOptions({ DATABASE_URL: "postgresql://localhost/postgres?host=db.example.com", DATABASE_SSL_MODE: "disable" }), /not in query parameters/);
  assert.throws(() => databaseOptions({ DATABASE_URL: "not-a-url" }), /valid PostgreSQL URL/);
  assert.throws(() => databaseOptions({}), /live server environment/);
  assert.throws(() => databaseOptions({ DATABASE_URL: "postgresql://localhost/postgres", DATABASE_CA_CERT_PATH: "missing-test-certificate.crt" }), /CA certificate could not be read/);
});

test("live migrations do not load a developer's local database configuration", () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "database.cjs"), "check", "--live"], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DATABASE_URL is required/);
  assert.doesNotMatch(result.stdout, /Database connection:/);
});

test("schema inspection detects billing and mailbox columns missing from an older database", async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("create table public.leads(id uuid); create table public.gmail_connections(user_id uuid);");
  let missing = await missingSchemaColumns(db);
  assert.ok(missing.includes("leads.billing_address"));
  assert.ok(missing.includes("gmail_connections.auth_mode"));
  await db.exec("alter table public.leads add column billing_address text; alter table public.gmail_connections add column auth_mode text;");
  missing = await missingSchemaColumns(db);
  assert.ok(!missing.includes("leads.billing_address"));
  assert.ok(!missing.includes("gmail_connections.auth_mode"));
  assert.ok(missing.includes("invoices.course_id"), "a partial schema update must not pass readiness checks");
});
