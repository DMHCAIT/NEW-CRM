const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname,"..",file),"utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, { exports, URL, URLSearchParams, TextEncoder, ReadableStream, Response, console,
    require: name => name in dependencies ? dependencies[name]
      : name === "@/lib/server/lead-list" ? load("src\\lib\\server\\lead-list.ts", dependencies)
      : name === "@/lib/server/lead-modifiers" ? load("src\\lib\\server\\lead-modifiers.ts", dependencies)
      : name === "@/lib/lead-filters" ? filters
      : name === "@/lib/supabase/server" ? { getSupabaseAdminClient: () => { throw new Error("Unexpected admin read"); } }
      : require(name), ...globals });
  return exports;
}
class HttpError extends Error { constructor(status,message) { super(message); this.status = status; } }
const auth = { HttpError, jsonError: error => Response.json({ error: error.message },{ status: error.status ?? 500 }) };
const dbError = error => { if (error) throw new HttpError(400,error.message); };
const filters = load("src\\lib\\lead-filters.ts");
const leadQuery = load("src\\lib\\server\\lead-query.ts", {
  "@/lib/server/auth": auth, "@/lib/live-leads": { dbError },
  "@/lib/server/lead-modifiers": { fetchLeadModifiers: async () => [] },
  "@/lib/lead-filters": filters, "@/lib/crm-data": { LEAD_SELECT: "id",mapLead: ({ latest_note, ...row }) => row },
});
const base = () => leadQuery.queryParameters(new URLSearchParams());
const normalized = value => JSON.parse(JSON.stringify(value));

test("modifier lookups read only scoped leads and resolve their editor names in bounded batches", async () => {
  const reads = [];
  let missingProfile = false;
  const leads = Array.from({ length: 1001 }, (_, index) => ({ id: String(index).padStart(4, "0"), modified_by: `editor-${index}` }));
  const admin = { from(table) {
    assert.equal(table, "profiles");
    const chain = { select(columns) { assert.equal(columns, "id,full_name,status,deleted_at"); return chain; },
      in(_column, ids) { reads.push([...ids]); return chain; },
      async returns() { return { data: missingProfile ? [] : reads.at(-1).map(id => ({ id, full_name: `Name ${id}`, status: "active", deleted_at: null })), error: null }; } };
    return chain;
  } };
  const { fetchLeadModifiers } = load("src\\lib\\server\\lead-modifiers.ts", {
    "@/lib/live-leads": { dbError }, "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
  });
  let allowed = null, after = "", failed = false;
  const client = { from(table) {
    assert.equal(table, "leads");
    const chain = { select(columns) { assert.equal(columns, "id,modified_by"); return chain; },
      eq(key, value) { assert.equal(key, "is_archived"); assert.equal(value, false); return chain; },
      not() { return chain; }, order() { return chain; }, limit() { return chain; },
      in(_key, ids) { allowed = ids; return chain; }, gt(_key, value) { after = value; return chain; },
      async returns() { return failed ? { data: null, error: { message: "Lead lookup failed" } }
        : { data: leads.filter(row => (!allowed || allowed.includes(row.id)) && row.id > after).slice(0, 1000), error: null }; } };
    return chain;
  } };
  const rows = await fetchLeadModifiers(client);
  assert.equal(rows.length, 1001);
  assert.equal(reads.length, 11);
  assert.ok(reads.every(ids => ids.length <= 100));
  reads.length = 0; after = "";
  const restricted = await fetchLeadModifiers(client, ["0000"]);
  assert.deepEqual(normalized(restricted), [{ modifier_id: "editor-0", full_name: "Name editor-0", active: true }]);
  assert.deepEqual(reads, [["editor-0"]]);
  missingProfile = true; after = "";
  await assert.rejects(fetchLeadModifiers(client, ["0000"]), /editors changed/);
  failed = true;
  await assert.rejects(fetchLeadModifiers(client), /Lead lookup failed/);
});

test("count editor lookup handles profile pagination and historical duplicate names", async () => {
  const profiles = Array.from({ length: 1001 }, (_, index) => ({
    id: String(index).padStart(4, "0"), full_name: index % 2 ? "Same Editor" : "Other Editor",
  }));
  let reads = 0;
  const admin = { from(table) {
    assert.equal(table, "profiles");
    let after = "";
    const chain = { select: () => chain, order: () => chain, limit: () => chain,
      gt(_key, value) { after = value; return chain; },
      async returns() { reads++; return { data: profiles.filter(row => row.id > after).slice(0, 1000), error: null }; } };
    return chain;
  } };
  const { findMatchingModifierIds } = load("src\\lib\\server\\lead-modifiers.ts", {
    "@/lib/live-leads": { dbError }, "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
  });
  const result = await findMatchingModifierIds([{ field: "modifiedBy", operator: "is", value: "same editor" }], "all");
  assert.equal(result.ids.length, 500);
  assert.equal(result.includeEmpty, false);
  assert.equal(reads, 2);
});

