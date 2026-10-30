const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
let db;
const admin = "11000000-0000-4000-8000-000000000001";
const owner = "11000000-0000-4000-8000-000000000002";
const hidden = "11000000-0000-4000-8000-000000000003";
const session = "22000000-0000-4000-8000-000000000002";
const source = "33000000-0000-4000-8000-000000000001";
const hiddenLead = "44000000-0000-4000-8000-000000000001";
before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
    alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;`);
  const directory = join(__dirname, "..", "supabase", "migrations");
  for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(directory, file), "utf8").replace(/^create extension if not exists pgcrypto;\s*/im, ""));
  }
  await db.query("insert into auth.users values($1,'admin@example.com'),($2,'owner@example.com'),($3,'hidden@example.com')", [admin, owner, hidden]);
  await db.query(`insert into public.profiles(id,full_name,email,role) values($1,'Admin','admin@example.com','admin'),($2,'Owner','owner@example.com','counselor'),($3,'Hidden','hidden@example.com','counselor')`, [admin, owner, hidden]);
  await db.query("insert into public.login_sessions(session_id,user_id,email) values($1,$2,'owner@example.com')", [session, owner]);
  await db.query("insert into public.user_permission_overrides(user_id,permission_key,allowed) values($1,'integrations.view',true)", [owner]);
  await db.query("insert into public.lead_sources(id,name,api_key_hash) values($1,'Website chatbot','hash')", [source]);
  await db.query("insert into public.intake_source_settings(source_id,channel,owner_id,created_by) values($1,'chatbot',$2,$3)", [source, owner, admin]);
  await db.query("insert into public.leads(id,name,phone,normalized_phone,email,normalized_email,created_by,assignee_id) values($1,'Hidden lead','9876543210','9876543210','hidden@example.com','hidden@example.com',$2,$2)", [hiddenLead, hidden]);
});
after(async () => { if (db) await db.close(); });
async function service(callback) { return db.transaction(async (tx) => { await tx.exec("set local role service_role"); return callback(tx); }); }
async function asUser(callback, verified = true) {
  return db.transaction(async (tx) => {
    await tx.exec("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, session_id: verified ? session : "22000000-0000-4000-8000-000000000099" })]);
    return callback(tx);
  });
}
async function intake(event, lead = { name: "Enquiry", phone: "9876543210", email: "new@example.com" }) {
  return (await service((tx) => tx.query("select public.integration_intake($1,$2,$3::jsonb,$4::jsonb) as result", [source, event, JSON.stringify(lead), JSON.stringify([{ role: "user", content: "Actual chatbot enquiry" }])]))).rows[0].result;
}
test("signed intake RPC matches hidden duplicates without overwriting or reassigning", async () => {
  assert.equal((await asUser((tx) => tx.query("select id from public.leads where id=$1", [hiddenLead]))).rows.length, 0);
  const result = await intake("duplicate");
  assert.equal(result.status, "matched_existing");
  assert.equal(result.lead_id, hiddenLead);
  const lead = (await db.query("select name,assignee_id from public.leads where id=$1", [hiddenLead])).rows[0];
  assert.equal(lead.name, "Hidden lead");
  assert.equal(lead.assignee_id, hidden);
  assert.equal((await db.query("select count(*)::int as count from public.chat_sessions where lead_id=$1", [hiddenLead])).rows[0].count, 1);
});
test("intake retries are persistent and idempotent across events, activities and transcripts", async () => {
  assert.equal((await intake("duplicate")).status, "replayed");
  assert.equal((await db.query("select count(*)::int as count from public.inbound_events where external_event_id='duplicate'")).rows[0].count, 1);
  assert.equal((await db.query("select count(*)::int as count from public.chat_sessions where lead_id=$1", [hiddenLead])).rows[0].count, 1);
});
test("configured email-only duplicate matching and allow policy are respected", async () => {
  await db.exec(`insert into public.crm_settings(setting_key,value) values('lead_configuration','{"duplicateFields":"email","creationPolicy":"block"}')
    on conflict(setting_key) do update set value=excluded.value;`);
  const created = await intake("new-email", { name: "New student", phone: "9876543210", email: "unique@example.com" });
  assert.equal(created.status, "created");
  assert.notEqual(created.lead_id, hiddenLead);
  const lead = (await db.query("select assignee_id from public.leads where id=$1", [created.lead_id])).rows[0];
  assert.equal(lead.assignee_id, owner);
  await db.exec(`update public.crm_settings set value='{"duplicateFields":"phone_email","creationPolicy":"allow"}' where setting_key='lead_configuration'`);
  assert.equal((await intake("allow-duplicate")).status, "created");
});
test("intake requires active configured source/owner and rate limits persist", async () => {
  await db.query("update public.lead_sources set is_active=false where id=$1", [source]);
  await assert.rejects(intake("disabled"), /source unavailable/);
  await db.query("update public.lead_sources set is_active=true where id=$1", [source]);
  await db.query("update public.profiles set status='inactive' where id=$1", [owner]);
  await assert.rejects(intake("inactive-owner"), /active owner/);
  await db.query("update public.profiles set status='active' where id=$1", [owner]);
  for (let i = 0; i < 60; i++) assert.equal((await service((tx) => tx.query("select public.integration_intake_rate($1) as allowed", [source]))).rows[0].allowed, true);
  assert.equal((await service((tx) => tx.query("select public.integration_intake_rate($1) as allowed", [source]))).rows[0].allowed, false);
});
test("intake messages atomically create source-labeled system notes on new and matched leads without retry duplicates", async () => {
  await db.exec(`update public.crm_settings set value='{"duplicateFields":"phone_email","creationPolicy":"block"}' where setting_key='lead_configuration'`);
  const details = { name: "Website student", phone: "9123456780", email: "message@example.com", message: "  Please explain eligibility.\nI am interested in cardiology.  " };
  const created = await intake("message-new", details);
  assert.equal(created.status, "created");
  let notes = (await db.query("select content,user_id from public.notes where lead_id=$1", [created.lead_id])).rows;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].content, "Enquiry from Website chatbot\n\nPlease explain eligibility.\nI am interested in cardiology.");
  assert.equal(notes[0].user_id, null, "external enquiry is not attributed to a counselor");
  assert.equal((await intake("message-new", details)).status, "replayed");
  assert.equal((await db.query("select count(*)::int as n from public.notes where lead_id=$1", [created.lead_id])).rows[0].n, 1);
  const matched = await intake("message-existing", { name: "Do not overwrite", phone: "9876543210", message: "Another enquiry" });
  assert.equal(matched.lead_id, hiddenLead);
  assert.equal(matched.status, "matched_existing");
  assert.equal((await db.query("select assignee_id,name from public.leads where id=$1", [hiddenLead])).rows[0].assignee_id, hidden);
  assert.equal((await db.query("select content from public.notes where lead_id=$1", [hiddenLead])).rows[0].content, "Enquiry from Website chatbot\n\nAnother enquiry");
  assert.equal((await asUser(tx => tx.query("select content from public.notes where lead_id=$1", [hiddenLead]))).rows.length, 0);
  await intake("message-blank", { ...details, message: " \n\t " });
  await intake("message-absent", { name: details.name, phone: details.phone });
  assert.equal((await db.query("select count(*)::int as n from public.notes where lead_id=$1", [created.lead_id])).rows[0].n, 1);
  await assert.rejects(intake("message-too-long", { ...details, message: "x".repeat(10001) }), /Invalid intake message/);
  assert.equal((await db.query("select count(*)::int as n from public.inbound_events where external_event_id='message-too-long'")).rows[0].n, 0);
  // A failure after the note insert rolls back the note, event and newly created lead together.
  await assert.rejects(db.transaction(async tx => {
    await tx.exec("create function public.test_intake_failure() returns trigger language plpgsql as $$ begin raise exception 'test rollback'; end $$; create trigger test_intake_failure before insert on public.chat_sessions for each row execute function public.test_intake_failure(); set local role service_role");
    return tx.query("select public.integration_intake($1,'message-rollback',$2::jsonb,'[]'::jsonb)", [source, JSON.stringify({ name: "Rollback", phone: "9988776655", message: "Must roll back" })]);
  }), /test rollback/);
  assert.equal((await db.query("select count(*)::int as n from public.leads where normalized_phone='9988776655'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*)::int as n from public.notes where content like '%Must roll back%'")).rows[0].n, 0);
  await assert.rejects(asUser(tx => tx.query("insert into public.notes(lead_id,user_id,content) values($1,null,'forged system note')", [created.lead_id])), /row-level security/);
  await db.transaction(async tx => {
    await tx.query("update public.intake_source_settings set channel='website' where source_id=$1", [source]);
    await tx.query("update public.lead_sources set name='DMHCA Website' where id=$1", [source]);
    await tx.exec("set local role service_role");
    await tx.query("select public.integration_intake($1,'website-message',$2::jsonb)", [source, JSON.stringify({ name: "Website visitor", phone: "9123456780", message: "Website contact message" })]);
  });
  assert.equal((await db.query("select content from public.notes where lead_id=$1 order by created_at desc", [created.lead_id])).rows[0].content, "Enquiry from DMHCA Website\n\nWebsite contact message");
  await db.query("update public.intake_source_settings set channel='chatbot' where source_id=$1", [source]);
});
test("intake, OAuth tokens and Gmail writes are inaccessible to direct authenticated clients", async () => {
  for (const sql of ["select * from public.gmail_connections", "select * from public.gmail_oauth_states", "select * from public.intake_source_settings",
    `select public.integration_intake('${source}','forged','{}')`, `select public.integration_set_gmail('${owner}','disconnect')`]) {
    await assert.rejects(asUser((tx) => tx.query(sql)), /permission denied/);
  }
});
test("organization and Page credentials are service-only, including verified users and anonymous callers", async () => {
  const insert = await service(tx => tx.query("insert into public.integration_credentials(provider,encrypted_values,updated_by) values('smtp','ciphertext',$1) returning provider", [admin]));
  assert.equal(insert.rows[0].provider, "smtp");
  await service(tx => tx.query("insert into public.facebook_page_connections(page_id,page_name,encrypted_credentials,created_by) values('12345','Page','ciphertext',$1)", [admin]));
  for (const table of ["integration_credentials", "facebook_page_connections"]) {
    await assert.rejects(asUser(tx => tx.query(`select * from public.${table}`)), /permission denied/);
    await assert.rejects(db.transaction(async tx => { await tx.exec("set local role anon"); return tx.query(`select * from public.${table}`); }), /permission denied/);
    await assert.rejects(asUser(tx => tx.query(`delete from public.${table}`)), /permission denied/);
    assert.equal((await service(tx => tx.query(`select * from public.${table}`))).rows.length, 1);
  }
});
test("Facebook routes allow multiple forms and one catchall per Page, never ambiguous duplicates", async () => {
  let sequence = 0;
  async function route(page, form) {
    return db.transaction(async tx => {
      const result = await tx.query("insert into public.lead_sources(name,api_key_hash) values($1,'hash') returning id", [`Facebook form ${++sequence}`]);
      return tx.query("insert into public.intake_source_settings(source_id,channel,owner_id,created_by,facebook_page_id,facebook_form_id) values($1,'facebook',$2,$3,$4,$5)", [result.rows[0].id, owner, admin, page, form]);
    });
  }
  await route("12345", null);
  await route("12345", "100");
  await route("12345", "200");
  await route("67890", "100");
  await assert.rejects(route("12345", null), error => error.constraint === "intake_facebook_page_catchall_unique");
  await assert.rejects(route("12345", "100"), error => error.constraint === "intake_facebook_page_form_unique");
  const rows = (await db.query("select facebook_form_id from public.intake_source_settings where facebook_page_id='12345'")).rows;
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(row => row.facebook_form_id === null).length, 1);
});
test("Gmail batch commits atomically persist messages, linked email and durable cursor", async () => {
  await service((tx) => tx.query("select public.integration_set_gmail($1,'connect','owner@gmail.com','encrypted-token','100')", [owner]));
  const lock = "2026-10-21T08:00:00.000Z";
  await db.query("update public.gmail_connections set sync_lock_at=$1 where user_id=$2", [lock, owner]);
  const message = { gmail_message_id: "gmail-1", thread_id: "thread", lead_id: hiddenLead, from_email: "hidden@example.com", to_email: "owner@gmail.com",
    subject: "Enquiry", body: "Actual mail", received_at: "2026-10-21T07:00:00Z", in_inbox: true, is_deleted: false, log_email: true };
  await service((tx) => tx.query("select public.integration_commit_gmail($1,$2,$3,'{\"mode\":\"history\"}','101')", [owner, lock, JSON.stringify([message])]));
  assert.equal((await db.query("select history_id from public.gmail_connections where user_id=$1", [owner])).rows[0].history_id, "101");
  assert.equal((await asUser((tx) => tx.query("select * from public.gmail_messages"))).rows.length, 1);
  assert.equal((await asUser((tx) => tx.query("select * from public.gmail_messages"), false)).rows.length, 0);
  assert.equal((await db.query("select count(*)::int as count from public.emails where gmail_message_id='owner@gmail.com:gmail-1'")).rows[0].count, 1);
  await assert.rejects(service((tx) => tx.query("select public.integration_commit_gmail($1,$2,'[]','{}','102')", [owner, lock])), /lease was lost/);
  await db.query("update public.gmail_connections set sync_lock_at=$1 where user_id=$2", [lock, owner]);
  await service((tx) => tx.query("select public.integration_commit_gmail($1,$2,$3,'{\"mode\":\"history\"}','102')", [owner, lock, JSON.stringify([message])]));
  assert.equal((await db.query("select count(*)::int as count from public.emails where gmail_message_id='owner@gmail.com:gmail-1'")).rows[0].count, 1);
  await service((tx) => tx.query("select public.integration_set_gmail($1,'disconnect')", [owner]));
  assert.equal((await db.query("select * from public.gmail_connections")).rows.length, 0);
  assert.equal((await db.query("select * from public.gmail_messages")).rows.length, 0);
});
