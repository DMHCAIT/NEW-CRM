const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { randomUUID } = require("node:crypto");

let db;
const adminId = "10000000-0000-4000-8000-000000000001";
const counselorId = "10000000-0000-4000-8000-000000000002";
const superId = "10000000-0000-4000-8000-000000000003";
const adminSession = "20000000-0000-4000-8000-000000000001";
const counselorSession = "20000000-0000-4000-8000-000000000002";
const superSession = "20000000-0000-4000-8000-000000000003";
const unverifiedSession = "20000000-0000-4000-8000-000000000099";
const leadId = "30000000-0000-4000-8000-000000000001";
const courseId = "40000000-0000-4000-8000-000000000001";
const installmentCourseId = "40000000-0000-4000-8000-000000000002";
const loanCourseId = "40000000-0000-4000-8000-000000000003";
const paymentCourseId = "40000000-0000-4000-8000-000000000004";
const invoiceDefaults = { company_code: "DMHCA", currency: "INR", billing_address: "Lead billing address", course_id: courseId };
const scheduleToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const planInput = input => ({ ...input, request_id: randomUUID(), installments: [{ amount: input.installment_amount, invoice_date: scheduleToday() }] });
const createInstallment = input => asUser(counselorId, counselorSession, tx => tx.query(
  "select (public.operational_create_installment_plan($1::jsonb))[1] as id", [JSON.stringify(planInput(input))]));
async function newPlanFixture(discount = 0) {
  const course = (await db.query("insert into public.courses(name,price_inr,price_usd) values($1,100,10) returning id", [`Scheduled plan ${randomUUID()}`])).rows[0].id;
  const date = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return { ...invoiceDefaults, lead_id: leadId, course_id: course, payment_type: "installments",
    discount_percent: discount, discount_reason: discount ? "Enrollment concession" : "",
    request_id: randomUUID(), installments: [{ amount: discount ? 50 : 59, invoice_date: date }, { amount: discount ? 56.20 : 59, invoice_date: date }] };
}
const savePlan = async input => (await asUser(counselorId, counselorSession, tx => tx.query(
  "select public.operational_create_installment_plan($1::jsonb) as ids", [JSON.stringify(input)]))).rows[0].ids;

before(async () => {
  db = new PGlite({ extensions: { pg_trgm: require("@electric-sql/pglite/contrib/pg_trgm").pg_trgm } });
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
  await db.query("update public.leads set email='lead@example.com',billing_address='Original address' where id=$1", [leadId]);
  await db.exec("update public.invoice_companies set address='Company registered billing address'");
  await db.query("insert into public.courses(id,name,price_inr,price_usd) values($1,'Admission fee',200,20),($2,'Installment course',300,30),($3,'Loan course',500,50),($4,'Payment course',125,12.50)",
    [courseId,installmentCourseId,loanCourseId,paymentCourseId]);
});

after(async () => { if (db) await db.close(); });

