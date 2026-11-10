const { createHash } = require("node:crypto");
const { readFileSync, readdirSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { Client } = require("pg");

const root = resolve(__dirname, "..");
const requiredColumns = [
  "leads.billing_address", "gmail_connections.auth_mode",
  "courses.price_inr", "courses.price_usd", "courses.price_ibmp_usd", "invoice_companies.code",
  "invoices.course_id", "invoices.company_code", "invoices.company_snapshot",
  "invoices.billing_address", "invoices.status_token_encrypted",
  "invoices.stripe_session_id", "invoices.stripe_checkout_url", "payments.stripe_payment_id",
  "invoices.enrollment_subtotal", "invoices.enrollment_discount", "invoices.enrollment_tax",
  "invoices.enrollment_tax_percent", "invoices.installment_number",
  "invoices.payment_expires_at", "invoices.stripe_expires_at", "invoices.tax_review_required",
  "invoices.pricing_review_note", "invoices.payment_revision", "invoice_checkout_sessions.session_id",
  "invoices.invoice_date", "invoices.scheduled_for", "invoices.plan_request_id",
  "invoices.delivery_error", "invoices.delivery_attempted_at",
  "invoice_companies.invoice_profile", "invoices.document_details",
  "notifications.lead_id", "notifications.event_key", "notification_email_queue.claim_token",
  "profiles.email_signature_html", "emails.body_html",
];

function databaseOptions(env, projectRoot = root) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required. Configure it in .env.local for local use or in the live server environment for deployment.");
  let url;
  try { url = new URL(env.DATABASE_URL); }
  catch { throw new Error("DATABASE_URL must be a valid PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  if (["host", "hostaddr", "port"].some(parameter => url.searchParams.has(parameter))) throw new Error("Set the database host and port in the DATABASE_URL authority, not in query parameters.");
  const sslMode = env.DATABASE_SSL_MODE || "verify";
  if (!["verify", "disable"].includes(sslMode)) throw new Error("DATABASE_SSL_MODE must be verify or disable.");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (sslMode === "disable" && !loopback) throw new Error("Disabling database TLS is permitted only for a local loopback database.");
  let ssl = false;
  if (sslMode === "verify") {
    let ca;
    try { ca = readFileSync(resolve(projectRoot, env.DATABASE_CA_CERT_PATH || "supabase-ca.crt"), "utf8"); }
    catch { throw new Error("Database CA certificate could not be read. Set DATABASE_CA_CERT_PATH to the certificate downloaded from Supabase Database > Settings > SSL Configuration."); }
    ssl = { ca, rejectUnauthorized: true };
  }
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert", "ssl", "uselibpqcompat"]) url.searchParams.delete(parameter);
  return {
    connectionString: url.toString(), ssl,
    connectionTimeoutMillis: 20000, query_timeout: 120000,
    application_name: "dmhca-crm-migrations",
  };
}

async function missingSchemaColumns(client) {
  const tables = [...new Set(requiredColumns.map(name => name.split(".")[0]))];
  const { rows } = await client.query(`select table_name || '.' || column_name as name
    from information_schema.columns where table_schema='public' and table_name=any($1::text[])`, [tables]);
  const available = new Set(rows.map(row => row.name));
  return requiredColumns.filter(name => !available.has(name));
}

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
  const action = process.argv[2];
  if (!["check", "migrate"].includes(action)) throw new Error("Use npm run db:check or npm run db:migrate.");
  const flags = process.argv.slice(3);
  if (flags.some(flag => flag !== "--live")) throw new Error("Only the --live option is supported. Live mode reads server environment variables, not local environment files.");
  const live = flags.includes("--live");
  if (!live) require("@next/env").loadEnvConfig(root, true);
  const options = databaseOptions(process.env);
  const client = new Client(options);
  let transaction = false;
  let connected = false;
  try {
    await client.connect();
    connected = true;
    console.log(options.ssl ? "Database connection: certificate and hostname verified." : "Database connection: local loopback, TLS explicitly disabled.");
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
      const missing = await missingSchemaColumns(client);
      if (missing.length) console.log("Missing required schema columns: " + missing.join(", "));
      if (pending.length || missing.length) throw new Error(`Database schema is not ready. Run npm run db:migrate${live ? ":live" : ""} against this database before starting or deploying the app. Reconcile untracked schemas first.`);
      console.log("Database schema is ready.");
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
    const missing = await missingSchemaColumns(client);
    if (missing.length) throw new Error("Migration history and database schema disagree. Missing columns: " + missing.join(", ") + ". Reconcile the schema before deployment.");
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
    if (!connected) throw new Error(`Database connection failed (${error.code || "timeout/configuration"}). Check the exact Supabase Session pooler host, port, username and database password, network/firewall access and CA certificate. Direct connections require IPv6 on some projects. No migrations were applied.`);
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

module.exports = { migrationBody, pendingMigrations, databaseOptions, missingSchemaColumns };