test("lead page resolves inaccessible editor profiles only for returned leads", async () => {
  const calls = [];
  const query = load("src\\lib\\server\\lead-query.ts", {
    "@/lib/server/auth": auth, "@/lib/live-leads": { dbError }, "@/lib/lead-filters": filters,
    "@/lib/crm-data": { LEAD_SELECT: "id", mapLead: row => ({ id: row.id, modifiedBy: row.modifier?.full_name ?? "" }) },
    "@/lib/server/lead-modifiers": { fetchLeadModifiers: async (_client, ids) => {
      calls.push(ids);
      return [{ modifier_id: "outside", full_name: "Outside Editor" }];
    } },
  });
  const client = {
    rpc: async () => ({ data: { ids: ["a", "b"], hasMore: false }, error: null }),
    from: () => {
      const chain = { select: () => chain, in: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
        returns: async () => ({ data: [{ id: "a", modified_by: "outside", modifier: null }, { id: "b", modified_by: "visible", modifier: { full_name: "Visible" } }], error: null }) };
      return chain;
    },
  };
  const page = await query.fetchLeadPage(client, query.queryParameters(new URLSearchParams()));
  assert.deepEqual(normalized(calls), [["a"]]);
  assert.deepEqual(normalized(page.leads.map(lead => lead.modifiedBy)), ["Outside Editor", "Visible"]);
});

test("read-only modifier filtering preserves scope, conditions, counts and pagination", async () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({
    id: String(i).padStart(4, "0"), name: `Lead ${i}`, created_at: "2026-10-20T00:00:00Z",
    next_followup_at: null, modified_by: i % 2 ? "outside" : "other", stage: i % 3 ? "Cold" : "Warm", modifier: null,
  }));
  const modifierNames = [{ modifier_id: "outside", full_name: "Outside Editor" }, { modifier_id: "other", full_name: "Other Editor" }];
  const query = load("src\\lib\\server\\lead-query.ts", {
    "@/lib/server/auth": auth, "@/lib/live-leads": { dbError }, "@/lib/lead-filters": filters,
    "@/lib/crm-data": { LEAD_SELECT: "id", mapLead: row => ({ ...row, modifiedBy: "" }) },
    "@/lib/server/lead-modifiers": {
      fetchLeadModifiers: async () => modifierNames,
      findMatchingModifierIds: async criteria => ({
        ids: modifierNames.filter(item => criteria.every(c => filters.matchesTextCriterion(item.full_name, c))).map(item => item.modifier_id),
        includeEmpty: criteria.every(c => filters.matchesTextCriterion("", c)),
      }),
    },
  });
  const client = {
    async rpc(name, args) {
      assert.equal(name, "crm_lead_page");
      assert.ok(args.filter_json.criteria.every(criterion => criterion.field !== "modifiedBy"));
      let candidates = rows.filter(row => !args.after_id || row.id > args.after_id);
      if (args.filter_json.criteria.length) candidates = candidates.filter(row => row.stage === "Warm");
      candidates = candidates.slice(args.page_offset);
      const shown = candidates.slice(0, args.page_size);
      const last = shown.at(-1);
      return { data: { ids: shown.map(row => row.id), hasMore: candidates.length > args.page_size,
        nextCursor: last ? { id: last.id, createdAt: last.created_at, name: last.name, followUpAt: null } : null }, error: null };
    },
    from(table) {
      assert.equal(table, "leads");
      let ids = [];
      let countOnly = false, modifierIds = null;
      const chain = { select(_columns, options) { countOnly = Boolean(options?.head); return chain; },
        in(key, values) { if (key === "modified_by") modifierIds = values; else ids = values; return chain; }, eq: () => chain,
        is() { modifierIds = [null]; return chain; },
        order: () => chain, limit: () => chain,
        returns: async () => ({ data: rows.filter(row => ids.includes(row.id)), error: null }),
        then(resolve) { assert.ok(countOnly); return Promise.resolve({ count: rows.filter(row => modifierIds.includes(row.modified_by)).length, error: null }).then(resolve); },
      };
      return chain;
    },
  };
  const modifier = { id: "m", field: "modifiedBy", operator: "is", value: "Outside Editor" };
  const stage = { id: "s", field: "stage", operator: "is", value: "Warm" };
  const makeQuery = (criteria, matchMode = "all") => ({ ...query.queryParameters(new URLSearchParams()),
    filter: { ...base().filter, criteria, matchMode } });
  const all = makeQuery([modifier, stage]);
  const expectedAll = rows.filter(row => row.modified_by === "outside" && row.stage === "Warm").map(row => row.id);
  const first = await query.fetchLeadPage(client, all, 10);
  assert.deepEqual(normalized(first.leads.map(row => row.id)), expectedAll.slice(0, 10));
  assert.equal(first.hasMore, true);
  const next = await query.fetchLeadPage(client, { ...all, cursor: first.nextCursor }, 10);
  assert.deepEqual(normalized(next.leads.map(row => row.id)), expectedAll.slice(10, 20));
  const shifted = await query.fetchLeadPage(client, { ...all, offset: 7 }, 10);
  assert.deepEqual(normalized(shifted.leads.map(row => row.id)), expectedAll.slice(7, 17));
  assert.equal((await query.fetchLeadPage(client, { ...all, countOnly: true })).total, expectedAll.length);
  const any = makeQuery([modifier, stage], "any");
  const expectedAny = rows.filter(row => row.modified_by === "outside" || row.stage === "Warm").map(row => row.id);
  assert.equal((await query.fetchLeadPage(client, { ...any, countOnly: true })).total, expectedAny.length);
  assert.deepEqual(normalized((await query.fetchLeadPage(client, { ...any, offset: 98 }, 10)).leads.map(row => row.id)), expectedAny.slice(98, 108));
  const not = makeQuery([{ ...modifier, operator: "is_not" }]);
  assert.equal((await query.fetchLeadPage(client, { ...not, countOnly: true })).total, 103);
});