test("company-specific prices are authoritative and missing IBMP fees never fall back to DMHCA", async () => {
  const course = (await db.query("insert into public.courses(name,price_inr,price_usd) values($1,1000,25) returning id",
    [`Separate pricing ${randomUUID()}`])).rows[0].id;
  const input = { ...invoiceDefaults, lead_id: leadId, course_id: course, due_date: "2026-12-31" };
  const create = async values => (await asUser(counselorId,counselorSession,tx => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id", [JSON.stringify({ ...input, ...values })]))).rows[0].id;
  await assert.rejects(create({ company_code: "IBMP", currency: "USD" }), /Set the IBMP USD price/);
  await assert.rejects(create({ company_code: "IBMP", currency: "INR" }), /IBMP invoices use USD only/);
  await assert.rejects(savePlan({ ...input, company_code: "IBMP", currency: "INR", payment_type: "installments",
    request_id: randomUUID(), installments: [{ amount: 10, invoice_date: scheduleToday() }] }), /IBMP invoices use USD only/);
  await db.query("update public.courses set price_ibmp_usd=40 where id=$1",[course]);
  const cases = [["DMHCA","INR",1180],["DMHCA","USD",25],["IBMP","USD",40]];
  for (const [company_code,currency,total] of cases) {
    const id = await create({ company_code,currency,unit_price:0.01 });
    const saved = (await db.query("select total,company_code,company_snapshot from public.invoices where id=$1",[id])).rows[0];
    assert.equal(Number(saved.total),total);
    assert.equal(saved.company_code,company_code);
    assert.equal(saved.company_snapshot.code,"DMHCA");
  }
  const ids = await savePlan({ ...input, company_code:"IBMP",currency:"USD",payment_type:"installments",request_id:randomUUID(),
    installments:[{amount:10,invoice_date:scheduleToday()}] });
  await db.query("update public.courses set price_ibmp_usd=80 where id=$1",[course]);
  const children = await savePlan({ ...input, company_code:"IBMP",currency:"USD",payment_type:"installments",parent_invoice_id:ids[0],
    request_id:randomUUID(),installments:[{amount:30,invoice_date:scheduleToday()}] });
  const child = (await db.query("select course_total,enrollment_subtotal,total,company_code from public.invoices where id=$1",[children[0]])).rows[0];
  assert.deepEqual(child,{course_total:"40.00",enrollment_subtotal:"40.00",total:"30.00",company_code:"IBMP"});
  const verified = await db.query("select public.operational_record_verified_url($1,'razorpay','pay_usd_pricing','plink_usd_pricing',3000,'USD','https://rzp.io/i/test','{}') as recorded",[children[0]]);
  assert.equal(verified.rows[0].recorded,true);
  assert.equal((await db.query("select status from public.invoices where id=$1",[children[0]])).rows[0].status,"paid");
});

test("invoice document fields and bank profiles are snapshotted without changing historical installments", async () => {
  const input = await newPlanFixture();
  const invoice_profile = { billing_email: "billing@example.com", bank_accounts: [{ account_name: "Test holder", bank_name: "Test Bank", account_number: "FIXTURE-ONLY" }] };
  await db.query("update public.invoice_companies set invoice_profile=$1 where code='DMHCA'", [JSON.stringify(invoice_profile)]);
  const document_details = { student_id: "STUDENT-ONLY", place_of_supply: "Example State", course_details: "12 months / online", sac_code: "TEST-SAC" };
  const ids = await savePlan({ ...input, installments: [input.installments[0]], document_details });
  const original = (await db.query("select document_details,company_snapshot from public.invoices where id=$1", [ids[0]])).rows[0];
  assert.equal(original.document_details.billing_phone, "1234567890");
  assert.equal(original.document_details.student_id, "STUDENT-ONLY");
  assert.deepEqual(original.company_snapshot.invoice_profile, invoice_profile);
  await db.exec("update public.invoice_companies set invoice_profile='{}' where code='DMHCA'");
  await savePlan({ ...input, installments: [input.installments[0]], document_details: { student_id: "CHANGED-RETRY" } });
  assert.deepEqual((await db.query("select document_details from public.invoices where id=$1", [ids[0]])).rows[0].document_details, original.document_details);
  const next = await savePlan({ ...input, request_id: randomUUID(), installments: [input.installments[1]], parent_invoice_id: ids[0] });
  const child = (await db.query("select document_details,company_snapshot from public.invoices where id=$1", [next[0]])).rows[0];
  assert.deepEqual(child, original);
  const invalid = await newPlanFixture();
  await assert.rejects(savePlan({ ...invalid, document_details: { student_id: "x".repeat(101) } }), /Invalid invoice detail/);
  assert.equal((await db.query("select id from public.invoices where course_id=$1", [invalid.course_id])).rows.length, 0);
  await assert.rejects(asUser(counselorId, counselorSession, tx => tx.query("select public.operational_create_documentless_installment_plan($1)", [JSON.stringify(input)])), /permission denied/);
});

test("scheduled plans are atomic, idempotent and preserve exact amounts and India-time deadlines", async () => {
  const input = await newPlanFixture();
  await assert.rejects(savePlan({ ...input, installments: [{ ...input.installments[0], amount: 60 }, input.installments[1]] }), /unallocated course balance/);
  assert.equal((await db.query("select id from public.invoices where course_id=$1", [input.course_id])).rows.length, 0);
  const ids = await savePlan(input);
  assert.equal(ids.length, 2);
  assert.deepEqual(await savePlan(input), ids);
  const rows = (await db.query(`select *,extract(epoch from payment_expires_at-scheduled_for) as window_seconds
    from public.invoices where id=any($1) order by installment_number`, [ids])).rows;
  assert.deepEqual(rows.map(row => row.status), ["scheduled", "scheduled"]);
  assert.deepEqual(rows.map(row => row.total), ["59.00", "59.00"]);
  assert.equal(rows[1].parent_invoice_id, ids[0]);
  assert.equal(new Date(rows[0].scheduled_for).getUTCHours(), 3);
  assert.equal(new Date(rows[0].scheduled_for).getUTCMinutes(), 30);
  assert.equal(Number(rows[0].window_seconds), 345600);
  assert.equal((await db.query("select due_date=invoice_date+4 as correct from public.invoices where id=$1", [ids[0]])).rows[0].correct, true);
  await assert.rejects(savePlan({ ...input, request_id: randomUUID(), installments: [{ ...input.installments[0], amount: 1 }] }), /unallocated course balance/);
});

test("partial schedules extend the same course enrollment while other courses keep independent totals", async () => {
  const input = await newPlanFixture();
  const date = input.installments[0].invoice_date;
  const first = await savePlan({ ...input, installments: [{ amount: 10, invoice_date: date }, { amount: 20, invoice_date: date }] });
  const second = await savePlan({ ...input, request_id: randomUUID(), installments: [{ amount: 25, invoice_date: date }, { amount: 15, invoice_date: date }] });
  assert.equal(second.length, 2);
  const rows = (await db.query("select id,parent_invoice_id,course_total,installment_number from public.invoices where course_id=$1 order by installment_number", [input.course_id])).rows;
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => row.installment_number), [1, 2, 3, 4]);
  assert.deepEqual(rows.map(row => row.parent_invoice_id), [null, first[0], first[0], first[0]]);
  assert.ok(rows.every(row => row.course_total === "118.00"));
  const otherInput = await newPlanFixture();
  const other = await savePlan(otherInput);
  assert.notEqual(other[0], first[0]);
  await asUser(adminId, adminSession, tx => tx.query("select public.operational_confirm_external_payment($1,'BANK-PARTIAL-TEST','Verified by finance')", [second[0]]));
  const balance = (await db.query(`select max(course_total)-sum(total) filter(where status='paid') as balance,
    max(course_total)-sum(total) filter(where status not in ('cancelled','rejected')) as unallocated
    from public.invoices where coalesce(parent_invoice_id,id)=$1`, [first[0]])).rows[0];
  assert.deepEqual(balance, { balance: "93.00", unallocated: "48.00" });
  assert.equal((await db.query("select count(*)::int as count from public.invoices where id=any($1) and status='paid'", [other])).rows[0].count, 0);
});

