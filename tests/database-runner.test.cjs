const { test } = require("node:test");
const assert = require("node:assert/strict");
const { migrationBody, pendingMigrations } = require("../scripts/database.cjs");

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
