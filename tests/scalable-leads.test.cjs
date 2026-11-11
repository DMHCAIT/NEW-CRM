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
    require: name => name in dependencies ? dependencies[name] : require(name), ...globals });
  return exports;
}
class HttpError extends Error { constructor(status,message) { super(message); this.status = status; } }
const auth = { HttpError, jsonError: error => Response.json({ error: error.message },{ status: error.status ?? 500 }) };
const dbError = error => { if (error) throw new HttpError(400,error.message); };
const filters = load("src\\lib\\lead-filters.ts");
const leadQuery = load("src\\lib\\server\\lead-query.ts", {
  "@/lib/server/auth": auth, "@/lib/live-leads": { dbError },
  "@/lib/lead-filters": filters, "@/lib/crm-data": { LEAD_SELECT: "id",mapLead: row => row },
});
const base = () => leadQuery.queryParameters(new URLSearchParams());
const normalized = value => JSON.parse(JSON.stringify(value));

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
        eq: () => chain, returns: async () => ({ data: [{ id: "b" },{ id: "a" }],error: null }) };
      return chain;
    },
  };
  const page = await leadQuery.fetchLeadPage(client,base());
  assert.deepEqual(normalized(page.leads),[{ id: "a" },{ id: "b" }]);
  assert.equal(rpcCalls[0].args.page_size,50);
  assert.deepEqual(normalized(selections),[["a","b"]]);
  client.from = () => ({ select() { return this; }, in() { return this; },eq() { return this; },returns: async () => ({ data: [],error: null }) });
  const empty = await leadQuery.fetchLeadPage(client,base());
  assert.deepEqual(normalized(empty.nextCursor),cursor);
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