test("courses support more than 36 installments over successive saves and never silently reopen after payment", async () => {
  const input = await newPlanFixture();
  const row = { amount: 1, invoice_date: input.installments[0].invoice_date };
  const first = await savePlan({ ...input, installments: Array.from({ length: 36 }, () => row) });
  const next = await savePlan({ ...input, request_id: randomUUID(), installments: Array.from({ length: 4 }, () => row) });
  assert.equal(next.length, 4);
  assert.equal((await db.query("select installment_number from public.invoices where id=$1", [next[3]])).rows[0].installment_number, 40);
  const last = await savePlan({ ...input, request_id: randomUUID(), installments: [{ ...row, amount: 78 }] });
  await db.query("update public.invoices set status='paid' where course_id=$1", [input.course_id]);
  await assert.rejects(savePlan({ ...input, request_id: randomUUID(), installments: [row] }), /unallocated course balance/);
  assert.equal((await db.query("select count(*)::int as count from public.invoices where course_id=$1 and parent_invoice_id is null", [input.course_id])).rows[0].count, 1);
  assert.equal((await db.query("select parent_invoice_id from public.invoices where id=$1", [last[0]])).rows[0].parent_invoice_id, first[0]);
});

test("verified external links and finance confirmations settle approved scheduled or expired installments only once", async () => {
  const ids = await savePlan(await newPlanFixture(10));
  const record = (id, paymentId, amount) => asService(tx => tx.query(
    "select public.operational_record_verified_url($1,'razorpay',$2,'plink_external',$3,'INR','https://rzp.io/i/external','{}') as recorded", [id, paymentId, amount]));
  await assert.rejects(record(ids[1], "pay_scheduled_external", 5620), /approved invoice/);
  await assert.rejects(asUser(adminId, adminSession, tx => tx.query("select public.operational_confirm_external_payment($1,'BANK-UNAPPROVED','Evidence')", [ids[1]])), /approved unpaid/);
  await asUser(adminId, adminSession, tx => tx.query("select public.operational_decide_invoice($1,'approved','Approved')", [ids[0]]));
  assert.equal((await record(ids[1], "pay_scheduled_external", 5620)).rows[0].recorded, true);
  assert.equal((await record(ids[1], "pay_scheduled_external", 5620)).rows[0].recorded, false);
  await db.query("update public.invoices set status='expired' where id=$1", [ids[0]]);
  await asUser(adminId, adminSession, tx => tx.query("select public.operational_confirm_external_payment($1,'BANK-EXPIRED-TEST','Verified bank receipt')", [ids[0]]));
  assert.equal((await db.query("select sum(total) as paid from public.invoices where id=any($1) and status='paid'", [ids])).rows[0].paid, "106.20");
  const other = await savePlan(await newPlanFixture());
  await assert.rejects(record(other[0], "pay_scheduled_external", 5900), /duplicate key/);
  await assert.rejects(asUser(counselorId, counselorSession, tx => tx.query("select public.operational_confirm_external_payment($1,'FORGED','Evidence')", [other[0]])), /Not authorized/);
  await db.query("update public.invoices set tax_review_required=true where id=$1", [other[0]]);
  await assert.rejects(record(other[1], "pay_tax_review", 5900), /approved invoice/);
});

test("saving selected installments releases today's approved invoices only and retains future schedules", async () => {
  const input = await newPlanFixture();
  input.installments[0].invoice_date = scheduleToday();
  const ids = await savePlan(input);
  const other = await savePlan({ ...await newPlanFixture(), installments: [{ amount: 59, invoice_date: scheduleToday() }] });
  const release = values => asService(tx => tx.query("select id,scheduled_for,payment_expires_at from public.operational_release_due_invoices($1::uuid[])", [values]));
  await assert.rejects(asUser(counselorId, counselorSession, tx => tx.query("select id from public.operational_release_due_invoices($1::uuid[])", [ids])), /permission denied/);
  await db.query("update public.invoices set scheduled_for=now()+interval '1 hour' where id=$1", [ids[0]]);
  const released = await release(ids);
  assert.deepEqual(released.rows.map(row => row.id), [ids[0]]);
  assert.ok(new Date(released.rows[0].scheduled_for).getTime() <= Date.now());
  assert.equal(new Date(released.rows[0].payment_expires_at) - new Date(released.rows[0].scheduled_for), 96 * 60 * 60 * 1000);
  assert.equal((await release(ids)).rows.length, 0, "immediate duplicate attempts must not resend");
  assert.equal((await db.query("select status from public.invoices where id=$1", [other[0]])).rows[0].status, "scheduled");
  assert.equal((await db.query("select status from public.invoices where id=$1", [ids[1]])).rows[0].status, "scheduled");
  const discounted = await newPlanFixture(10);
  discounted.installments[0].invoice_date = scheduleToday();
  const pending = await savePlan(discounted);
  assert.equal((await release(pending)).rows.length, 0);
  await asUser(adminId, adminSession, tx => tx.query("select public.operational_decide_invoice($1,'approved','Approved')", [pending[0]]));
  assert.deepEqual((await release(pending)).rows.map(row => row.id), [pending[0]]);
  await assert.rejects(release([]), /between 1 and 36/);
  await assert.rejects(release(null), /between 1 and 36/);
  await db.query("update public.invoices set email_message_id='accepted' where id=any($1)", [[ids[0], pending[0]]]);
});