test("modifier-only counts use scoped exact counts without transferring lead rows", async () => {
  const rows = Array.from({ length: 2505 }, (_, i) => ({
    id: String(i).padStart(4, "0"), modified_by: [null, "outside", "old"][i % 3],
    assignee_id: i % 2 ? "me" : "other",
  }));
  const profiles = [
    { id: "outside", full_name: "Outside Editor", status: "active", deleted_at: null },
    { id: "old", full_name: "Former Editor", status: "inactive", deleted_at: null },
  ];
  let leadReads = 0, profileReads = 0, failed = false;
  const admin = { from(table) {
    assert.equal(table, "profiles");
    const chain = { select: () => chain, order: () => chain, limit: () => chain,
      gt: () => chain,
      returns: async () => { profileReads++; return { data: profiles, error: null }; } };
    return chain;
  } };
  const modifiers = load("src\\lib\\server\\lead-modifiers.ts", {
    "@/lib/live-leads": { dbError }, "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
  });
  const query = load("src\\lib\\server\\lead-query.ts", {
    "@/lib/server/auth": auth, "@/lib/live-leads": { dbError }, "@/lib/lead-filters": filters,
    "@/lib/server/lead-modifiers": modifiers, "@/lib/crm-data": { LEAD_SELECT: "id", mapLead: row => row },
  });
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "me" } }, error: null }) },
    rpc: async () => assert.fail("Modifier-only count must not paginate the page RPC"),
    from(table) {
      assert.equal(table, "leads");
      let owner, selected;
      const chain = { select(_columns, options) { assert.deepEqual(normalized(options), { count: "exact", head: true }); return chain; },
        eq(key, value) { if (key === "assignee_id") owner = value; return chain; },
        in(key, ids) { assert.equal(key, "modified_by"); selected = ids; return chain; },
        is(key, value) { assert.equal(key, "modified_by"); selected = [value]; return chain; },
        then(resolve) {
          leadReads++;
          return Promise.resolve(failed ? { count: null, error: { message: "Scoped count failed" } }
            : { count: rows.filter(row => selected.includes(row.modified_by) && (!owner || row.assignee_id === owner)).length, error: null }).then(resolve);
        } };
      return chain;
    },
  };
  const criterion = (operator, value = "") => ({ id: operator, field: "modifiedBy", operator, value });
  const count = async (criteria, matchMode = "all", quickView = "All accessible leads") => {
    leadReads = 0;
    const result = await query.fetchLeadPage(client, {
      ...query.queryParameters(new URLSearchParams()), countOnly: true,
      filter: { ...base().filter, criteria, matchMode, quickView },
    });
    return result.total;
  };
  assert.equal(await count([criterion("is", "outside editor")]), 835);
  assert.equal(leadReads, 1, "2,505 leads require one scoped count and no lead-row reads");
  assert.equal(profileReads, 1);
  assert.equal(await count([criterion("is_empty")]), 835);
  assert.equal(await count([criterion("is_not", "Outside Editor")]), 1670);
  assert.equal(await count([criterion("is", "Former Editor")]), 835);
  assert.equal(await count([criterion("is_empty"), criterion("is", "Outside Editor")], "any"), 1670);
  assert.equal(await count([criterion("is", "Outside Editor")], "all", "My Leads"),
    rows.filter(row => row.assignee_id === "me" && row.modified_by === "outside").length);
  assert.equal(leadReads, 1);
  failed = true;
  await assert.rejects(count([criterion("is", "Outside Editor")]), /Scoped count failed/);
});

