const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
let db, inTransaction = false;
const owner = "11000000-0000-4000-8000-000000000001";
const other = "11000000-0000-4000-8000-000000000002";
const lead = "31000000-0000-4000-8000-000000000001";
const session = "21000000-0000-4000-8000-000000000001";
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
  for (const file of readdirSync(directory).filter(name => name.endsWith(".sql")).sort())
    await db.exec(readFileSync(join(directory, file), "utf8").replace(/^create extension if not exists pgcrypto;\s*/im, ""));
  for (const [id, name] of [[owner, "Owner"], [other, "Other"]]) {
    await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${name}@example.test`]);
    await db.query("insert into public.profiles(id,full_name,email,role) values($1,$2,$3,'counselor')", [id, name, `${name}@example.test`]);
  }
  await db.query("insert into public.login_sessions(session_id,user_id,email) values($1,$2,'Owner@example.test')", [session, owner]);
  await db.query("insert into public.leads(id,name,phone,normalized_phone,created_by,assignee_id) values($1,'Reminder lead','1111111111','1111111111',$2,$2)", [lead, owner]);
});
after(async () => { if (db) await db.close(); });
async function asOwner(callback, verified = true) {
  const run = async tx => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, session_id: verified ? session : other })]);
    return callback(tx);
  };
  if (!inTransaction) return db.transaction(run);
  await db.exec("savepoint owner_action");
  try {
    const result = await run(db);
    await db.exec("reset role; select set_config('request.jwt.claims','',true); release savepoint owner_action");
    return result;
  } catch (error) {
    await db.exec("rollback to savepoint owner_action; release savepoint owner_action");
    throw error;
  }
}
async function isolated(callback) {
  await db.exec("begin");
  inTransaction = true;
  try { await callback(); } finally { inTransaction = false; await db.exec("rollback"); }
}

test("lead changes notify the owner transactionally, including own edits but not no-op updates", async () => {
  await asOwner(tx => tx.query("update public.leads set course='Cardiology' where id=$1", [lead]));
  const rows = (await db.query("select n.*,q.status from public.notifications n join public.notification_email_queue q on q.notification_id=n.id")).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, owner);
  assert.equal(rows[0].lead_id, lead);
  assert.match(rows[0].payload.message, /Owner: Lead details updated/);
  assert.equal(rows[0].status, "pending");
  await asOwner(tx => tx.query("update public.leads set course='Cardiology' where id=$1", [lead]));
  assert.equal((await db.query("select count(*)::int as count from public.notifications")).rows[0].count, 1);
});

test("scheduling waits until due; reminders deduplicate and follow rescheduling, cancellation and ownership", async () => {
  await isolated(async () => {
    const initialNotifications = (await db.query("select count(*)::int as count from public.notifications")).rows[0].count;
    const call = (await db.query("insert into public.scheduled_calls(lead_id,user_id,scheduled_at,status) values($1,$2,now()+interval '1 hour','scheduled') returning id", [lead, owner])).rows[0].id;
    assert.equal((await db.query("select count(*)::int as count from public.notifications")).rows[0].count, initialNotifications, "new schedules do not notify before their due time");
    assert.equal((await db.query("select public.release_due_call_notifications() as count")).rows[0].count, 0);
    await db.query("update public.scheduled_calls set scheduled_at=now()-interval '1 minute' where id=$1", [call]);
    assert.equal((await db.query("select public.release_due_call_notifications() as count")).rows[0].count, 1);
    assert.equal((await db.query("select public.release_due_call_notifications() as count")).rows[0].count, 0);
    await db.query("update public.scheduled_calls set scheduled_at=now()+interval '1 hour' where id=$1", [call]);
    assert.equal((await db.query("select public.release_due_call_notifications() as count")).rows[0].count, 0);
    await db.query("update public.leads set assignee_id=$1 where id=$2", [other, lead]);
    await db.query("update public.scheduled_calls set scheduled_at=now()-interval '2 minutes' where id=$1", [call]);
    assert.equal((await db.query("select public.release_due_call_notifications($1) as count", [owner])).rows[0].count, 0);
    assert.equal((await db.query("select public.release_due_call_notifications() as count")).rows[0].count, 1);
    assert.equal((await db.query("select user_id from public.notifications where type='call_due' order by created_at desc,id")).rows.some(row => row.user_id === other), true);
    await db.query("update public.scheduled_calls set scheduled_at=now()-interval '3 minutes',status='cancelled' where id=$1", [call]);
    assert.equal((await db.query("select public.release_due_call_notifications() as count")).rows[0].count, 0);
  });
});

test("reschedules and call attempts create owner alerts; notes and sent emails queue once", async () => {
  await isolated(async () => {
    const call = (await asOwner(tx => tx.query("insert into public.scheduled_calls(lead_id,user_id,scheduled_at,status) values($1,$2,now()+interval '1 hour','scheduled') returning id", [lead, owner]))).rows[0].id;
    const before = (await db.query("select count(*)::int as count from public.notifications")).rows[0].count;
    await asOwner(tx => tx.query("select public.update_lead_scheduled_call($1,$2,'scheduled',now()+interval '2 hours')", [lead, call]));
    await asOwner(tx => tx.query("insert into public.activities(lead_id,user_id,type,description) values($1,$2,'call','Phone app opened to call lead')", [lead, owner]));
    await asOwner(tx => tx.query("insert into public.notes(lead_id,user_id,content) values($1,$2,'Follow up')", [lead, owner]));
    const email = (await db.query("insert into public.emails(lead_id,user_id,to_email,subject,body,status) values($1,$2,'lead@example.test','Info','Details','queued') returning id", [lead, owner])).rows[0].id;
    await db.query("update public.emails set status='sent' where id=$1", [email]);
    await db.query("update public.emails set status='sent' where id=$1", [email]);
    assert.equal((await db.query("select count(*)::int as count from public.notifications")).rows[0].count - before, 4);
    assert.equal((await db.query("select count(*)::int as count from public.notification_email_queue")).rows[0].count,
      (await db.query("select count(*)::int as count from public.notifications")).rows[0].count);
  });
});

test("owners read/mark only their alerts and cannot forge events, deliver emails or release another owner's reminders", async () => {
  await asOwner(async tx => {
    const rows = (await tx.query("select * from public.notifications")).rows;
    assert.ok(rows.every(row => row.user_id === owner));
    await tx.query("update public.notifications set is_read=true where id=$1", [rows[0].id]);
    assert.equal((await tx.query("select is_read from public.notifications where id=$1", [rows[0].id])).rows[0].is_read, true);
  });
  for (const sql of [
    "select public.claim_notification_emails()", "select public.release_due_call_notifications()",
    "select * from public.notification_email_queue",
    `insert into public.notifications(user_id,type,event_key) values('${owner}','forged','fake')`,
    "update public.notifications set event_key='forged'",
  ]) await assert.rejects(asOwner(tx => tx.query(sql)), /permission denied/);
  await assert.rejects(asOwner(tx => tx.query("select public.release_my_due_call_notifications()"), false), /Verified CRM session/);
});

test("email claims are exclusive, retry bounded, and stale leases receive a different fencing token", async () => {
  await isolated(async () => {
    const first = (await db.query("select * from public.claim_notification_emails()")).rows;
    assert.equal(first.length, 1);
    assert.equal(first[0].recipient, "Owner@example.test");
    assert.equal((await db.query("select * from public.claim_notification_emails()")).rows.length, 0);
    await db.query("update public.notification_email_queue set claimed_at=now()-interval '6 minutes' where id=$1", [first[0].id]);
    const retry = (await db.query("select * from public.claim_notification_emails()")).rows;
    assert.notEqual(retry[0].claim_token, first[0].claim_token);
    await db.query("update public.notification_email_queue set attempts=5,status='failed',retry_at=now()");
    assert.equal((await db.query("select * from public.claim_notification_emails()")).rows.length, 0);
  });
});