test("one discount decision unlocks every due installment without waiting for earlier payment", async () => {
  const ids = await savePlan(await newPlanFixture(10));
  assert.equal((await db.query("select count(*)::int as count from public.invoice_approvals where invoice_id=any($1)", [ids])).rows[0].count, 1);
  await db.query("update public.invoices set scheduled_for=now()-interval '1 minute' where id=any($1)", [ids]);
  assert.equal((await asService(tx => tx.query("select id from public.operational_release_due_invoices() where id=any($1)", [ids]))).rows.length, 0);
  await asUser(adminId, adminSession, tx => tx.query("select public.operational_decide_invoice($1,'approved','Approved enrollment')", [ids[0]]));
  const released = await asService(tx => tx.query("select id from public.operational_release_due_invoices() where id=any($1)", [ids]));
  assert.equal(released.rows.length, 2);
  assert.deepEqual((await db.query("select status from public.invoices where id=any($1)", [ids])).rows.map(row => row.status), ["sent", "sent"]);
  assert.equal((await asService(tx => tx.query("select id from public.operational_release_due_invoices() where id=any($1)", [ids]))).rows.length, 0, "claimed attempts must not immediately repeat");
  await db.query("update public.invoices set delivery_attempted_at=now()-interval '16 minutes' where id=any($1)", [ids]);
  assert.equal((await asService(tx => tx.query("select id from public.operational_release_due_invoices() where id=any($1)", [ids]))).rows.length, 2, "safe failures may retry");
  await db.query("update public.invoices set email_message_id='accepted' where id=any($1)", [ids]);
  assert.equal((await asService(tx => tx.query("select id from public.operational_release_due_invoices() where id=any($1)", [ids]))).rows.length, 0);
});

test("rejection cancels scheduled children and workers cannot bypass approval or delivery locks", async () => {
  const ids = await savePlan(await newPlanFixture(10));
  await asUser(adminId, adminSession, tx => tx.query("select public.operational_decide_invoice($1,'rejected','Not approved')", [ids[0]]));
  assert.deepEqual((await db.query("select status from public.invoices where id=any($1) order by installment_number", [ids])).rows.map(row => row.status), ["rejected", "cancelled"]);
  await assert.rejects(asUser(counselorId, counselorSession, tx => tx.query("select public.operational_release_due_invoices()")), /permission denied/);
  const input = await newPlanFixture();
  await assert.rejects(asUser(counselorId, unverifiedSession, tx => tx.query("select public.operational_create_installment_plan($1::jsonb)", [JSON.stringify(input)])), /Not authorized/);
  const locked = await savePlan(input);
  await db.query("update public.invoices set scheduled_for=now()-interval '1 minute',email_lock_at=now() where id=any($1)", [locked]);
  assert.equal((await asService(tx => tx.query("select id from public.operational_release_due_invoices() where id=any($1)", [locked]))).rows.length, 0);
  await db.query("update public.invoices set payment_expires_at=now()-interval '1 minute' where id=any($1)", [locked]);
  await asService(tx => tx.query("select public.operational_release_due_invoices()"));
  assert.equal((await db.query("select status,delivery_error from public.invoices where id=$1", [locked[0]])).rows[0].status, "expired");
});

test("schedule validation rejects past, unordered, tiny and overprecise installments without partial writes", async () => {
  const input = await newPlanFixture();
  for (const installments of [
    [{ amount: 1, invoice_date: "2020-01-01" }],
    [{ amount: 0.99, invoice_date: input.installments[0].invoice_date }],
    [{ amount: 1.001, invoice_date: input.installments[0].invoice_date }],
    [{ amount: 59, invoice_date: "2099-01-01" }, input.installments[1]],
  ]) await assert.rejects(savePlan({ ...input, installments }));
  assert.equal((await db.query("select id from public.invoices where course_id=$1", [input.course_id])).rows.length, 0);
  await assert.rejects(asUser(counselorId, counselorSession, tx => tx.query("select public.operational_create_unscheduled_invoice('{}')")), /permission denied/);
});

test("closing the expired first installment does not block later approved scheduled payments", async () => {
  const ids = await savePlan(await newPlanFixture());
  await db.query("update public.invoices set status='cancelled',payment_expires_at=now()-interval '1 minute' where id=$1", [ids[0]]);
  await db.query("update public.invoices set scheduled_for=now()-interval '1 minute' where id=$1", [ids[1]]);
  const released = await asService(tx => tx.query("select id from public.operational_release_due_invoices() where id=any($1)", [ids]));
  assert.deepEqual(released.rows.map(row => row.id), [ids[1]]);
  await db.query("update public.invoices set email_message_id='accepted' where id=$1", [ids[1]]);
});

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
  const { missingSchemaColumns } = require("../scripts/database.cjs");
  assert.deepEqual(await missingSchemaColumns(db), []);
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
    [JSON.stringify({ ...invoiceDefaults, lead_id: leadId, quantity: 2, unit_price: 100, tax_amount: 18, discount_amount: 0, description: "Admission fee", due_date: "2026-12-31" })],
  ));
  const id = invoice.rows[0].id;
  assert.equal((await db.query("select total from public.invoices where id=$1", [id])).rows[0].total, "236.00");
  assert.equal((await db.query("select status from public.invoices where id=$1", [id])).rows[0].status, "sent");
  assert.equal((await db.query("select * from public.invoice_items where invoice_id=$1", [id])).rows.length, 1);
  assert.equal((await db.query("select * from public.invoice_approvals where invoice_id=$1", [id])).rows.length, 0);

  const discounted = await asUser(counselorId, counselorSession, (tx) => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({ ...invoiceDefaults, lead_id: leadId, quantity: 2, unit_price: 100, tax_amount: 18, discount_percent: 10, discount_reason: "Scholarship", description: "Admission fee", due_date: "2026-12-31" })],
  ));
  const discountedId = discounted.rows[0].id;
  assert.equal((await db.query("select total from public.invoices where id=$1", [discountedId])).rows[0].total, "212.40");
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