test("modifier-only counts split large editor sets without losing matches", async () => {
  const ids = Array.from({ length: 201 }, (_, index) => `editor-${index}`);
  const batches = [];
  const query = load("src\\lib\\server\\lead-query.ts", {
    "@/lib/server/auth": auth, "@/lib/live-leads": { dbError }, "@/lib/lead-filters": filters,
    "@/lib/server/lead-modifiers": { findMatchingModifierIds: async () => ({ ids, includeEmpty: false }) },
    "@/lib/crm-data": { LEAD_SELECT: "id", mapLead: row => row },
  });
  const client = { from() {
    let selected;
    const chain = { select: () => chain, eq: () => chain,
      in(_column, values) { selected = values; batches.push(values); return chain; },
      then(resolve) { return Promise.resolve({ count: selected.length, error: null }).then(resolve); } };
    return chain;
  } };
  const params = query.queryParameters(new URLSearchParams());
  const filter = { ...params.filter, criteria: [{ id: "m", field: "modifiedBy", operator: "is", value: "Editor" }] };
  assert.equal((await query.fetchLeadPage(client, { ...params, filter, countOnly: true })).total, 201);
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 1]);
});

test("lead query parsing rejects malformed filters, cursors, timezone, offsets and unsupported sorts", () => {
  for (const params of [
    { filter: "not-json" }, { filter: "{}" }, { cursor: "{}" }, { cursor: "null!" },
    { timezone: "not/a-zone" }, { offset: "-1" }, { offset: "1.5" }, { sort: "random" },
    { sort: "name",cursor: JSON.stringify({ id: "42000000-0000-4000-8000-000000000001",createdAt: "2026-10-20T00:00:00Z" }) },
    { filter: JSON.stringify({ ...base().filter,criteria: [{ id: "",field: "createdAt",operator: "between",value: "2026-10-20",secondValue: "2026-10-01" }] }) },
  ]) assert.throws(() => leadQuery.queryParameters(new URLSearchParams(params)),error => error.status === 400);
});

test("relative filter days follow the browser timezone while dashboard queries remain UTC", () => {
  const filter = { ...base().filter,criteria: [{ id: "",field: "createdAt",operator: "today",value: "" }] };
  const now = new Date("2026-10-25T20:00:00Z");
  const local = leadQuery.databaseFilter(filter,"Asia/Kolkata",false,now);
  assert.equal(local.criteria[0].value,"2026-10-26");
  assert.equal(local.criteria[0].secondValue,"2026-10-26");
  assert.equal(local.criteria[0].operator,"between");
  assert.equal(leadQuery.databaseFilter(filter,"UTC",true,now).criteria[0].value,"2026-10-25");
  const overdue = leadQuery.databaseFilter({ ...filter,criteria: [{ id: "",field: "followUpAt",operator: "overdue",value: "" }] },"Asia/Kolkata",false,now);
  assert.equal(overdue.criteria[0].operator,"before");
  assert.equal(overdue.criteria[0].value,"2026-10-26");
});

test("Most Recent Visits source selections reach SQL as source conditions without dates", () => {
  for (const operator of ["is", "in"]) {
    const filter = { ...base().filter, criteria: [{
      id: "recent", field: "recentVisitSource", operator,
      value: operator === "is" ? "DMHCA-Chatbot" : "Website\nWebsite-IBMP",
    }] };
    const parsed = leadQuery.parseQueryFilter(filter);
    const converted = leadQuery.databaseFilter(parsed, "Asia/Kolkata");
    assert.equal(converted.criteria[0].field, "source");
    assert.equal(converted.criteria[0].operator, operator);
    assert.equal(converted.criteria[0].value, filter.criteria[0].value);
  }
});

