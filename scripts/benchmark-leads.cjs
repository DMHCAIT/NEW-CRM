const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { performance } = require("node:perf_hooks");
const { PGlite } = require("@electric-sql/pglite");
const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm");
const assert = require("node:assert/strict");

// This benchmark never reads environment files or connects to an external database.
async function main() {
  const leadCount = Number(process.argv[2] ?? 200000);
  assert.ok(Number.isSafeInteger(leadCount) && leadCount >= 200000 && leadCount <= 1000000,
    "Fixture size must be an integer between 200000 and 1000000");
  const db = new PGlite({ extensions: { pg_trgm } });
  const owner = "11000000-0000-4000-8000-000000000001";
  const session = "21000000-0000-4000-8000-000000000001";
  const counselor = "11000000-0000-4000-8000-000000000002";
  const counselorSession = "21000000-0000-4000-8000-000000000002";
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text);
      create function auth.jwt() returns jsonb language sql stable as $$
        select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
      $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      grant execute on all functions in schema auth to anon,authenticated,service_role;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
    `);
    const directory = join(__dirname, "..", "supabase", "migrations");
    for (const file of readdirSync(directory).filter(name => name.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(join(directory, file), "utf8").replace(/^create extension if not exists pgcrypto;\s*/im, ""));
    }
    await db.query("insert into auth.users values($1,'benchmark@example.test')", [owner]);
    await db.query("insert into public.profiles(id,full_name,email,role) values($1,'Benchmark admin','benchmark@example.test','super_admin')", [owner]);
    await db.query("insert into public.login_sessions(session_id,user_id,email) values($1,$2,'benchmark@example.test')", [session, owner]);
    await db.query("insert into auth.users values($1,'counselor@example.test')", [counselor]);
    await db.query("insert into public.profiles(id,full_name,email,role) values($1,'Benchmark counselor','counselor@example.test','counselor')", [counselor]);
    await db.query("insert into public.login_sessions(session_id,user_id,email) values($1,$2,'counselor@example.test')", [counselorSession, counselor]);
    console.log(`Seeding ${leadCount.toLocaleString("en-US")} synthetic leads in an isolated in-memory database...`);
    const searchIndexes = (await db.query("select indexdef from pg_indexes where schemaname='public' and indexname in ('leads_active_search_idx','leads_active_phone_search_idx')")).rows;
    await db.exec("drop index if exists public.leads_active_search_idx; drop index if exists public.leads_active_phone_search_idx");
    await db.exec("set session_replication_role = replica");
    await db.query(`
      insert into public.leads(id,name,phone,normalized_phone,email,normalized_email,country,course,source,stage_id,
        assignee_id,created_by,created_at,modified_at,next_followup_at)
      select md5('benchmark-' || n)::uuid,'Benchmark lead ' || n,'9' || lpad(n::text,9,'0'),'9' || lpad(n::text,9,'0'),
        'lead' || n || '@example.test','lead' || n || '@example.test',
        (array['India','Canada','United Kingdom','Australia'])[1+n%4],
        'Course ' || n%20,(array['Facebook','Website','DMHCA-Chatbot','Website-IBMP'])[1+n%4],
        (array(select id from public.lead_stages where is_active order by sort_order))[1+n%(select count(*)::integer from public.lead_stages where is_active)],
        case when n%3=0 then $2::uuid else $1::uuid end,$1,'2026-01-01'::timestamptz+n*interval '1 minute','2026-01-01'::timestamptz+n*interval '1 minute',
        case when n%3=0 then '2027-01-01'::timestamptz+n*interval '1 minute' end
      from generate_series(1,$3::integer) n
    `, [owner, counselor, leadCount]);
    await db.exec("set session_replication_role = origin");
    for (const index of searchIndexes) await db.exec(index.indexdef);
    await db.exec("analyze public.leads");
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, session_id: session })]);
    const filter = { criteria: [], matchMode: "all", query: "", quickView: "All accessible leads" };
    const results = [];
    async function measure(name, run, check, budgetMs) {
      const start = performance.now();
      const result = await run();
      const milliseconds = performance.now() - start;
      check(result);
      results.push({ operation: name, milliseconds: Math.round(milliseconds), budgetMs });
    }
    const page = async (value = filter, cursor = {}) => (await db.query(
      "select public.crm_lead_page($1,'UTC',50,$2,$3,false,'','','newest',0,$4) as result",
      [JSON.stringify(value), cursor.createdAt ?? null, cursor.id ?? null, JSON.stringify(cursor)],
    )).rows[0].result;
    let first;
    await measure("First 50 leads", async () => { first = await page(); return first; }, value => {
      assert.equal(value.ids.length, 50); assert.equal(value.hasMore, true);
    }, 1000);
    await measure("Next cursor page", () => page(filter, first.nextCursor), value => {
      assert.equal(value.ids.length, 50); assert.ok(value.ids.every(id => !first.ids.includes(id)));
    }, 1000);
    await measure("Source filter (bounded page)", () => page({ ...filter, criteria: [{ id: "source", field: "source", operator: "is", value: "Website" }] }),
      value => assert.equal(value.ids.length, 50), 1000);
    await measure("Exact phone filter", () => page({ ...filter, criteria: [{ id: "phone", field: "phone", operator: "is", value: "9000100000" }] }),
      value => assert.equal(value.ids.length, 1), 1000);
    await measure("Text search", () => page({ ...filter, query: "Benchmark lead 199999" }),
      value => assert.equal(value.ids.length, 1), 2000);
    await measure("Broad search (bounded page)", () => page({ ...filter, query: "Benchmark" }),
      value => { assert.equal(value.ids.length, 50); assert.equal(value.hasMore, true); }, 2000);
    await measure("No-match search", () => page({ ...filter, query: "NoSuchBenchmarkLead" }),
      value => assert.equal(value.ids.length, 0), 2000);
    await measure("Direct lead lookup", () => db.query("select id,name,course from public.leads where id=$1", [first.ids[0]]),
      value => assert.equal(value.rows.length, 1), 250);
    await measure("Duplicate lookup", () => db.query("select * from public.lead_duplicate_owners($1)", [first.ids[0]]),
      value => assert.equal(value.rows.length, 0), 500);
    await measure("Dashboard summary", () => db.query("select public.crm_dashboard_summary() as result"),
      value => assert.equal(value.rows[0].result.total, leadCount), 2000);
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: counselor, session_id: counselorSession })]);
    await measure("Counselor's 50 leads", () => page(), value => assert.equal(value.ids.length, 50), 1000);
    await measure("Counselor's search", () => page({ ...filter, query: "Benchmark lead 199998" }),
      value => assert.equal(value.ids.length, 1), 2000);
    assert.equal((await page({ ...filter, query: "Benchmark lead 199999" })).ids.length, 0, "Other owners' leads must remain hidden");
    await measure("Counselor's dashboard", () => db.query("select public.crm_dashboard_summary() as result"),
      value => assert.equal(value.rows[0].result.total, Math.floor(leadCount / 3)), 2000);
    await db.exec("reset role");
    const plan = await db.query(`explain (format json) select id from public.leads where not is_archived and
      public.crm_lead_search_text(name,phone,email,country_code,country,course,qualification,category,source,
        id,assignee_id,stage_id,closure_fee,expected_closure_date,billing_address,custom_fields,
        created_at,modified_at,next_followup_at,last_visit_at) like '%199999%'`);
    assert.match(JSON.stringify(plan.rows), /leads_active_search_idx/, "Selective search must use its GIN index in the matcher owner's context");
    console.table(results);
    const slow = results.filter(result => result.milliseconds > result.budgetMs);
    assert.equal(slow.length, 0, `Local database performance budgets exceeded: ${slow.map(result => result.operation).join(", ")}`);
    console.log(`PASS: ${leadCount.toLocaleString("en-US")} leads; bounded pages, correct filters, direct opening and dashboard totals.`);
  } finally { await db.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