test("installments reserve every unpaid invoice and cannot exceed the original course balance", async () => {
  const create = input => createInstallment({ ...invoiceDefaults, ...input, course_id: installmentCourseId, installment_amount: input.unit_price });
  const base = { lead_id: leadId, quantity: 1, tax_amount: 0, payment_type: "installments", description: "Course installment", due_date: "2026-12-31" };
  const first = await create({ ...base, unit_price: 100, course_total: 300 });
  const firstId = first.rows[0].id;
  const rootRow = (await db.query("select id,lead_id,course_total,payment_type,status from public.invoices where id=$1", [firstId])).rows[0];
  assert.equal(rootRow.course_total, "354.00");
  assert.equal(rootRow.lead_id, leadId);
  assert.equal(rootRow.payment_type, "installments");
  await assert.rejects(create({ ...base, unit_price: 255, parent_invoice_id: firstId }), /unallocated course balance/);
  await db.query("update public.invoices set status='paid',paid_at=now() where id=$1", [firstId]);
  await assert.rejects(create({ ...base, unit_price: 255, parent_invoice_id: firstId }), /unallocated course balance/);
  await assert.rejects(create({...base,unit_price:50,parent_invoice_id:firstId,company_code:"IBMP"}),/IBMP invoices use USD only/);
  await assert.rejects(create({...base,unit_price:50,parent_invoice_id:firstId,currency:"USD"}),/original course, company and currency/);
  await db.query("update public.courses set price_inr=50,is_active=false where id=$1",[installmentCourseId]);
  const second = await create({ ...base, unit_price: 150, parent_invoice_id: firstId });
  assert.equal((await db.query("select parent_invoice_id,course_total from public.invoices where id=$1", [second.rows[0].id])).rows[0].parent_invoice_id, firstId);
  await assert.rejects(create({...base,unit_price:50,parent_invoice_id:second.rows[0].id}),/Enrollment is unavailable/);
  await db.query("update public.courses set price_inr=300,is_active=true where id=$1",[installmentCourseId]);
});

test("tax-inclusive discounted installments preserve the course agreement through the final cent", async () => {
  const course = (await db.query("insert into public.courses(name,price_inr,price_usd) values('Gross installment test',140000,1400) returning id")).rows[0].id;
  const base = {...invoiceDefaults,course_id:course,lead_id:leadId,payment_type:"installments",discount_percent:10,
    discount_reason:"Approved course concession",tax_percent:18,tax_amount:1,course_total:1,due_date:"2026-12-31"};
  const create = input => createInstallment({...base,...input});
  const first = (await create({installment_amount:40000})).rows[0].id;
  let invoice = (await db.query("select * from public.invoices where id=$1",[first])).rows[0];
  assert.equal(invoice.total,"40000.00","entered payment must not be discounted or taxed again");
  assert.equal(invoice.course_total,"148680.00");
  assert.equal(invoice.status,"pending_approval");
  assert.equal(invoice.installment_number,1);
  await assert.rejects(create({installment_amount:148680}),/unallocated course balance/);
  await asUser(superId,superSession,tx=>tx.query("select public.operational_decide_invoice($1,'approved','Approved')",[first]));
  await db.query("update public.invoices set status='paid',paid_at=now() where id=$1",[first]);
  await db.query("update public.courses set price_inr=200000,is_active=false where id=$1",[course]);
  const second = (await create({installment_amount:50000,discount_percent:99,tax_percent:99})).rows[0].id;
  invoice = (await db.query("select * from public.invoices where id=$1",[second])).rows[0];
  assert.equal(invoice.parent_invoice_id,first,"omitting the parent must still continue the same enrollment");
  assert.equal(invoice.course_total,"148680.00");
  assert.equal(invoice.discount_percent,"10.00");
  assert.equal(invoice.enrollment_tax_percent,"18.00");
  assert.equal(invoice.total,"50000.00");
  assert.equal(invoice.status,"scheduled","unchanged approved course pricing does not require reapproval");
  assert.equal(invoice.installment_number,2);
  assert.equal((await db.query("select count(*) from public.invoice_approvals where invoice_id=$1",[second])).rows[0].count,0);
  await db.query("update public.invoices set status='paid',paid_at=now() where id=$1",[second]);
  await assert.rejects(create({installment_amount:58680.01}),/unallocated course balance/);
  await assert.rejects(create({installment_amount:58679.50}),/less than one currency unit/);
  const third = (await create({installment_amount:58680})).rows[0].id;
  await db.query("update public.invoices set status='paid',paid_at=now() where id=$1",[third]);
  const sums=(await db.query(`select sum(subtotal) as base,sum(discount_amount) as discount,sum(tax_amount) as tax,sum(total) as total
    from public.invoices where coalesce(parent_invoice_id,id)=$1 and status='paid'`,[first])).rows[0];
  assert.deepEqual(sums,{base:"140000.00",discount:"14000.00",tax:"22680.00",total:"148680.00"});
  assert.equal((await db.query("select installment_number from public.invoices where id=$1",[third])).rows[0].installment_number,3);
  await assert.rejects(create({parent_invoice_id:first,installment_amount:1}),/unallocated course balance/);
});