test("paged reads fetch only returned IDs, preserve SQL order, and keep a cursor even if a lead is archived between queries", async () => {
  const rpcCalls = [], selections = [];
  const cursor = { id: "b",createdAt: "2026-10-20T00:00:00Z",name: "Beta",followUpAt: null };
  const client = {
    rpc: async (name,args) => { rpcCalls.push({ name,args }); return { data: { ids: ["a","b"],hasMore: true,nextCursor: cursor },error: null }; },
    from: table => {
      assert.equal(table,"leads");
      const chain = { select: () => chain, in: (_key,ids) => { selections.push(ids); return chain; },
        eq: () => chain, order: () => chain, limit: () => chain,
        returns: async () => ({ data: [{ id: "b" },{ id: "a" }],error: null }) };
      return chain;
    },
  };
  const page = await leadQuery.fetchLeadPage(client,base());
  assert.deepEqual(normalized(page.leads),[{ id: "a" },{ id: "b" }]);
  assert.equal(rpcCalls[0].args.page_size,50);
  assert.deepEqual(normalized(selections),[["a","b"]]);
  client.from = () => ({ select() { return this; }, in() { return this; },eq() { return this; },
    order() { return this; }, limit() { return this; }, returns: async () => ({ data: [],error: null }) });
  const empty = await leadQuery.fetchLeadPage(client,base());
  assert.deepEqual(normalized(empty.nextCursor),cursor);
});

test("lead pages fetch only the newest note per lead without truncating the lead page or issuing per-row requests", async () => {
  const { createClient } = require("@supabase/supabase-js");
  const requests = [];
  let failNotes = false;
  const client = createClient("https://database.example.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async input => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      if (url.pathname.endsWith("/rpc/crm_lead_page")) return Response.json({ ids: ["a", "b", "c"], hasMore: false });
      assert.equal(url.pathname, "/rest/v1/leads");
      assert.equal(url.searchParams.get("select"), "id,latest_note:notes(content)");
      assert.equal(url.searchParams.get("latest_note.order"), "created_at.desc,id.desc");
      assert.equal(url.searchParams.get("latest_note.limit"), "1");
      assert.equal(url.searchParams.has("limit"), false, "the note limit must not limit the lead page");
      assert.equal(url.searchParams.get("is_archived"), "eq.false");
      if (failNotes) return Response.json({ message: "Note access failed", code: "42501" }, { status: 403 });
      return Response.json([
        { id: "b", latest_note: [] },
        { id: "c", latest_note: [{ content: "" }] },
        { id: "a", latest_note: [{ content: "Latest note\nCall after 5 PM" }] },
      ]);
    } },
  });
  const page = await leadQuery.fetchLeadPage(client, base(), 100);
  assert.deepEqual(normalized(page.leads), [
    { id: "a", latestNote: "Latest note\nCall after 5 PM" },
    { id: "b" },
    { id: "c", latestNote: "Image attachment" },
  ]);
  assert.equal(requests.length, 2, "one bounded IDs request and one embedded record read, not one note read per lead");
  failNotes = true;
  await assert.rejects(leadQuery.fetchLeadPage(client, base()), /Note access failed/);
});

test("count-only reads never request lead records and database failures are not disguised as empty results", async () => {
  const result = await leadQuery.fetchLeadPage({
    rpc: async () => ({ data: { ids: [],hasMore: false,total: 1000000 },error: null }),
    from: () => { throw new Error("Count queries must not fetch lead records"); },
  },{ ...base(),countOnly: true });
  assert.equal(result.total,1000000);
  await assert.rejects(leadQuery.fetchLeadPage({ rpc: async () => ({ error: { message: "Migration required" } }) },base()),/Migration required/);
  await assert.rejects(leadQuery.fetchLeadPage({ rpc: async () => ({ data: { ids: Array(51).fill("id"),hasMore: false },error: null }) },base()),/Invalid lead query response/);
});

