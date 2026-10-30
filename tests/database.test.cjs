const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

let db;
const adminId = "10000000-0000-4000-8000-000000000001";
const counselorId = "10000000-0000-4000-8000-000000000002";
const superId = "10000000-0000-4000-8000-000000000003";
const adminSession = "20000000-0000-4000-8000-000000000001";
const counselorSession = "20000000-0000-4000-8000-000000000002";
const superSession = "20000000-0000-4000-8000-000000000003";
const unverifiedSession = "20000000-0000-4000-8000-000000000099";
const leadId = "30000000-0000-4000-8000-000000000001";

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email text);
    create function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb;
    $$;
    create function auth.uid() returns uuid language sql stable as $$
      select (auth.jwt()->>'sub')::uuid;
    $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
  `);
  const directory = join(__dirname, "..", "supabase", "migrations");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    // PGlite has PostgreSQL's built-in gen_random_uuid, but not Supabase's pgcrypto extension.
    const sql = readFileSync(join(directory, file), "utf8").replace(/^create extension if not exists pgcrypto;\s*/im, "");
    try { await db.exec(sql); }
    catch (error) { throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error }); }
  }
  await db.query("insert into auth.users(id,email) values ($1,'admin@example.com'),($2,'counselor@example.com'),($3,'super@example.com')", [adminId,counselorId,superId]);
  await db.query(`insert into public.profiles(id,full_name,email,role) values
    ($1,'Admin','admin@example.com','admin'),($2,'Counselor','counselor@example.com','counselor'),($3,'Super','super@example.com','super_admin')`, [adminId,counselorId,superId]);
  await db.query(`insert into public.login_sessions(session_id,user_id,email) values
    ($1,$2,'admin@example.com'),($3,$4,'counselor@example.com'),($5,$6,'super@example.com')`,
  [adminSession,adminId,counselorSession,counselorId,superSession,superId]);
  await db.query(`insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id)
    values($1,'Live lead','1234567890','1234567890',$2,$2)`, [leadId,counselorId]);
});

after(async () => { if (db) await db.close(); });

test("verified repeat login replaces only the same account and device, preserving history", async () => {
  const rollback = new Error("rollback device replacement test");
  await assert.rejects(db.transaction(async tx => {
    const original = "20000000-0000-4000-8000-000000000071";
    const replacement = "20000000-0000-4000-8000-000000000072";
    await tx.query(`insert into public.login_sessions(session_id,user_id,email,device,device_id)
      values($1,$2,'admin@example.com','Windows computer','device-a'),
      (gen_random_uuid(),$2,'admin@example.com','Windows computer','device-b'),
      (gen_random_uuid(),$3,'counselor@example.com','Windows computer','device-a')`,
    [original, adminId, counselorId]);
    await tx.query(`insert into public.login_challenges(id,user_id,code_hash,encrypted_session,device_id)
      values('device-challenge',$1,'correct','tokens','device-a')`, [adminId]);
    await tx.query("select * from public.consume_login_challenge('device-challenge','wrong')");
    assert.equal((await tx.query("select signed_out_at from public.login_sessions where session_id=$1", [original])).rows[0].signed_out_at, null);
    await tx.query(`insert into public.login_sessions(session_id,user_id,email,device,device_id)
      values($1,$2,'admin@example.com','Windows computer','device-a')`, [replacement, adminId]);
    const { rows } = await tx.query("select session_id,signed_out_at from public.login_sessions where device_id is not null");
    assert.equal(rows.length, 4);
    assert.ok(rows.find(row => row.session_id === original).signed_out_at);
    assert.equal(rows.filter(row => row.signed_out_at === null).length, 3);
    // A failed insert must roll back the preceding session replacement too.
    await tx.exec("savepoint failed_login");
    await assert.rejects(tx.query(`insert into public.login_sessions(session_id,user_id,email,device_id)
      values($1,$2,null,'device-a')`, [original, adminId]));
    await tx.exec("rollback to savepoint failed_login");
    assert.equal((await tx.query("select signed_out_at from public.login_sessions where session_id=$1", [replacement])).rows[0].signed_out_at, null);
    await tx.exec("set local role authenticated");
    for (const [session_id, allowed] of [[original, false], [replacement, true]]) {
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: adminId, session_id })]);
      assert.equal((await tx.query("select public.is_verified_session() as allowed")).rows[0].allowed, allowed);
    }
    throw rollback;
  }), error => error === rollback);
});

test("device-only login history drops sensitive columns and individual revocation denies access", async () => {
  const { rows } = await db.query("select table_name,column_name from information_schema.columns where table_schema='public' and table_name in ('login_sessions','login_challenges')");
  assert.equal(rows.some(row => ["ip_address", "location", "user_agent"].includes(row.column_name)), false);
  assert.equal(rows.filter(row => row.column_name === "device").length, 2);
  const rollback = new Error("rollback session revocation test");
  await assert.rejects(db.transaction(async tx => {
    await tx.query("update public.login_sessions set signed_out_at=now() where session_id=$1", [counselorSession]);
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: counselorId, session_id: counselorSession })]);
    assert.equal((await tx.query("select public.is_verified_session() as allowed")).rows[0].allowed, false);
    assert.equal((await tx.query("select * from public.leads")).rows.length, 0);
    throw rollback;
  }), error => error === rollback);
  assert.equal((await asUser(adminId, adminSession, tx => tx.query("select public.is_verified_session() as allowed"))).rows[0].allowed, true);
});

test("deleting an Auth account preserves CRM references and retires sessions atomically", async () => {
  const rollback = new Error("rollback deletion test");
  await assert.rejects(db.transaction(async (tx) => {
    const target = "10000000-0000-4000-8000-000000000088";
    await tx.query("insert into auth.users(id,email) values($1,'deleted@example.com')", [target]);
    await tx.query("insert into public.profiles(id,full_name,email) values($1,'Deleted user','deleted@example.com')", [target]);
    await tx.query("insert into public.login_sessions(session_id,user_id,email) values(gen_random_uuid(),$1,'deleted@example.com')", [target]);
    await tx.query("insert into public.leads(name,phone,normalized_phone,created_by,assignee_id) values('Retained lead','888','888',$1,$1)", [target]);
    await tx.query("insert into public.login_challenges(id,user_id,code_hash,encrypted_session) values('retired',$1,'hash','encrypted')", [target]);
    await tx.query("insert into public.password_setup_tokens(id,user_id) values('retired',$1)", [target]);
    await tx.query("insert into public.gmail_connections(user_id,email,encrypted_tokens) values($1,'deleted@example.com','encrypted')", [target]);
    await tx.query("delete from auth.users where id=$1", [target]);
    const retired = (await tx.query("select status,deleted_at from public.profiles where id=$1", [target])).rows[0];
    assert.equal(retired.status, "inactive");
    assert.ok(retired.deleted_at);
    assert.equal((await tx.query("select count(*)::int as n from public.leads where created_by=$1", [target])).rows[0].n, 1);
    assert.ok((await tx.query("select signed_out_at from public.login_sessions where user_id=$1", [target])).rows[0].signed_out_at);
    for (const table of ["login_challenges", "password_setup_tokens", "gmail_connections"]) {
      assert.equal((await tx.query(`select count(*)::int as n from public.${table} where user_id=$1`, [target])).rows[0].n, 0);
    }
    throw rollback;
  }), (error) => error === rollback);
});

async function asUser(userId, sessionId, callback) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, session_id: sessionId })]);
    return callback(tx);
  });
}

async function asService(callback) {
  return db.transaction(async tx => {
    await tx.exec("set local role service_role");
    return callback(tx);
  });
}

test("all migrations apply to PostgreSQL in filename order", async () => {
  const { rows } = await db.query("select to_regclass('public.login_sessions') as name");
  assert.equal(rows[0].name, "login_sessions");
});

test("password-only Supabase tokens cannot read or mutate CRM data", async () => {
  await asUser(counselorId, unverifiedSession, async (tx) => {
    assert.equal((await tx.query("select public.is_verified_session() as allowed")).rows[0].allowed, false);
    assert.equal((await tx.query("select * from public.leads")).rows.length, 0);
    assert.equal((await tx.query("select * from public.profiles")).rows.length, 0);
    assert.equal((await tx.query("select * from public.lead_stages")).rows.length, 0);
    assert.equal((await tx.query("select public.has_permission('leads.create') as allowed")).rows[0].allowed, false);
  });
  await assert.rejects(asUser(counselorId, unverifiedSession, (tx) => tx.query(
    "insert into public.leads(name,phone,normalized_phone,created_by,assignee_id) values('Bypass','1','1',$1,$1)", [counselorId],
  )), /row-level security|Assignee must be an active accessible user/);
});

test("verified sessions retain hierarchy scoping and last-used tracking", async () => {
  await db.query("update public.login_sessions set last_seen_at = now() - interval '5 minutes' where session_id = $1", [counselorSession]);
  await asUser(counselorId, counselorSession, async (tx) => {
    assert.equal((await tx.query("select * from public.leads")).rows.length, 1);
    assert.equal((await tx.query("select public.touch_login_session() as touched")).rows[0].touched, true);
    assert.equal((await tx.query("select * from public.login_sessions")).rows.length, 0);
  });
  assert.equal((await db.query("select last_seen_at > now() - interval '1 minute' as recent from public.login_sessions where session_id = $1", [counselorSession])).rows[0].recent, true);
});

test("admin login history is unavailable to counselors and password-only admins", async () => {
  assert.equal((await asUser(adminId, adminSession, (tx) => tx.query("select * from public.login_sessions"))).rows.length, 3);
  assert.equal((await asUser(adminId, unverifiedSession, (tx) => tx.query("select * from public.login_sessions"))).rows.length, 0);
  await assert.rejects(asUser(adminId, adminSession, (tx) => tx.query(
    "insert into public.login_sessions(session_id,user_id,email) values(gen_random_uuid(),$1,'forged@example.com')", [adminId],
  )), /permission denied/);
});

test("only service role can create or consume pending authentication records", async () => {
  for (const sql of ["select * from public.login_challenges", "select public.allow_login_attempt('key',5)", "select * from public.consume_login_challenge('id','hash')", "select public.consume_password_setup('hash')"]) {
    await assert.rejects(asUser(counselorId, counselorSession, (tx) => tx.query(sql)), /permission denied/);
  }
});

test("verification rejects expired codes, limits guesses and consumes successful codes once", async () => {
  await db.query(`insert into public.login_challenges(id,user_id,code_hash,encrypted_session)
    values('guesses',$1,'correct','encrypted'),('success',$1,'correct','encrypted')`, [counselorId]);
  for (let i = 0; i < 5; i++) assert.equal((await db.query("select * from public.consume_login_challenge('guesses','wrong')")).rows.length, 0);
  assert.equal((await db.query("select * from public.consume_login_challenge('guesses','correct')")).rows.length, 0);
  assert.equal((await db.query("select * from public.consume_login_challenge('success','correct')")).rows.length, 1);
  assert.equal((await db.query("select * from public.consume_login_challenge('success','correct')")).rows.length, 0);
  await db.query("insert into public.login_challenges(id,user_id,code_hash,encrypted_session,expires_at) values('expired',$1,'correct','encrypted',now()-interval '1 second')", [counselorId]);
  assert.equal((await db.query("select * from public.consume_login_challenge('expired','correct')")).rows.length, 0);
});

test("password setup links are single-use, expire and invalidate other outstanding links", async () => {
  await db.query("insert into public.password_setup_tokens(id,user_id) values('first',$1),('second',$1)", [counselorId]);
  assert.equal((await db.query("select public.consume_password_setup('first') as id")).rows[0].id, counselorId);
  assert.equal((await db.query("select public.consume_password_setup('first') as id")).rows[0].id, null);
  assert.equal((await db.query("select public.consume_password_setup('second') as id")).rows[0].id, null);
  await db.query("insert into public.password_setup_tokens(id,user_id,expires_at) values('expired',$1,now()-interval '1 second')", [counselorId]);
  assert.equal((await db.query("select public.consume_password_setup('expired') as id")).rows[0].id, null);
});

test("login throttling is persistent and resets after its fixed window", async () => {
  for (let i = 0; i < 3; i++) assert.equal((await db.query("select public.allow_login_attempt('rate',3) as allowed")).rows[0].allowed, true);
  assert.equal((await db.query("select public.allow_login_attempt('rate',3) as allowed")).rows[0].allowed, false);
  await db.query("update public.login_rate_limits set started_at = now()-interval '16 minutes' where key='rate'");
  assert.equal((await db.query("select public.allow_login_attempt('rate',3) as allowed")).rows[0].allowed, true);
});

test("un-discounted invoices issue immediately while discounts require approver authorization", async () => {
  const invoice = await asUser(counselorId, counselorSession, (tx) => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({ lead_id: leadId, quantity: 2, unit_price: 100, tax_amount: 18, discount_amount: 0, description: "Admission fee", due_date: "2026-12-31" })],
  ));
  const id = invoice.rows[0].id;
  assert.equal((await db.query("select total from public.invoices where id=$1", [id])).rows[0].total, "218.00");
  assert.equal((await db.query("select status from public.invoices where id=$1", [id])).rows[0].status, "sent");
  assert.equal((await db.query("select * from public.invoice_items where invoice_id=$1", [id])).rows.length, 1);
  assert.equal((await db.query("select * from public.invoice_approvals where invoice_id=$1", [id])).rows.length, 0);

  const discounted = await asUser(counselorId, counselorSession, (tx) => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({ lead_id: leadId, quantity: 2, unit_price: 100, tax_amount: 18, discount_percent: 10, discount_reason: "Scholarship", description: "Admission fee", due_date: "2026-12-31" })],
  ));
  const discountedId = discounted.rows[0].id;
  assert.equal((await db.query("select total from public.invoices where id=$1", [discountedId])).rows[0].total, "198.00");
  assert.equal((await db.query("select status from public.invoices where id=$1", [discountedId])).rows[0].status, "pending_approval");
  await assert.rejects(asUser(counselorId, counselorSession, (tx) => tx.query(
    "select public.operational_decide_invoice($1,'approved','Approved')", [discountedId],
  )), /Not authorized/);
  await asUser(adminId, adminSession, (tx) => tx.query("select public.operational_decide_invoice($1,'approved','Approved')", [discountedId]));
  assert.equal((await db.query("select status from public.invoices where id=$1", [discountedId])).rows[0].status, "sent");
  assert.equal((await db.query("select decision from public.invoice_approvals where invoice_id=$1", [discountedId])).rows[0].decision, "approved");
  await assert.rejects(asUser(adminId, adminSession, (tx) => tx.query(
    "select public.operational_decide_invoice($1,'approved','Again')", [discountedId],
  )), /already decided/);
});

test("installments reserve one unpaid invoice and cannot exceed the original course balance", async () => {
  const create = input => asUser(counselorId, counselorSession, tx => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id", [JSON.stringify(input)],
  ));
  const base = { lead_id: leadId, quantity: 1, tax_amount: 0, payment_type: "installments", description: "Course installment", due_date: "2026-12-31" };
  const first = await create({ ...base, unit_price: 100, course_total: 300 });
  const firstId = first.rows[0].id;
  const rootRow = (await db.query("select id,lead_id,course_total,payment_type,status from public.invoices where id=$1", [firstId])).rows[0];
  assert.equal(rootRow.course_total, "300.00");
  assert.equal(rootRow.lead_id, leadId);
  assert.equal(rootRow.payment_type, "installments");
  await assert.rejects(create({ ...base, unit_price: 50, parent_invoice_id: firstId }), /unpaid or pending installment/);
  await db.query("update public.invoices set status='paid',paid_at=now() where id=$1", [firstId]);
  await assert.rejects(create({ ...base, unit_price: 201, parent_invoice_id: firstId }), /remaining course balance/);
  const second = await create({ ...base, unit_price: 150, parent_invoice_id: firstId });
  assert.equal((await db.query("select parent_invoice_id,course_total from public.invoices where id=$1", [second.rows[0].id])).rows[0].parent_invoice_id, firstId);
});

test("external EMI/loan confirmation requires an approver and persists evidence idempotently", async () => {
  const created = await asUser(counselorId, counselorSession, tx => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({ lead_id: leadId, quantity: 1, unit_price: 500, payment_type: "loan", description: "Course loan", due_date: "2026-12-31" })],
  ));
  const id = created.rows[0].id;
  await assert.rejects(asUser(counselorId, counselorSession, tx => tx.query(
    "select public.operational_confirm_external_payment($1,'LOAN-REF','Bank receipt')", [id],
  )), /Not authorized/);
  await asUser(adminId, adminSession, tx => tx.query(
    "select public.operational_confirm_external_payment($1,'LOAN-REF','Bank receipt')", [id],
  ));
  await asUser(adminId, adminSession, tx => tx.query(
    "select public.operational_confirm_external_payment($1,'LOAN-REF','Bank receipt')", [id],
  ));
  assert.equal((await db.query("select status,external_payment_reference,payment_verified_by from public.invoices where id=$1", [id])).rows[0].status, "paid");
  assert.equal(Number((await db.query("select count(*) from public.payments where external_reference='LOAN-REF'")).rows[0].count), 1);
  assert.equal(Number((await db.query("select count(*) from public.invoice_approvals where invoice_id=$1", [id])).rows[0].count), 0);
});

test("verified Payment Link recording checks reference/amount and is idempotent", async () => {
  const created = await asUser(counselorId, counselorSession, tx => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({ lead_id: leadId, quantity: 1, unit_price: 125, tax_amount: 0, description: "Course fee", due_date: "2026-12-31" })],
  ));
  const id = created.rows[0].id;
  await db.query("update public.invoices set razorpay_payment_link_id='plink-test' where id=$1", [id]);
  const record = (paymentId, amount = 12500) => asService(tx => tx.query(
    "select public.operational_record_payment_link($1,'plink-test',$2,$3,'INR','card','{}'::jsonb) as recorded",
    [id, paymentId, amount],
  ));
  assert.equal((await record("pay-test-1")).rows[0].recorded, true);
  assert.equal((await record("pay-test-1")).rows[0].recorded, false);
  assert.equal((await db.query("select status from public.invoices where id=$1", [id])).rows[0].status, "paid");
  assert.equal(Number((await db.query("select count(*) from public.payments where invoice_id=$1", [id])).rows[0].count), 1);
  await assert.rejects(record("pay-test-2", 12400), /Payment does not match/);
  await assert.rejects(record("pay-test-3"), /already paid/);
});

test("saved reports are persistent and private to their owner", async () => {
  await asUser(counselorId, counselorSession, (tx) => tx.query(
    "insert into public.saved_reports(user_id,name,filter_json,columns_json) values($1,'My report','{}','[\"name\"]')", [counselorId],
  ));
  assert.equal((await asUser(counselorId, counselorSession, (tx) => tx.query("select * from public.saved_reports"))).rows.length, 1);
  assert.equal((await asUser(adminId, adminSession, (tx) => tx.query("select * from public.saved_reports"))).rows.length, 0);
});

test("automation runs execute real actions once per user/rule/lead/day", async () => {
  const result = await asUser(adminId, adminSession, (tx) => tx.query(
    `insert into public.automations(name,trigger_config,conditions_json,actions_json,is_active,created_by)
      values('Notify on lead','{"type":"manual"}','[]','[{"type":"notify_me","days":1}]',true,$1) returning id`, [adminId],
  ));
  const id = result.rows[0].id;
  assert.equal((await asUser(adminId, adminSession, (tx) => tx.query("select public.operational_run_automation($1,$2) as count", [id, leadId]))).rows[0].count, 1);
  assert.equal((await asUser(adminId, adminSession, (tx) => tx.query("select public.operational_run_automation($1,$2) as count", [id, leadId]))).rows[0].count, 0);
  assert.equal((await db.query("select * from public.notifications where user_id=$1", [adminId])).rows.length, 1);
  await assert.rejects(asUser(counselorId, counselorSession, (tx) => tx.query("select public.operational_run_automation($1,$2)", [id, leadId])), /Not authorized/);
});

test("profile hierarchy rejects cycles and preserves the last active Super Admin", async () => {
  await db.query("update public.profiles set reporting_to=$1 where id=$2", [adminId,counselorId]);
  await assert.rejects(db.query("update public.profiles set reporting_to=$1 where id=$2", [counselorId,adminId]), /cycle/);
  await assert.rejects(db.query("update public.profiles set status='inactive' where id=$1", [superId]), /last active Super Admin/);
});

test("access settings persist but cannot grant user management to non-Super Admin", async () => {
  await asUser(adminId, adminSession, (tx) => tx.query(
    "select public.save_access_configuration('counselor',null,$1::jsonb)", [JSON.stringify({ "leads.create": false })],
  ));
  assert.equal((await asUser(counselorId, counselorSession, (tx) => tx.query("select public.has_permission('leads.create') as allowed"))).rows[0].allowed, false);
  await assert.rejects(asUser(adminId, adminSession, (tx) => tx.query(
    "select public.save_access_configuration('admin',null,$1::jsonb)", [JSON.stringify({ "users.manage": true })],
  )), /Only Super Admin/);
  assert.equal((await asUser(superId, superSession, (tx) => tx.query("select public.has_permission('users.manage') as allowed"))).rows[0].allowed, true);
});

test("settings writes are atomic and stage retirement preserves existing data", async () => {
  const stages = (await db.query("select id,name,is_terminal from public.lead_stages order by sort_order")).rows;
  const retained = stages.slice(0, 2);
  await asUser(adminId, adminSession, (tx) => tx.query("select public.save_crm_configuration($1::jsonb,$2::jsonb)",
    [JSON.stringify(retained), JSON.stringify({ duplicateFields: "phone_email", creationPolicy: "block", fields: [] })]));
  assert.equal((await db.query("select * from public.lead_stages where is_active")).rows.length, 2);
  assert.equal((await db.query("select * from public.lead_stages")).rows.length, stages.length);
  await assert.rejects(asUser(adminId, adminSession, (tx) => tx.query("select public.save_crm_configuration($1::jsonb,'{}')",
    [JSON.stringify([{ name: retained[0].name, is_terminal: false }])])), /unique constraint/);
  assert.equal((await db.query("select * from public.lead_stages where is_active")).rows.length, 2);
});

test("logout, expiration and account deactivation each revoke database access", async () => {
  await db.query("update public.login_sessions set expires_at = now()-interval '1 second' where session_id = $1", [counselorSession]);
  assert.equal((await asUser(counselorId, counselorSession, (tx) => tx.query("select * from public.leads"))).rows.length, 0);
  await db.query("update public.login_sessions set expires_at = now()+interval '1 hour' where session_id = $1", [counselorSession]);
  await db.query("update public.profiles set status='inactive' where id=$1", [counselorId]);
  assert.equal((await asUser(counselorId, counselorSession, (tx) => tx.query("select public.is_verified_session() as allowed"))).rows[0].allowed, false);
  await db.query("update public.profiles set status='active' where id=$1", [counselorId]);
  await asUser(counselorId, counselorSession, (tx) => tx.query("select public.end_login_session()"));
  assert.equal((await asUser(counselorId, counselorSession, (tx) => tx.query("select * from public.leads"))).rows.length, 0);
});