test("verified external URLs are service-only, exact-amount, idempotent and cannot reuse a payment", async () => {
  const create=()=>asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({...invoiceDefaults,lead_id:leadId,course_id:paymentCourseId,due_date:"2026-12-31"})]));
  const first=(await create()).rows[0].id,second=(await create()).rows[0].id;
  const sql="select public.operational_record_verified_url($1,'razorpay','pay_external','plink_external',$2,'INR','https://rzp.io/i/external','{}'::jsonb) as recorded";
  await assert.rejects(asUser(counselorId,counselorSession,tx=>tx.query(sql,[first,14750])),/permission denied/);
  await assert.rejects(asService(tx=>tx.query(sql,[first,12499])),/does not match/);
  assert.equal((await asService(tx=>tx.query(sql,[first,14750]))).rows[0].recorded,true);
  assert.equal((await asService(tx=>tx.query(sql,[first,14750]))).rows[0].recorded,false);
  await assert.rejects(asService(tx=>tx.query(sql,[second,14750])),/duplicate key/);
  assert.equal((await db.query("select status from public.invoices where id=$1",[second])).rows[0].status,"sent");
  await asUser(adminId,adminSession,tx=>tx.query("select public.operational_confirm_external_payment($1,'BANK-FULL','Bank statement verified')",[second]));
  assert.equal((await db.query("select status from public.invoices where id=$1",[second])).rows[0].status,"paid");
});

test("currency tax and the four-day deadline are server controlled even with forged inputs",async()=>{
  for(const [currency,expectedTax,total] of [["INR","36.00","236.00"],["USD","0.00","20.00"]]){
    const id=(await asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_create_invoice($1::jsonb) as id",
      [JSON.stringify({...invoiceDefaults,lead_id:leadId,currency,tax_percent:99,tax_amount:999,due_date:"2099-12-31"})]))).rows[0].id;
    const row=(await db.query(`select *,extract(epoch from payment_expires_at-created_at) as window_seconds,
      due_date=((created_at+interval '96 hours') at time zone 'UTC')::date as correct_due from public.invoices where id=$1`,[id])).rows[0];
    assert.equal(row.tax_amount,expectedTax);assert.equal(row.total,total);
    assert.equal(Number(row.window_seconds),345600);assert.equal(row.correct_due,true);
  }
});

test("admin review recalculates wholly unpaid legacy tax then requires approval before issue",async()=>{
  const id=(await asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({...invoiceDefaults,lead_id:leadId,due_date:"2026-12-31"})]))).rows[0].id;
  await db.query(`update public.invoices set payment_type='installments',enrollment_tax=0,enrollment_tax_percent=0,enrollment_discount=0,
    enrollment_subtotal=200,course_total=200,total=100,subtotal=100,tax_amount=0,tax_review_required=true where id=$1`,[id]);
  await assert.rejects(asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_review_invoice_tax($1)",[id])),/Not authorized/);
  await db.query("update public.invoices set razorpay_payment_link_id='plink_old' where id=$1",[id]);
  await assert.rejects(asUser(adminId,adminSession,tx=>tx.query("select public.operational_review_invoice_tax($1)",[id])),/cancel existing payment links/);
  await db.query("update public.invoices set razorpay_payment_link_id=null where id=$1",[id]);
  await asUser(adminId,adminSession,tx=>tx.query("select public.operational_review_invoice_tax($1)",[id]));
  const invoice=(await db.query("select * from public.invoices where id=$1",[id])).rows[0];
  assert.equal(invoice.course_total,"236.00");assert.equal(invoice.total,"100.00");
  assert.equal(invoice.enrollment_tax_percent,"18.00");assert.equal(invoice.status,"pending_approval");
  assert.equal(invoice.tax_review_required,false);assert.equal(invoice.payment_revision,2);
  assert.ok(invoice.pricing_review_note);
  await asUser(superId,superSession,tx=>tx.query("select public.operational_decide_invoice($1,'approved','Tax policy approved')",[id]));
  assert.equal((await db.query("select status from public.invoices where id=$1",[id])).rows[0].status,"sent");
  await db.query("update public.invoices set status='paid',paid_at=now(),tax_review_required=true where id=$1",[id]);
  await assert.rejects(asUser(adminId,adminSession,tx=>tx.query("select public.operational_review_invoice_tax($1)",[id])),/unavailable/);
});

test("an expired approval cannot reopen or extend the payment window",async()=>{
  const id=(await asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({...invoiceDefaults,lead_id:leadId,discount_percent:10,discount_reason:"Test",due_date:"2026-12-31"})]))).rows[0].id;
  await db.query("update public.invoices set payment_expires_at=now()-interval '1 second' where id=$1",[id]);
  await assert.rejects(asUser(adminId,adminSession,tx=>tx.query("select public.operational_decide_invoice($1,'approved','Late approval')",[id])),/expired/);
  assert.equal((await db.query("select status from public.invoices where id=$1",[id])).rows[0].status,"pending_approval");
});