test("twelve pipeline stages share three bounded record reads instead of one read per stage", async () => {
  const rpcCalls = [], selections = [];
  const queries = Array.from({ length: 12 }, (_, index) => ({ ...base(), stage: `stage-${index}` }));
  const client = {
    rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      const ids = Array.from({ length: 25 }, (_, index) => `${args.stage_filter}-${index}`);
      return { data: { ids, hasMore: true, nextCursor: { id: ids[24], createdAt: "2026-10-20T00:00:00Z", name: args.stage_filter, followUpAt: null } }, error: null };
    },
    from: table => {
      assert.equal(table, "leads");
      let ids;
      const chain = { select: () => chain, in: (key, values) => { assert.equal(key, "id"); ids = values; selections.push([...values]); return chain; },
        eq: (key, value) => { assert.equal(key, "is_archived"); assert.equal(value, false); return chain; },
        returns: async () => ({ data: [...ids].reverse().filter(id => id !== "stage-2-3").map(id => ({ id })), error: null }) };
      return chain;
    },
  };
  const pages = await leadQuery.fetchLeadPages(client, queries, 25);
  assert.equal(rpcCalls.length, 12);
  assert.ok(rpcCalls.every(call => call.args.page_size === 25));
  assert.equal(selections.length, 3, "record reads reduced by 75% for twelve stages");
  assert.ok(selections.every(ids => ids.length <= 100), "PostgREST URLs and responses stay bounded");
  assert.equal(pages.length, 12);
  for (let index = 0; index < pages.length; index++) {
    const expected = Array.from({ length: 25 }, (_, row) => `stage-${index}-${row}`).filter(id => id !== "stage-2-3");
    assert.deepEqual(normalized(pages[index].leads.map(lead => lead.id)), expected);
    assert.equal(pages[index].hasMore, true);
    assert.equal(pages[index].nextCursor.id, `stage-${index}-24`);
  }
});

test("pipeline batch reads deduplicate IDs, skip empty stages and surface SQL or hydration failures", async () => {
  let reads = 0;
  const client = {
    rpc: async (_name, args) => ({ data: { ids: args.stage_filter === "empty" ? [] : ["shared"], hasMore: false }, error: null }),
    from: () => {
      const chain = { select: () => chain, in: (_key, ids) => { assert.deepEqual(normalized(ids), ["shared"]); return chain; }, eq: () => chain,
        returns: async () => { reads++; return { data: [{ id: "shared" }], error: null }; } };
      return chain;
    },
  };
  const pages = await leadQuery.fetchLeadPages(client, ["first", "second", "empty"].map(stage => ({ ...base(), stage })));
  assert.equal(reads, 1);
  assert.equal(pages[0].leads[0].id, "shared");
  assert.equal(pages[1].leads[0].id, "shared");
  assert.equal(pages[2].leads.length, 0);
  await leadQuery.fetchLeadPages(client, [{ ...base(), stage: "empty" }]);
  assert.equal(reads, 1);
  client.from = () => ({ select() { return this; }, in() { return this; }, eq() { return this; },
    returns: async () => ({ error: { message: "Record access failed" } }) });
  await assert.rejects(leadQuery.fetchLeadPages(client, [base()]), /Record access failed/);
  client.rpc = async () => ({ error: { message: "Stage query failed" } });
  await assert.rejects(leadQuery.fetchLeadPages(client, [base()]), /Stage query failed/);
});

test("pipeline starts stage pages before slow profiles finish and never reads unused lead preferences", async () => {
  const events = [];
  let finishProfiles, finishPages;
  const route = load("src\\app\\api\\leads\\route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/crm-data": {
      fetchStages: async () => [{ id: "fresh" }, { id: "won" }],
      fetchProfiles: () => new Promise(resolve => { events.push("profiles"); finishProfiles = resolve; }),
    },
    "@/lib/server/auth": { ...auth, requireUser: async permission => {
      assert.equal(permission, "pipeline.view");
      return { user: { id: "actor" }, supabase: { from: () => { throw new Error("Unused metadata read"); } } };
    } },
    "@/lib/live-leads": { fetchLeadConfiguration: () => { throw new Error("Pipeline does not use lead configuration"); } },
    "@/lib/server/login": {}, "@/lib/lead-filters": filters,
    "@/lib/server/lead-query": { queryParameters: leadQuery.queryParameters, fetchLeadPages: (_client, queries, size) => {
      assert.equal(size, 25);
      events.push("pages");
      assert.deepEqual(normalized(queries.map(query => query.stage)), ["fresh", "won", "__none"]);
      return new Promise(resolve => { finishPages = resolve; });
    } },
  });
  const response = route.GET(new Request("https://crm.example/api/leads?view=pipeline"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["profiles", "pages"], "pipeline reads do not wait for profiles or saved configuration");
  finishPages([
    { leads: [{ id: "first" }], hasMore: true, nextCursor: { id: "first", createdAt: "2026-10-20T00:00:00Z" } },
    { leads: [], hasMore: false, nextCursor: null }, { leads: [], hasMore: false, nextCursor: null },
  ]);
  finishProfiles([{ id: "owner" }]);
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "private, no-store");
  assert.match(result.headers.get("Server-Timing"), /auth;dur=\d+, data;dur=\d+/);
  const data = await result.json();
  assert.equal(data.stagePages[0].stage, "fresh");
  assert.equal(data.stagePages[0].hasMore, true);
  assert.equal(data.stagePages[0].nextCursor.id, "first");
  assert.deepEqual(data.leads, [{ id: "first" }]);
  assert.equal("configuration" in data, false);
  assert.equal("filters" in data, false);
  assert.equal("columns" in data, false);
});

