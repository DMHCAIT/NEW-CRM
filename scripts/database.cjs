const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { Client } = require("pg");

const root = resolve(__dirname, "..");

function migrationBody(sql) {
  return sql.replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "");
}

function pendingMigrations(files, history) {
  const recorded = new Map(history.map((row) => [row.filename, row.sha256]));
  for (const row of history) {
    const file = files.find((item) => item.filename === row.filename);
    if (!file || file.sha256 !== row.sha256) throw new Error("Migration history differs from local files. Manual reconciliation is required.");
  }
  let missing = false;
  for (const file of files) {
    if (!recorded.has(file.filename)) missing = true;
    else if (missing) throw new Error("Migration history is out of order. Manual reconciliation is required.");
  }
  return files.filter((file) => !recorded.has(file.filename));
}

async function inspect(client) {
  const { rows: tables } = await client.query("select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename");
  const { rows: [ledger] } = await client.query("select to_regclass('crm_migrations.history') is not null as exists");
  const history = ledger.exists ? (await client.query("select filename,sha256 from crm_migrations.history order by filename")).rows : [];
  return { tables, history, tracked: ledger.exists };
}

async function main() {
  require("@next/env").loadEnvConfig(root);
  const action = process.argv[2];
  if (!["check", "migrate"].includes(action)) throw new Error("Use npm run db:check or npm run db:migrate.");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in .env.local.");
  const url = new URL(process.env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  const caPath = resolve(root, process.env.DATABASE_CA_CERT_PATH || "supabase-ca.crt");
  const ca = readFileSync(caPath, "utf8");
  // Set TLS explicitly so connection-string SSL parameters cannot disable verification.
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl", "uselibpqcompat"]) url.searchParams.delete(parameter);
  const client = new Client({
    connectionString: url.toString(),
    ssl: { ca, rejectUnauthorized: true },
    connectionTimeoutMillis: 20000,
    query_timeout: 120000,
    application_name: "dmhca-crm-migrations",
  });
  let transaction = false;
  try {
    await client.connect();
    console.log("Database connection: certificate and hostname verified.");
    const directory = join(root, "supabase", "migrations");
    const files = readdirSync(directory).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort().map((filename) => {
      const sql = readFileSync(join(directory, filename), "utf8");
      return { filename, sql, sha256: createHash("sha256").update(sql).digest("hex") };
    });
    if (action === "migrate") {
      await client.query("begin");
      transaction = true;
      await client.query("set local lock_timeout='15s'");
      await client.query("select pg_advisory_xact_lock(hashtextextended('dmhca.crm.migrations',0))");
    }
    const state = await inspect(client);
    const pending = pendingMigrations(files, state.history);
    console.log(`Public tables: ${state.tables.length}; recorded migrations: ${state.history.length}; pending migrations: ${pending.length}.`);
    if (state.tables.length) console.log("Tables: " + state.tables.map((table) => table.tablename).join(", "));
    if (action === "check") {
      if (!state.tracked && state.tables.length) console.log("Existing untracked tables detected. Migration execution will refuse automatic changes.");
      for (const file of pending) console.log("Pending: " + file.filename);
      return;
    }
    if (!state.history.length) {
      const { rows: [objects] } = await client.query(`select
        exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p','v','m','S','f')) as relations,
        exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
          where n.nspname='public' and t.typtype='e') as enums`);
      const { rows: [external] } = await client.query("select to_regclass('supabase_migrations.schema_migrations') is not null as exists");
      let externalCount = 0;
      if (external.exists) externalCount = Number((await client.query("select count(*) as count from supabase_migrations.schema_migrations")).rows[0].count);
      if (objects.relations || objects.enums || externalCount) throw new Error("Existing schema or external migration history detected. Refusing automatic initialization; reconcile applied migrations first.");
    }
    await client.query("create schema if not exists crm_migrations");
    await client.query("revoke all on schema crm_migrations from public,anon,authenticated");
    await client.query(`create table if not exists crm_migrations.history(
      filename text primary key,sha256 text not null,applied_at timestamptz not null default now())`);
    await client.query("revoke all on crm_migrations.history from public,anon,authenticated");
    for (const file of pending) {
      console.log("Applying: " + file.filename);
      await client.query(migrationBody(file.sql));
      await client.query("insert into crm_migrations.history(filename,sha256) values($1,$2)", [file.filename, file.sha256]);
    }
    await client.query("notify pgrst,'reload schema'");
    await client.query("commit");
    transaction = false;
    console.log(`Committed ${pending.length} migrations. No database reset or user data deletion performed.`);
    const after = await inspect(client);
    console.log(`Verified ${after.tables.length} public tables and ${after.history.length} migration records.`);
  } catch (error) {
    if (transaction) {
      try { await client.query("rollback"); console.error("Migration transaction rolled back."); }
      catch { console.error("Rollback could not be confirmed; inspect migration history before retrying."); }
    }
    if (error.code) throw new Error(`Database operation failed (${error.code}). Inspect the database configuration and migration SQL.`);
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    // Never print connection objects, provider responses, passwords or environment contents.
    const safe = error.message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted database URL]");
    console.error(safe);
    process.exitCode = 1;
  });
}

module.exports = { migrationBody, pendingMigrations };
