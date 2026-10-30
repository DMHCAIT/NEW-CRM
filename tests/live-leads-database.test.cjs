const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const ts = require("typescript");
const filterExports = {};
new Function("exports",ts.transpileModule(readFileSync(join(__dirname,"..","src","lib","lead-filters.ts"),"utf8"),{ compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText)(filterExports);

let db;
const owner = "11000000-0000-4000-8000-000000000001";
const outsider = "11000000-0000-4000-8000-000000000002";
const admin = "11000000-0000-4000-8000-000000000003";
const sessions = {
  [owner]: "21000000-0000-4000-8000-000000000001",
  [outsider]: "21000000-0000-4000-8000-000000000002",
  [admin]: "21000000-0000-4000-8000-000000000003",
};
const source = "31000000-0000-4000-8000-000000000001";
const target = "31000000-0000-4000-8000-000000000002";
const hidden = "31000000-0000-4000-8000-000000000003";

before(async () => {
  db = new PGlite();
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
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(directory, file), "utf8").replace(/^create extension if not exists pgcrypto;\s*/im, ""));
  }
  for (const [id, role] of [[owner, "team_lead"], [outsider, "counselor"], [admin, "admin"]]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${role}@example.test`]);
    await db.query("insert into public.profiles(id,full_name,email,role) values($1,$2,$3,$4)", [id, role, `${role}@example.test`, role]);
    await db.query("insert into public.login_sessions(session_id,user_id,email) values($1,$2,$3)", [sessions[id], id, `${role}@example.test`]);
  }
  await db.query("insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id) values($1,'Source','1111111111','1111111111',$4,$4),($2,'Target','2222222222','2222222222',$4,$4),($3,'Hidden','9999999999','9999999999',$5,$5)", [source, target, hidden, owner, outsider]);
  await db.query("update public.leads set email='duplicate@example.test', normalized_email='duplicate@example.test' where id in ($1,$2)", [source,target]);
  await db.query("insert into public.user_permission_overrides(user_id,permission_key,allowed) values($1,'leads.import',true)", [owner]);
});
after(async () => { if (db) await db.close(); });
async function asUser(id, callback, verified = true) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: id, session_id: verified ? sessions[id] : "21000000-0000-4000-8000-000000000099" })]);
    return callback(tx);
  });
}

test("database writes combine country codes and preserve explicit international phone numbers", async () => {
  for (const [phone, code, expected] of [
    ["9123456789", "India (+91)", "+919123456789"],
    ["98765 43210", "India (+91)", "+919876543210"],
    ["919876543210", "India (+91)", "+919876543210"],
    ["+63 4567893834", "India (+91)", "+634567893834"],
    ["+44 (20) 1234-5678", null, "+442012345678"],
    ["5551234567", "United States (+1)", "+15551234567"],
    ["9876543210", null, "9876543210"],
  ]) {
    await db.transaction(async tx => {
      await tx.exec("savepoint phone_case");
      const { rows: [row] } = await tx.query(
        `insert into public.leads(name, phone, country_code, normalized_phone, created_by)
         values('Combined phone test', $1, $2, 'stale', $3) returning id, phone, normalized_phone`,
        [phone, code, owner]);
      assert.equal(row.phone, expected);
      assert.equal(row.normalized_phone, expected.replace(/\D/g, ""));
      await tx.query("update public.leads set phone=$1 where id=$2", [expected, row.id]);
      const { rows: [updated] } = await tx.query("select phone,normalized_phone from public.leads where id=$1", [row.id]);
      assert.equal(updated.phone, expected);
      assert.equal(updated.normalized_phone, expected.replace(/\D/g, ""));
      await tx.exec("rollback to savepoint phone_case");
    });
  }
});

test("phone migration backfills legacy leads without changing edit or follow-up metadata and repairs saved columns", async () => {
  await db.transaction(async tx => {
    await tx.exec("savepoint phone_migration");
    await tx.exec("drop trigger a_combine_lead_phone on public.leads");
    const { rows: [legacy] } = await tx.query(
      `insert into public.leads(name,phone,country_code,normalized_phone,created_by,next_followup_at)
       values('Legacy phone','9123456789','India (+91)','9123456789',$1,'2020-01-01')
       returning *`, [owner]);
    const { rows: [report] } = await tx.query(
      `insert into public.saved_reports(user_id,name,filter_json,columns_json)
       values($1,'Legacy columns','{}','["name","countryCode","phone","email"]') returning id`, [owner]);
    const migration = readFileSync(join(__dirname, "..", "supabase", "migrations", "202610300002_combined_lead_phone.sql"), "utf8")
      .replace(/^\s*begin;\s*/i, "").replace(/\s*commit;\s*$/i, "")
      .replaceAll("create function public.", "create or replace function public.");
    await tx.exec(migration);
    const { rows: [updated] } = await tx.query("select * from public.leads where id=$1", [legacy.id]);
    assert.equal(updated.phone, "+919123456789");
    assert.equal(updated.normalized_phone, "919123456789");
    for (const key of ["phone", "normalized_phone"]) { delete legacy[key]; delete updated[key]; }
    assert.deepEqual(updated, legacy);
    const { rows: [saved] } = await tx.query("select columns_json from public.saved_reports where id=$1", [report.id]);
    assert.deepEqual(saved.columns_json, ["name", "phone", "email"]);
    await tx.exec("rollback to savepoint phone_migration");
  });
});

const queryFilter = criteria => ({ id: "", name: "", criteria, matchMode: "all", query: "", quickView: "All accessible leads" });
async function leadPage(actor, filter = queryFilter([]), options = {}) {
  return asUser(actor, async tx => (await tx.query(`select public.crm_lead_page(
    $1::jsonb,$2,$3,$4::timestamptz,$5::uuid,$6,$7,$8,$9,$10,$11::jsonb) result`, [
    JSON.stringify(filter), options.timezone ?? "UTC", options.size ?? 50, options.cursor?.createdAt ?? null, options.cursor?.id ?? null,
    options.countOnly ?? false, options.owner ?? "", options.stage ?? "", options.sort ?? "newest", options.offset ?? 0,JSON.stringify(options.cursor ?? {}),
  ])).rows[0].result, options.verified ?? true);
}

test("database lead filters match existing text, choice, date and untouched semantics", async () => {
  const stage = (await db.query("select id,name from public.lead_stages order by sort_order limit 1")).rows[0];
  const raw = [];
  for (let index = 0; index < 8; index++) {
    const record = `41000000-0000-4000-8000-${String(index + 1).padStart(12,"0")}`;
    const values = {
      id: record, name: index % 2 ? " Beta O'Brien_% " : "Alpha",
      phone: index % 2 ? "+91 (987) 654-3210" : "123 456 7890",
      country: index % 2 ? " India " : "", course: index % 2 ? "Medicine" : "Nursing",
      source: index % 2 ? "Website" : "manual", stage: stage.name, stageId: stage.id,
      assignee: "team_lead", assigneeId: owner, modifiedBy: "",
      email: index % 2 ? "ALPHA@example.test" : "", countryCode: "", category: "", qualification: "",
      createdAt: `2026-10-${String(index+1).padStart(2,"0")}T23:30:00.000Z`,
      modifiedAt: `2026-10-${String(index+1).padStart(2,"0")}T23:30:00.000Z`,
      followUpAt: index % 2 ? "2026-10-15T23:30:00.000Z" : undefined,
      lastVisitAt: index % 2 ? "2026-10-12T23:30:00.000Z" : undefined,
      hasBeenEdited: index % 3 === 0, editedAt: index === 6 ? null : index === 3 ? [] : index % 3 === 0 ? ["2026-10-10T23:30:00.000Z"] : [],
    };
    raw.push(values);
    await db.query(`insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id,country,course,source,stage_id,
      email,created_at,modified_at,next_followup_at,last_visit_at,has_been_edited,edited_at)
      values($1,$2,$3,$3,$4,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14)`,
    [record,values.name,values.phone,owner,values.country,values.course,values.source,stage.id,
      values.email,values.createdAt,values.followUpAt ?? null,values.lastVisitAt ?? null,values.hasBeenEdited,values.editedAt]);
  }
  const fixtures = [
    ...["is","is_not","contains","not_contains","begins_with","ends_with","is_empty","is_not_empty"].map(operator => ({ field: "name",operator,value: operator === "ends_with" ? "a" : "alpha" })),
    { field: "name",operator: "contains",value: "O'Brien_%" },
    { field: "name",operator: "contains",value: "'; select pg_sleep(10); --" },
    ...["is","is_not","in","not_in","is_empty","is_not_empty"].map(operator => ({ field: "country",operator,value: "India\nCanada" })),
    { field: "phone",operator: "contains",value: "987-654" },
    ...["is","is_not","before","after","on_or_before","on_or_after","between","not_between","is_empty","is_not_empty"].map(operator => ({ field: "createdAt",operator,value: "2026-10-04",secondValue: "2026-10-06" })),
    ...["is","is_not","is_empty","is_not_empty"].map(operator => ({ field: "lastVisitAt",operator,value: "2026-10-12" })),
    ...["is_true","is_false","before","after","is","between","custom_date"].map(operator => ({ field: "untouched",operator,value: "2026-10-10",secondValue: operator === "between" ? "2026-10-12" : undefined })),
  ];
  for (const fixture of fixtures) {
    const criterion = { id: "test",...fixture };
    const filter = queryFilter([criterion]);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const actual = (await leadPage(owner,filter,{ timezone })).ids.filter(id => raw.some(row => row.id === id)).sort();
    const expected = filterExports.filterLeads(raw,filter,new Date(),{ currentUserId: owner }).map(row => row.id).sort();
    assert.deepEqual(actual,expected,`${fixture.field} ${fixture.operator}`);
  }
});

test("cursor pages have stable tie-breaking, bounded size and no duplicates after a new lead arrives", async () => {
  const ids = [];
  for (let index = 0; index < 61; index++) {
    const record = `42000000-0000-4000-8000-${String(index + 1).padStart(12,"0")}`;
    ids.push(record);
    await db.query(`insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id,created_at)
      values($1,'Cursor fixture','4567890123','4567890123',$2,$2,'2026-10-20T12:00:00Z')`,[record,owner]);
  }
  const filter = queryFilter([{ id: "name",field: "name",operator: "is",value: "Cursor fixture" }]);
  const first = await leadPage(owner,filter);
  assert.equal(first.ids.length,50);
  assert.equal(first.hasMore,true);
  await db.query(`insert into public.leads(name,phone,normalized_phone,created_by,assignee_id,created_at)
    values('Cursor fixture','4567890123','4567890123',$1,$1,'2026-10-21T12:00:00Z')`,[owner]);
  const second = await leadPage(owner,filter,{ cursor: first.nextCursor });
  assert.equal(second.ids.length,11);
  assert.equal(second.hasMore,false);
  assert.deepEqual([...first.ids,...second.ids].sort(),ids.sort());
  assert.equal((await leadPage(owner,filter,{ countOnly: true })).total,62);
  for (const sort of ["name","followUp"]) {
    const one = await leadPage(owner,filter,{ sort });
    const two = await leadPage(owner,filter,{ sort,cursor: one.nextCursor });
    assert.equal(one.ids.length,50);
    assert.equal(two.ids.length,12);
    assert.equal(new Set([...one.ids,...two.ids]).size,62,sort);
  }
  assert.equal((await leadPage(outsider,filter,{ countOnly: true })).total,0);
  await assert.rejects(leadPage(owner,filter,{ verified: false }),/Lead access required/);
  await assert.rejects(leadPage(owner,queryFilter([{ id: "",field: "name;drop table leads",operator: "is",value: "" } ])),/Invalid filter field/);
});

test("name and follow-up cursors traverse ties and null dates without skipping or repeating leads", async () => {
  for (let index = 0; index < 25; index++) {
    const record = `43000000-0000-4000-8000-${String(index+1).padStart(12,"0")}`;
    await db.query(`insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id,source,next_followup_at)
      values($1,$2,'4567890123','4567890123',$3,$3,'Cursor sort fixture',$4)`,[
      record,`Name ${index % 4}`,owner,index % 3 === 0 ? null : `2099-12-0${index % 2+1}T12:00:00Z`,
    ]);
  }
  const filter = queryFilter([{ id: "",field: "source",operator: "is",value: "Cursor sort fixture" }]);
  for (const sort of ["name","followUp"]) {
    const expected = (await db.query(`select id from public.leads where source='Cursor sort fixture' order by
      ${sort === "name" ? "name,id" : "next_followup_at nulls last,name,id"}`)).rows.map(row => row.id);
    const ids = [];
    let cursor = null;
    do {
      const page = await leadPage(owner,filter,{ sort,cursor,size: 7 });
      ids.push(...page.ids);
      cursor = page.nextCursor;
      assert.ok(ids.length <= 25,"cursor must make forward progress");
    } while (cursor);
    assert.deepEqual(ids,expected,sort);
  }
});

test("dashboard summaries equal SQL totals and never include leads outside the reporting scope", async () => {
  await assert.rejects(asUser(owner,tx => tx.query("select public.crm_dashboard_summary()"),false),/Dashboard access required/);
  for (const actor of [owner,outsider,admin]) {
    const summary = await asUser(actor,async tx => (await tx.query("select public.crm_dashboard_summary() result")).rows[0].result);
    const expected = await asUser(actor,async tx => (await tx.query(`select count(*)::int total from public.leads
      where not is_archived and (public.is_crm_admin() or assignee_id = any(public.crm_dashboard_scope_ids()))`)).rows[0].total);
    assert.equal(summary.total,expected);
    assert.equal(summary.stages.reduce((sum,stage) => sum+stage.total,0),expected);
    assert.ok(summary.country.length <= 30);
    assert.ok(summary.course.length <= 30);
    assert.ok(summary.combinations.length <= 30);
    assert.ok(summary.countryLeaders.length <= 8);
  }
});

test("large lead volumes keep cursor results bounded and use the composite index", async () => {
  const volume = Number(process.env.CRM_SCALE_LEADS || 100000);
  assert.ok(Number.isSafeInteger(volume) && volume >= 100000 && volume <= 1000000);
  // Synthetic rows only, inside this disposable PGlite database; avoid per-row audit fixture overhead.
  await db.exec("set session_replication_role = replica");
  try {
    await db.query(`insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id,created_at)
      select md5('scale-'||g)::uuid,'Scale fixture','5678901234','5678901234',$1,$1,
        '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second' from generate_series(1,$2) g`,[owner,volume]);
  } finally { await db.exec("set session_replication_role = origin"); }
  await db.exec("analyze public.leads");
  const start = performance.now();
  const page = await leadPage(owner);
  const elapsed = performance.now()-start;
  assert.equal(page.ids.length,50);
  assert.equal(page.hasMore,true);
  const next = await leadPage(owner,queryFilter([]),{ cursor: page.nextCursor });
  assert.equal(next.ids.length,50);
  assert.equal(new Set([...page.ids,...next.ids]).size,100);
  assert.ok(JSON.stringify(page).length < 5000,"page payload must remain below 5 KB for IDs and cursor");
  console.log(`Scale check: ${volume} synthetic leads; 50 returned; ${elapsed.toFixed(1)} ms local PGlite RPC; ID payload ${JSON.stringify(page).length} bytes.`);
  const plan = await asUser(owner,tx => tx.query(`explain (format json) select l.id,l.created_at from public.leads l
    left join public.lead_stages s on s.id=l.stage_id left join public.profiles a on a.id=l.assignee_id
    left join public.profiles m on m.id=l.modified_by where not l.is_archived
    and (l.created_at,l.id) < ('2026-01-02T00:00:00Z','ffffffff-ffff-ffff-ffff-ffffffffffff')
    order by l.created_at desc,l.id desc limit 51`));
  assert.match(JSON.stringify(plan.rows),/leads_(?:active_owner_)?created_id_idx/);
});

test("call scheduling locks until a real lead or call change and records actor, values and time", async () => {
  const record = "31000000-0000-4000-8000-000000000099";
  await db.query("insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id) values($1,'Workflow lead','5555555555','5555555555',$2,$2)", [record,owner]);
  const schedule = () => asUser(owner, tx => tx.query("insert into public.scheduled_calls(lead_id,user_id,scheduled_at) values($1,$2,'2099-12-01T10:00:00Z') returning id", [record,owner]));
  const first = (await schedule()).rows[0].id;
  await assert.rejects(schedule(), /before scheduling another/);
  await asUser(owner, tx => tx.query("update public.leads set name=name where id=$1", [record]));
  await assert.rejects(schedule(), /before scheduling another/);
  await assert.rejects(asUser(owner, tx => tx.query("update public.leads set call_schedule_revision=100 where id=$1", [record])), /managed by the CRM/);
  await assert.rejects(asUser(owner, tx => tx.query("update public.scheduled_calls set schedule_revision=-1 where id=$1", [first])), /managed by the CRM/);
  await asUser(owner, tx => tx.query("update public.leads set course='New course', modified_by=$2 where id=$1", [record,owner]));
  const second = (await schedule()).rows[0].id;
  await assert.rejects(schedule(), /before scheduling another/);
  await asUser(owner, tx => tx.query("select public.update_lead_scheduled_call($1,$2,'scheduled','2099-12-02T10:00:00Z')", [record,second]));
  const third = (await schedule()).rows[0].id;
  await asUser(owner, tx => tx.query("select public.update_lead_scheduled_call($1,$2,'completed',null)", [record,third]));
  const fourth = (await schedule()).rows[0].id;
  await asUser(owner, tx => tx.query("select public.update_lead_scheduled_call($1,$2,'cancelled',null)", [record,fourth]));
  await schedule();
  await assert.rejects(schedule(), /before scheduling another/);
  await assert.rejects(asUser(owner, tx => tx.query("select public.update_lead_scheduled_call($1,$2,'completed',null)", [record,third])), /already closed/);
  await assert.rejects(asUser(outsider, tx => tx.query("select public.update_lead_scheduled_call($1,$2,'cancelled',null)", [record,first])), /accessible scope/);
  const log = (await db.query("select user_id,created_at,description,meta from public.activities where lead_id=$1 order by created_at", [record])).rows;
  const change = log.find(row => row.meta.changes?.course);
  assert.equal(change.user_id,owner);
  assert.equal(change.meta.actor_name,"team_lead");
  assert.deepEqual(change.meta.changes.course,{ before: null, after: "New course" });
  assert.ok(change.created_at);
  assert.ok(log.some(row => row.description === "Call rescheduled"));
  assert.ok(log.some(row => row.description === "Call marked completed"));
  assert.ok(log.some(row => row.description === "Call cancelled"));
});

test("real lead edits handle overdue follow-ups across dashboard data and lead filters without changing calls", async () => {
  const record = "31000000-0000-4000-8000-000000000098";
  const past = "2020-01-01T10:00:00.000Z";
  await db.query("insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id,next_followup_at) values($1,'Overdue lead','5656565656','5656565656',$2,$2,$3)", [record,owner,past]);
  await db.query("insert into public.scheduled_calls(lead_id,user_id,scheduled_at) values($1,$2,'2020-01-01T10:00:00Z')", [record,owner]);
  const followup = async () => (await db.query("select next_followup_at from public.leads where id=$1", [record])).rows[0].next_followup_at;
  await asUser(owner,tx => tx.query("update public.leads set name=name,modified_by=$2 where id=$1",[record,owner]));
  assert.ok(await followup(),"No-op save preserves overdue follow-up");
  await asUser(owner,tx => tx.query("insert into public.notes(lead_id,user_id,content) values($1,$2,'Note only')",[record,owner]));
  assert.ok(await followup(),"Notes do not count as lead field edits");
  await asUser(owner,tx => tx.query("update public.leads set course='Updated course' where id=$1",[record]));
  assert.equal(await followup(),null);
  const activity = (await db.query("select user_id,meta from public.activities where lead_id=$1 and meta->'changes' ? 'next_followup_at' order by created_at desc limit 1",[record])).rows[0];
  assert.equal(activity.user_id,owner);
  assert.equal(new Date(activity.meta.changes.next_followup_at.before).toISOString(),past);
  assert.equal(activity.meta.changes.next_followup_at.after,null);
  assert.deepEqual(activity.meta.changes.course,{before:null,after:"Updated course"});
  assert.equal((await db.query("select status from public.scheduled_calls where lead_id=$1",[record])).rows[0].status,"scheduled");
  assert.equal((await db.query("select id from public.leads where id=$1 and next_followup_at::date <= (now() at time zone 'UTC')::date",[record])).rows.length,0);
  const filter = { criteria:[{id:"overdue",field:"followUpAt",operator:"overdue",value:""}],matchMode:"all",query:"",quickView:"All accessible leads" };
  assert.equal(filterExports.filterLeads([{id:record,followUpAt:null}],filter).length,0);
  await asUser(owner,tx => tx.query("update public.leads set next_followup_at='2099-12-01T10:00:00Z' where id=$1",[record]));
  await asUser(owner,tx => tx.query("update public.leads set qualification='Graduate' where id=$1",[record]));
  assert.equal(new Date(await followup()).toISOString(),"2099-12-01T10:00:00.000Z");
  await asUser(owner,tx => tx.query("update public.leads set course='Changed again',next_followup_at='2020-02-01T10:00:00Z' where id=$1",[record]));
  assert.equal(new Date(await followup()).toISOString(),"2020-02-01T10:00:00.000Z","An explicitly chosen follow-up date must be preserved");
});

test("overdue repair clears only proven handled follow-ups and preserves legacy and deliberate dates", async () => {
  const records = ["31000000-0000-4000-8000-000000000091","31000000-0000-4000-8000-000000000092","31000000-0000-4000-8000-000000000093"];
  for (const [index,id] of records.entries()) {
    await db.query("insert into public.leads(id,name,phone,normalized_phone,assignee_id,created_by,next_followup_at) values($1,'Repair test',$2,$2,$3,$3,'2020-01-01T10:00:00Z')",[id,`616161616${index}`,owner]);
    const changes = index === 0 ? {course:{before:"Old",after:"New"}} : index === 1 ? {next_followup_at:{before:null,after:"2020-01-01T10:00:00Z"}} : undefined;
    await db.query("insert into public.activities(lead_id,user_id,type,description,meta) values($1,$2,'updated','Lead updated',$3)",[id,owner,JSON.stringify({changes})]);
  }
  const sql = readFileSync(join(__dirname,"..","supabase","migrations","202610230004_handle_overdue_followup_on_edit.sql"),"utf8");
  await db.exec(sql.slice(sql.indexOf("update public.leads l set"),sql.lastIndexOf("commit;")));
  const rows = (await db.query("select id,next_followup_at from public.leads where id=any($1::uuid[]) order by id",[records])).rows;
  assert.equal(rows[0].next_followup_at,null);
  assert.ok(rows[1].next_followup_at);
  assert.ok(rows[2].next_followup_at);
});

test("global duplicate checks block invisible matches without disclosing lead records", async () => {
  const rows = [{ normalized_phone: "9999999999", normalized_email: null }];
  await asUser(owner, async (tx) => {
    assert.equal((await tx.query("select id from public.leads where id = $1", [hidden])).rows.length, 0);
    assert.equal((await tx.query("select public.check_live_lead_duplicates($1) as decision", [JSON.stringify(rows)])).rows[0].decision, "block");
  });
  await assert.rejects(asUser(owner, (tx) => tx.query("insert into public.leads(name,phone,normalized_phone,created_by,assignee_id) values('Duplicate','9999999999','fake',$1,$1)", [owner])), /Duplicate lead blocked/);
  await assert.rejects(asUser(owner, (tx) => tx.query("select public.import_live_leads($1)", [JSON.stringify([
    { name: "Atomic first", phone: "8888888888", normalized_phone: "8888888888" },
    { name: "Hidden duplicate", phone: "9999999999", normalized_phone: "9999999999" },
  ])])), /Duplicate lead blocked/);
  assert.equal((await db.query("select id from public.leads where phone='8888888888'")).rows.length, 0);
  await assert.rejects(asUser(owner, (tx) => tx.query("select public.check_live_lead_duplicates($1)", [JSON.stringify(rows)]), false), /creation permission/);
});

test("global warn policy blocks lower roles, warns admins and allow reveals no duplicate signal", async () => {
  const input = JSON.stringify([{ normalized_phone: "9999999999" }]);
  await db.query("insert into public.crm_settings(setting_key,value) values('lead_configuration',$1) on conflict(setting_key) do update set value=excluded.value", [JSON.stringify({ duplicateFields: "phone", creationPolicy: "warn", fields: [] })]);
  assert.equal((await asUser(owner, (tx) => tx.query("select public.check_live_lead_duplicates($1) as decision", [input]))).rows[0].decision, "block");
  assert.equal((await asUser(admin, (tx) => tx.query("select public.check_live_lead_duplicates($1) as decision", [input]))).rows[0].decision, "warn");
  await db.query("update public.crm_settings set value=jsonb_set(value,'{creationPolicy}','\"allow\"') where setting_key='lead_configuration'");
  assert.equal((await asUser(owner, (tx) => tx.query("select public.check_live_lead_duplicates($1) as decision", [input]))).rows[0].decision, "clear");
});

test("merge denies unverified tokens, missing permissions, hidden leads, self merge and direct metadata tampering", async () => {
  await assert.rejects(asUser(owner, (tx) => tx.query("select public.merge_live_leads($1,$2)", [source, target]), false), /merge permission/);
  await db.query("insert into public.user_permission_overrides(user_id,permission_key,allowed) values($1,'leads.merge',false)", [outsider]);
  await assert.rejects(asUser(outsider, (tx) => tx.query("select public.merge_live_leads($1,$2)", [source, target])), /merge permission/);
  await db.query("delete from public.user_permission_overrides where user_id=$1 and permission_key='leads.merge'", [outsider]);
  await assert.rejects(asUser(owner, (tx) => tx.query("select public.merge_live_leads($1,$2)", [source, hidden])), /accessible scope/);
  await assert.rejects(asUser(owner, (tx) => tx.query("select public.merge_live_leads($1,$1)", [source])), /different leads/);
  await assert.rejects(asUser(owner, (tx) => tx.query("update public.leads set merged_into_id=$1,is_archived=true where id=$2", [target, source])), /authorized lead merge/);
  assert.equal((await db.query("select is_archived from public.leads where id=$1", [source])).rows[0].is_archived, false);
});

test("duplicate discovery exposes only assignees across buckets and rejects unrelated or out-of-bucket merges", async () => {
  const child = "11000000-0000-4000-8000-000000000004";
  const manager = "11000000-0000-4000-8000-000000000005";
  const superAdmin = "11000000-0000-4000-8000-000000000006";
  for (const [id, role, parent] of [[child,"counselor",owner],[manager,"manager",null],[superAdmin,"super_admin",null]]) {
    sessions[id] = `21000000-0000-4000-8000-00000000000${id.slice(-1)}`;
    await db.query("insert into auth.users(id,email) values($1,$2)", [id,`${id}@test.invalid`]);
    await db.query("insert into public.profiles(id,full_name,email,role,reporting_to) values($1,$2,$3,$4,$5)", [id,role,`${id}@test.invalid`,role,parent]);
    await db.query("insert into public.login_sessions(session_id,user_id,email) values($1,$2,$3)", [sessions[id],id,`${id}@test.invalid`]);
  }
  await db.query("update public.profiles set reporting_to=$1 where id=$2", [manager,owner]);
  const owned = [];
  for (const [index, assignee] of [child,child,outsider,outsider].entries()) {
    const id = `31000000-0000-4000-8000-00000000001${index}`;
    owned.push(id);
    await db.query("insert into public.leads(id,name,phone,normalized_phone,email,normalized_email,created_by,assignee_id) values($1,'PRIVATE LEAD','7777777777','7777777777','private@example.test','private@example.test',$2,$2)", [id,assignee]);
  }
  await db.query("update public.leads set email=null, normalized_email=null where id=$1", [owned[1]]);
  await asUser(child, async tx => {
    const rows = (await tx.query("select * from public.lead_duplicate_owners($1)", [owned[0]])).rows;
    assert.equal(rows.length,3);
    assert.ok(rows.every(row => Object.keys(row).sort().join(",") === "assignee,merge_target_id"));
    assert.equal(rows.filter(row => row.merge_target_id !== null).length,1);
    assert.ok(rows.some(row => row.assignee === "counselor" && row.merge_target_id === null));
    assert.equal((await tx.query("select id from public.leads where id=$1", [owned[2]])).rows.length,0);
  });
  await assert.rejects(asUser(child, tx => tx.query("select * from public.lead_duplicate_owners($1)", [owned[2]])), /accessible scope/);
  await assert.rejects(asUser(child, tx => tx.query("select * from public.lead_duplicate_owners($1)", [owned[0]]),false), /view permission/);
  await assert.rejects(asUser(owner, tx => tx.query("select public.merge_live_leads($1,$2)", [source,owned[0]])), /matching phone number or email/);
  await assert.rejects(asUser(owner, tx => tx.query("select public.merge_live_leads($1,$2)", [owned[0],owned[2]])), /merge bucket/);
  await db.query("insert into public.user_permission_overrides(user_id,permission_key,allowed) values($1,'users.view',true)", [owner]);
  await assert.rejects(asUser(owner, tx => tx.query("select public.merge_live_leads($1,$2)", [owned[0],owned[2]])), /merge bucket/);
  await db.query("delete from public.user_permission_overrides where user_id=$1 and permission_key='users.view'", [owner]);
  for (const [userId, from, to] of [[child,owned[0],owned[1]],[owner,owned[0],owned[1]],[manager,owned[0],owned[1]],[admin,owned[0],owned[2]],[superAdmin,owned[0],owned[2]]]) {
    const rollback = new Error("rollback successful merge");
    await assert.rejects(asUser(userId, async tx => {
      const result = (await tx.query("select public.merge_live_leads($1,$2) as result", [from,to])).rows[0].result;
      assert.equal(result.id,to);
      throw rollback;
    }), error => error === rollback);
  }
  await db.query("update public.leads set is_archived=true where id=$1", [owned[3]]);
  assert.equal((await asUser(child, tx => tx.query("select * from public.lead_duplicate_owners($1)", [owned[0]]))).rows.length,2);
});

test("transactional merge moves every lead_id FK and preserves parent-linked records and lead snapshots", async () => {
  await db.query("insert into public.notes(lead_id,user_id,content) values($1,$2,'Original note')", [source, owner]);
  await db.query("insert into public.emails(lead_id,user_id,subject,body,to_email) values($1,$2,'Subject','Body','student@example.test')", [source, owner]);
  const call = (await db.query("insert into public.calls(lead_id,user_id,direction) values($1,$2,'outbound') returning id", [source, owner])).rows[0].id;
  await db.query("insert into public.scheduled_calls(lead_id,user_id,scheduled_at) values($1,$2,now())", [source, owner]);
  await db.query("update public.scheduled_calls set schedule_revision=40 where lead_id=$1", [source]);
  const meeting = (await db.query("insert into public.meetings(lead_id,host_id,title,start_at,duration_min) values($1,$2,'Original meeting',now(),30) returning id", [source, owner])).rows[0].id;
  const invoice = (await db.query("insert into public.invoices(lead_id,created_by,invoice_no,subtotal,total) values($1,$2,'MERGE-TEST',100,100) returning id", [source, owner])).rows[0].id;
  await db.query("insert into public.chat_sessions(lead_id,channel) values($1,'website')", [source]);
  await db.query("insert into public.gmail_messages(user_id,gmail_message_id,lead_id,subject) values($1,'merge-test-message',$2,'Original inbox message')", [owner,source]);
  await db.query("insert into public.assignment_log(lead_id,assigned_to,reason) values($1,$2,'Initial assignment')", [source, owner]);
  await db.query("insert into public.meeting_attendees(meeting_id,lead_email) values($1,'student@example.test')", [meeting]);
  await db.query("insert into public.invoice_items(invoice_id,description,quantity,unit_price,amount) values($1,'Course',1,100,100)", [invoice]);
  await db.query("insert into public.ivr_events(call_id,provider_event,payload) values($1,'completed','{}')", [call]);
  await db.exec(`alter table public.notes add constraint test_merge_rollback check (lead_id <> '${target}'::uuid)`);
  await assert.rejects(asUser(owner, (tx) => tx.query("select public.merge_live_leads($1,$2)", [source,target])), /test_merge_rollback/);
  assert.equal((await db.query("select lead_id from public.invoices where id=$1", [invoice])).rows[0].lead_id, source);
  assert.equal((await db.query("select is_archived from public.leads where id=$1", [source])).rows[0].is_archived, false);
  assert.equal((await db.query("select id from public.merge_logs where merged_lead_id=$1", [source])).rows.length, 0);
  await db.exec("alter table public.notes drop constraint test_merge_rollback");
  const result = (await asUser(owner, (tx) => tx.query("select public.merge_live_leads($1,$2) as result", [source, target]))).rows[0].result;
  assert.equal(result.id, target);
  assert.equal(result.movedRecords.notes, 1);
  for (const table of ["notes", "emails", "calls", "scheduled_calls", "meetings", "invoices", "chat_sessions", "assignment_log", "gmail_messages"]) {
    assert.equal((await db.query(`select id from public.${table} where lead_id=$1`, [source])).rows.length, 0);
    assert.equal((await db.query(`select id from public.${table} where lead_id=$1`, [target])).rows.length, 1);
  }
  assert.equal((await db.query("select lead_id from public.calls where id=$1", [call])).rows[0].lead_id, target);
  assert.equal((await db.query("select lead_id from public.meetings where id=$1", [meeting])).rows[0].lead_id, target);
  assert.equal((await db.query("select lead_id from public.invoices where id=$1", [invoice])).rows[0].lead_id, target);
  assert.equal((await db.query("select meeting_id from public.meeting_attendees where meeting_id=$1", [meeting])).rows[0].meeting_id, meeting);
  assert.equal((await db.query("select invoice_id from public.invoice_items where invoice_id=$1", [invoice])).rows[0].invoice_id, invoice);
  assert.equal((await db.query("select call_id from public.ivr_events where call_id=$1", [call])).rows[0].call_id, call);
  const archived = (await db.query("select is_archived,merged_into_id from public.leads where id=$1", [source])).rows[0];
  assert.equal(archived.is_archived, true); assert.equal(archived.merged_into_id, target);
  assert.equal((await db.query("select name from public.leads where id=$1", [target])).rows[0].name, "Target");
  assert.ok((await db.query("select call_schedule_revision from public.leads where id=$1", [target])).rows[0].call_schedule_revision > 40);
  const log = (await db.query("select * from public.merge_logs where merged_lead_id=$1", [source])).rows[0];
  assert.equal(log.master_lead_id, target); assert.equal(log.user_id, owner);
  assert.equal(log.field_choices_json.source_snapshot.name, "Source");
  assert.equal((await db.query("select id from public.activities where lead_id=$1", [source])).rows.length, 0);
  assert.equal((await db.query("select id from public.activities where lead_id=$1 and type='merged'", [target])).rows.length, 1);
  await assert.rejects(asUser(owner, (tx) => tx.query("select public.merge_live_leads($1,$2)", [source, target])), /active.*scope/);
});