test("editor choices are loaded separately with lead permission and include only active editors", async () => {
  const scopedClient = {};
  let allowed = true, reads = 0;
  const route = load("src\\app\\api\\leads\\route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/crm-data": {}, "@/lib/server/login": {}, "@/lib/live-leads": {},
    "@/lib/server/auth": { ...auth, requireUser: async permission => {
      assert.equal(permission, "leads.view");
      if (!allowed) throw new HttpError(403, "Lead access required");
      return { user: { id: "actor" }, supabase: scopedClient };
    } },
    "@/lib/server/lead-query": {},
    "@/lib/server/lead-modifiers": { fetchLeadModifiers: async client => {
      assert.equal(client, scopedClient);
      reads++;
      return [
        { modifier_id: "one", full_name: "Outside editor", active: true },
        { modifier_id: "two", full_name: "Inactive editor", active: false },
      ];
    } },
  });
  const response = await route.GET(new Request("https://crm.example/api/leads?view=modifiers"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { modifiers: ["Outside editor"] });
  allowed = false;
  assert.equal((await route.GET(new Request("https://crm.example/api/leads?view=modifiers"))).status, 403);
  assert.equal(reads, 1, "denied callers must not load editor names");
});

test("shared lead list loader bounds records, scopes preferences to the actor and reports metadata failures", async () => {
  const scopes = [];
  const actor = { id: "actor" };
  let reads = 0, invalidFilter = false, columnError = null;
  const client = { from: table => {
    assert.ok(["saved_filters", "user_columns"].includes(table));
    const chain = {
      select: () => chain,
      eq(key, value) { scopes.push({ table, key, value }); return chain; },
      order: async () => ({ data: [{ id: "saved", name: "Saved", filter_json: invalidFilter ? {} : base().filter, pinned_to_dashboard: false }], error: null }),
      maybeSingle: async () => ({ data: { columns_json: ["name"] }, error: columnError }),
    };
    return chain;
  } };
  const query = base();
  const { fetchLeadListData } = load("src\\lib\\server\\lead-list.ts", {
    "@/lib/crm-data": {
      fetchStages: async supabase => { assert.equal(supabase, client); return []; },
      fetchProfiles: async supabase => { assert.equal(supabase, client); return []; },
    },
    "@/lib/lead-filters": filters, "@/lib/server/auth": auth,
    "@/lib/server/lead-modifiers": { fetchLeadModifiers: async () => { throw new Error("Initial page must not scan editors"); } },
    "@/lib/live-leads": { dbError, fetchLeadConfiguration: async supabase => { assert.equal(supabase, client); return { fields: [] }; } },
    "@/lib/server/lead-query": { fetchLeadPage: async (supabase, actualQuery, size) => {
      reads++;
      assert.equal(supabase, client);
      assert.equal(actualQuery, query);
      assert.equal(size, 100);
      return { leads: [{ id: "accessible-lead" }], hasMore: false, nextCursor: null };
    } },
  });
  const result = await fetchLeadListData(client, actor, query, 100);
  assert.equal(result.leads[0].id, "accessible-lead");
  assert.equal(result.user, actor);
  assert.deepEqual(normalized(result.modifiers), []);
  assert.deepEqual(normalized(result.columns), ["name"]);
  assert.deepEqual(scopes, [
    { table: "saved_filters", key: "owner_id", value: actor.id },
    { table: "user_columns", key: "user_id", value: actor.id },
    { table: "user_columns", key: "view_name", value: "leads" },
  ]);
  assert.equal((await fetchLeadListData(client, actor, query, 100, true)).leads.length, 0);
  assert.equal(reads, 1, "metadata-only reads must still avoid querying records");
  invalidFilter = true;
  await assert.rejects(fetchLeadListData(client, actor, query, 100), /invalid configuration/);
  invalidFilter = false;
  columnError = { message: "Preferences unavailable" };
  await assert.rejects(fetchLeadListData(client, actor, query, 100), /Preferences unavailable/);
});