test("external EMI/loan confirmation requires an approver and persists evidence idempotently", async () => {
  const created = await asUser(counselorId, counselorSession, tx => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({ ...invoiceDefaults, course_id: loanCourseId, lead_id: leadId, quantity: 1, unit_price: 500, payment_type: "loan", description: "Course loan", due_date: "2026-12-31" })],
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
    [JSON.stringify({ ...invoiceDefaults, course_id: paymentCourseId, lead_id: leadId, quantity: 1, unit_price: 125, tax_amount: 0, description: "Course fee", due_date: "2026-12-31" })],
  ));
  const id = created.rows[0].id;
  await db.query("update public.invoices set razorpay_payment_link_id='plink-test' where id=$1", [id]);
  const record = (paymentId, amount = 14750) => asService(tx => tx.query(
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

test("installment provider payments mark only the exact installment Paid and retain the course outstanding balance", async () => {
  for (const currency of ["INR", "USD"]) {
    const input = await newPlanFixture();
    Object.assign(input, { currency, installments: [
      { amount: currency === "INR" ? 59 : 5, invoice_date: scheduleToday() },
      { amount: currency === "INR" ? 59 : 5, invoice_date: scheduleToday() },
    ] });
    const ids = await savePlan(input);
    await asService(tx => tx.query("select * from public.operational_release_due_invoices($1::uuid[])", [ids]));
    const id = ids[0];
    const amount = currency === "INR" ? 5900 : 500;
    await db.query(currency === "INR"
      ? "update public.invoices set razorpay_payment_link_id='plink-installment' where id=$1"
      : "update public.invoices set stripe_session_id='cs_installment' where id=$1", [id]);
    const record = cents => asService(tx => tx.query(currency === "INR"
      ? "select public.operational_record_payment_link($1,'plink-installment','pay-installment',$2,'INR','card','{}')"
      : "select public.operational_record_stripe_payment($1,'cs_installment','pi_installment',$2,'usd','{}')", [id, cents]));
    await assert.rejects(record(amount * 2), /does not match/);
    assert.equal((await db.query("select status from public.invoices where id=$1", [id])).rows[0].status, "sent");
    await record(amount);
    const rows = (await db.query("select id,status,paid_at,course_total,total from public.invoices where id=any($1)", [ids])).rows;
    assert.equal(rows.find(row => row.id === id).status, "paid");
    assert.ok(rows.find(row => row.id === id).paid_at);
    assert.equal(rows.find(row => row.id === ids[1]).status, "sent");
    assert.equal(Number(rows[0].course_total) - rows.filter(row => row.status === "paid").reduce((sum, row) => sum + Number(row.total), 0),
      currency === "INR" ? 59 : 5);
  }
});

test("catalog prices override forged browser amounts and snapshot billing/company details", async () => {
  await db.query("update public.courses set price_ibmp_usd=35 where id=$1",[courseId]);
  const result = await asUser(counselorId,counselorSession,tx => tx.query(
    "select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({ ...invoiceDefaults, lead_id: leadId, currency: "USD", company_code: "IBMP", unit_price: 0.01,
      quantity: 9999, description: "Forged description", due_date: "2026-12-31", save_billing_address: true })]));
  const id = result.rows[0].id;
  const invoice = (await db.query("select * from public.invoices where id=$1",[id])).rows[0];
  assert.equal(invoice.total,"35.00");
  assert.equal(invoice.currency,"USD");
  assert.equal(invoice.billing_name,"Live lead");
  assert.equal(invoice.billing_email,"lead@example.com");
  assert.equal(invoice.billing_address,invoiceDefaults.billing_address);
  assert.equal(invoice.owner_email,"counselor@example.com");
  assert.equal(invoice.creator_email,"counselor@example.com");
  assert.equal(invoice.company_code,"IBMP","pricing company remains separate from document issuer");
  assert.equal(invoice.company_snapshot.code,"DMHCA");
  assert.equal(invoice.company_snapshot.primary_color,"#800020");
  assert.equal(invoice.company_snapshot.accent_color,"#f7cbd7");
  const item = (await db.query("select * from public.invoice_items where invoice_id=$1",[id])).rows[0];
  assert.equal(item.description,"Admission fee");
  assert.equal(Number(item.quantity),1);
  await db.query("update public.invoice_companies set legal_name='Updated IBMP' where code='IBMP'");
  await db.query("update public.courses set price_usd=25 where id=$1",[courseId]);
  const unchanged = (await db.query("select * from public.invoices where id=$1",[id])).rows[0];
  assert.equal(unchanged.total,"35.00");
  assert.equal(unchanged.company_snapshot.legal_name,"DMHCA");
  assert.equal((await db.query("select billing_address from public.leads where id=$1",[leadId])).rows[0].billing_address,invoiceDefaults.billing_address);
  await db.query("update public.courses set price_usd=20 where id=$1",[courseId]);
  await db.query("update public.invoice_companies set legal_name='IBMP' where code='IBMP'");
});

test("historical installments continue at their original fee without fabricated catalog mappings", async () => {
  const legacyId="50000000-0000-4000-8000-000000000099";
  await db.query("insert into public.invoices(id,invoice_no,lead_id,created_by,status,subtotal,total,payment_type,course_total) values($1,'LEGACY-TEST',$2,$3,'paid',100,100,'installments',300)",
    [legacyId,leadId,counselorId]);
  await db.query("insert into public.invoice_items(invoice_id,description,quantity,unit_price,amount) values($1,'Original course',1,100,100)",[legacyId]);
  const input={...invoiceDefaults,course_id:undefined,lead_id:leadId,parent_invoice_id:legacyId,payment_type:"installments",installment_amount:200,due_date:"2026-12-31"};
  const create=values=>createInstallment({...input,...values});
  await assert.rejects(create({currency:"USD"}),/original course, company and currency/);
  await assert.rejects(create({company_code:"IBMP"}),/IBMP invoices use USD only/);
  const id=(await create({})).rows[0].id;
  const invoice=(await db.query("select * from public.invoices where id=$1",[id])).rows[0];
  assert.equal(invoice.course_id,null);
  assert.equal(invoice.company_code,"DMHCA");
  assert.equal(invoice.company_snapshot.legal_name,"DMHCA");
  assert.equal(invoice.total,"200.00");
  assert.equal((await db.query("select description from public.invoice_items where invoice_id=$1",[id])).rows[0].description,"Original course");
});