test("new/import metadata requests never invoke the lead query", async () => {
  let queries = 0;
  const route = load("src\\app\\api\\leads\\route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/crm-data": { fetchStages: async () => [],fetchProfiles: async () => [] },
    "@/lib/server/auth": { ...auth,requireUser: async () => ({ user: { id: "actor" },supabase: { from: () => {
      const chain = { select: () => chain,eq: () => chain,order: async () => ({ data: [],error: null }),
        maybeSingle: async () => ({ data: null,error: null }) };
      return chain;
    } } }) },
    "@/lib/live-leads": { dbError,fetchLeadConfiguration: async () => ({ fields: [] }) },
    "@/lib/server/login": {}, "@/lib/lead-filters": filters,
    "@/lib/server/lead-query": { queryParameters: leadQuery.queryParameters,fetchLeadPage: async () => { queries++; throw new Error("Unexpected full lead read"); } },
  });
  const result = await route.GET(new Request("https://crm.example/api/leads?metadata=only"));
  assert.equal(result.status,200);
  assert.equal(queries,0);
  assert.deepEqual((await result.json()).leads,[]);
});

test("lead API accepts only the supported page sizes and forwards the selected size", async () => {
  let pageSize = 0, pageReads = 0;
  const route = load("src\\app\\api\\leads\\route.ts", {
    "next/server": { NextResponse: Response },
    "@/lib/crm-data": {},
    "@/lib/server/auth": { ...auth, requireUser: async permission => {
      assert.equal(permission, "leads.view");
      return { user: { id: "actor" }, supabase: {} };
    } },
    "@/lib/live-leads": {},
    "@/lib/server/login": {},
    "@/lib/lead-filters": filters,
    "@/lib/server/lead-query": {
      queryParameters: leadQuery.queryParameters,
      fetchLeadPage: async (_client, _query, size) => {
        pageSize = size;
        pageReads++;
        return { leads: [], hasMore: false, nextCursor: null };
      },
    },
  });
  const valid = await route.GET(new Request("https://crm.example/api/leads?metadata=0&pageSize=20"));
  assert.equal(valid.status, 200);
  assert.equal(pageSize, 20);
  const invalid = await route.GET(new Request("https://crm.example/api/leads?metadata=0&pageSize=25"));
  assert.equal(invalid.status, 400);
  assert.equal(pageReads, 1);
});

const reports = load("src\\lib\\reports.ts",{ "@/lib/lead-filters": filters });
function exporter(pages, failureAt = -1) {
  const calls = [], errors = [];
  const module = load("src\\lib\\server\\lead-export.ts", {
    "@/lib/reports": reports, "@/lib/server/lead-query": { fetchLeadPage: async (_client,query,size) => {
      const index = calls.length;
      calls.push({ query,size });
      if (index === failureAt) throw new Error("Session revoked");
      return pages[index];
    } },
  },{ console: { error: (...args) => errors.push(args) } });
  return { ...module,calls,errors };
}
const report = { id: "",name: "Leads",columns: ["name","phone"],filter: {} };

test("streamed exports include every row, one header and spreadsheet escaping in bounded batches", async () => {
  const rows = [{ name: "Alpha,\nBeta",phone: "+919876543210" },{ name: "=formula()",phone: "1234567890" }];
  const cursor = { id: "a",createdAt: "2026-10-20T00:00:00Z" };
  const api = exporter([
    { leads: [rows[0]],hasMore: true,nextCursor: cursor },
    { leads: [rows[1]],hasMore: true,nextCursor: { ...cursor,id: "b" } },
    { leads: [],hasMore: false,nextCursor: null },
  ]);
  const response = await api.leadCsvResponse({},base(),report,"leads.csv",new AbortController().signal);
  assert.equal(await response.text(),reports.reportCsv(report,rows,"list"));
  assert.ok(api.calls.every(call => call.size === 100));
  assert.deepEqual(api.calls[1].query.cursor,cursor);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
});

test("an export failing after its first batch terminates the download and logs the failure", async () => {
  const api = exporter([{ leads: [{ name: "Alpha" }],hasMore: true,nextCursor: { id: "a",createdAt: "2026-10-20T00:00:00Z" } }],1);
  const response = await api.leadCsvResponse({},base(),report,"leads.csv",new AbortController().signal);
  await assert.rejects(response.text(),/Session revoked/);
  assert.equal(api.errors.length,1);
});