test("course and company edits require administrator permission and verified sessions", async () => {
  assert.equal((await asUser(counselorId,counselorSession,tx=>tx.query("select * from public.courses"))).rows.length,
    (await db.query("select * from public.courses")).rows.length);
  assert.equal((await asUser(counselorId,unverifiedSession,tx=>tx.query("select * from public.courses"))).rows.length,0);
  assert.equal((await asUser(counselorId,counselorSession,tx=>tx.query("update public.courses set price_inr=1 returning id"))).rows.length,0);
  await assert.rejects(asUser(counselorId,counselorSession,tx=>tx.query("insert into public.courses(name,price_inr,price_usd) values('Forbidden',1,1)")),/row-level security/);
  assert.equal((await asUser(counselorId,counselorSession,tx=>tx.query("update public.invoice_companies set address='Forged' returning code"))).rows.length,0);
  await assert.rejects(asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_create_legacy_invoice('{}')")),/permission denied/);
  await assert.rejects(asUser(counselorId,counselorSession,tx=>tx.query("insert into public.invoices(lead_id) values($1)",[leadId])),/permission denied/);
});

test("catalog invoices reject inactive courses, incomplete issuer, missing address and hidden leads", async () => {
  const create = input => asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_create_invoice($1::jsonb)",[JSON.stringify({
    ...invoiceDefaults,lead_id:leadId,due_date:"2026-12-31",...input,
  })]));
  await db.query("update public.courses set is_active=false where id=$1",[courseId]);
  await assert.rejects(create({}),/active catalog course/);
  await db.query("update public.courses set is_active=true where id=$1",[courseId]);
  await db.exec("update public.invoice_companies set address='' where code='DMHCA'");
  await assert.rejects(create({}),/Complete company billing/);
  await db.exec("update public.invoice_companies set address='Company registered billing address' where code='DMHCA'");
  await assert.rejects(create({billing_address:""}),/billing address is required/);
  await assert.rejects(create({currency:"EUR"}),/INR or USD/);
  await assert.rejects(create({lead_id:"30000000-0000-4000-8000-000000000099"}),/Lead unavailable/);
});

test("Stripe records only exact paid USD sessions and is idempotent, service-only and rollback safe", async () => {
  const create = await asUser(counselorId,counselorSession,tx=>tx.query(
    "select public.operational_create_invoice($1::jsonb) as id",[JSON.stringify({...invoiceDefaults,lead_id:leadId,currency:"USD",due_date:"2026-12-31"})]));
  const id=create.rows[0].id;
  await db.query("update public.invoices set stripe_session_id='cs_test_1' where id=$1",[id]);
  const record = (payment="pi_test_1",session="cs_test_1",amount=2000,currency="usd")=>asService(tx=>tx.query(
    "select public.operational_record_stripe_payment($1,$2,$3,$4,$5,'{}') as recorded",[id,session,payment,amount,currency]));
  await assert.rejects(record("pi_wrong","cs_wrong"),/does not match/);
  await assert.rejects(record("pi_wrong","cs_test_1",1999),/does not match/);
  await assert.rejects(record("pi_wrong","cs_test_1",2000,"inr"),/does not match/);
  assert.equal((await record()).rows[0].recorded,true);
  assert.equal((await record()).rows[0].recorded,false);
  assert.equal((await db.query("select status from public.invoices where id=$1",[id])).rows[0].status,"paid");
  assert.equal(Number((await db.query("select count(*) from public.payments where stripe_payment_id='pi_test_1'")).rows[0].count),1);
  await assert.rejects(record("pi_other"),/already paid/);
  await assert.rejects(asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_record_stripe_payment($1,'cs_test_1','pi_other',2000,'usd','{}')",[id])),/permission denied/);
});

test("Stripe renewal history accepts delayed paid webhooks without accepting an unrelated session",async()=>{
  const id=(await asUser(counselorId,counselorSession,tx=>tx.query("select public.operational_create_invoice($1::jsonb) as id",
    [JSON.stringify({...invoiceDefaults,lead_id:leadId,currency:"USD",due_date:"2026-12-31"})]))).rows[0].id;
  await db.query("update public.invoices set stripe_session_id='cs_latest' where id=$1",[id]);
  await asService(tx=>tx.query("insert into public.invoice_checkout_sessions(session_id,invoice_id,expires_at) values('cs_prior',$1,now()-interval '1 hour')",[id]));
  const record=session=>asService(tx=>tx.query("select public.operational_record_stripe_payment($1,$2,'pi_delayed',2000,'usd','{}') as recorded",[id,session]));
  await assert.rejects(record("cs_unrelated"),/does not match/);
  assert.equal((await record("cs_prior")).rows[0].recorded,true);
  assert.equal((await record("cs_prior")).rows[0].recorded,false);
  assert.equal((await db.query("select status from public.invoices where id=$1",[id])).rows[0].status,"paid");
  await assert.rejects(asUser(counselorId,counselorSession,tx=>tx.query("select * from public.invoice_checkout_sessions")),/permission denied/);
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
