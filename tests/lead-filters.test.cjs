const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = readFileSync(join(__dirname, "..", "src", "lib", "lead-filters.ts"), "utf8");
const api = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText, { exports: api, Date });
const now = new Date(2026, 9, 19, 12);
const base = {
  id: "1", name: "Aarav Mehta", phone: "+91 (98765) 43210", email: "Aarav@Example.com",
  country: "Canada", course: "MBA", qualification: "Degree", stage: "Warm",
  source: "Website form", assignee: "Jordan Davis", followUp: "Today",
  followUpAt: "2026-10-19", createdAt: "2026-10-01", modifiedAt: "2026-10-01",
  modifiedBy: "Jordan Davis", lastVisitAt: "2026-10-19", closureFee: 0,
};
const criterion = (field, operator, value = "", secondValue) => ({ id: "c", field, operator, value, secondValue });
const filter = (criteria, matchMode = "all", query = "") => ({ criteria, matchMode, query, quickView: "All accessible leads" });
const matches = (field, operator, value = "", lead = base, secondValue) =>
  api.filterLeads([lead], filter([criterion(field, operator, value, secondValue)]), now).length === 1;

test("all requested fields are available and operator menus are field-specific", () => {
  for (const label of ["Lead name", "Phone", "Email", "Country", "Course", "Follow up", "Qualification", "Lead source", "Lead stage", "Created", "Modified", "Last Modified", "Untouched", "Most Recent Visits"]) {
    assert.ok(api.FILTER_FIELDS.some((field) => field.label === label), label);
  }
  assert.ok(api.operatorsForField("name").some((op) => op.value === "contains"));
  assert.ok(!api.operatorsForField("name").some((op) => op.value === "before"));
  assert.ok(!api.operatorsForField("createdAt").some((op) => op.value === "contains"));
  assert.ok(api.operatorsForField("followUpAt").some((op) => op.value === "overdue"));
  assert.ok(!api.operatorsForField("createdAt").some((op) => op.value === "overdue"));
  assert.equal(api.operatorsForField("untouched").map((op) => op.value).join(","), "is_true,is,before,after,between,custom_date");
});

test("text, normalized phones, choices, empty values and negatives", () => {
  for (const [field, op, value] of [
    ["name", "is", " aarav MEHTA "], ["name", "is_not", "Sana"],
    ["name", "contains", "MEHTA"], ["name", "not_contains", "Sana"],
    ["name", "begins_with", "Aarav"], ["name", "ends_with", "Mehta"],
    ["phone", "is", "919876543210"], ["phone", "contains", "98765 432"],
    ["email", "is", "aarav@example.com"], ["country", "in", " Ireland \n Canada "],
    ["course", "not_in", "MSc\nBSc"], ["qualification", "contains", "gree"],
    ["source", "is", "Website form"], ["modifiedBy", "is", "Jordan Davis"],
    ["name", "is_not_empty", ""],
  ]) assert.ok(matches(field, op, value), `${field} ${op}`);
  assert.ok(matches("email", "is_empty", "", { ...base, email: "   " }));
  assert.ok(!matches("country", "not_in", "Canada\nIreland"));
});

test("calendar dates, inclusive/exclusive boundaries and date negation", () => {
  for (const [op, value, second] of [
    ["is", "2026-10-19"], ["is_not", "2026-10-18"], ["before", "2026-10-20"],
    ["after", "2026-10-18"], ["on_or_before", "2026-10-19"], ["on_or_after", "2026-10-19"],
    ["between", "2026-10-19", "2026-10-20"], ["not_between", "2026-10-01", "2026-10-18"],
    ["custom_date", "2026-10-19"], ["today", ""], ["this_week", ""], ["this_month", ""],
    ["last_days", "1"], ["next_days", "1"],
  ]) assert.ok(matches("followUpAt", op, value, base, second), op);
  for (const op of ["yesterday", "tomorrow", "last_week", "next_week", "last_month", "next_month", "overdue"]) {
    assert.ok(!matches("followUpAt", op), op);
  }
  assert.ok(matches("followUpAt", "overdue", "", { ...base, followUpAt: "2026-10-18" }));
  assert.ok(matches("followUpAt", "last_week", "", { ...base, followUpAt: "2026-10-18" }));
  assert.ok(matches("followUpAt", "next_week", "", { ...base, followUpAt: "2026-10-26" }));
  assert.ok(matches("followUpAt", "last_month", "", { ...base, followUpAt: "2026-09-30" }));
  assert.ok(matches("followUpAt", "next_month", "", { ...base, followUpAt: "2026-11-01" }));
  assert.ok(matches("followUpAt", "last_days", "7", { ...base, followUpAt: "2026-10-13" }));
  assert.ok(!matches("followUpAt", "last_days", "7", { ...base, followUpAt: "2026-10-12" }));
  assert.ok(!matches("followUpAt", "is_not", "2026-10-19", { ...base, followUpAt: undefined }));
  assert.ok(matches("followUpAt", "is_empty", "", { ...base, followUpAt: undefined }));
});

test("website visits exclude non-website, missing and invalid visits for all operators", () => {
  for (const source of ["Manual", "Google Ads", "Referral", "WhatsApp", "Chatbot"]) {
    for (const op of ["today", "is_not_empty", "is_empty"]) assert.ok(!matches("lastVisitAt", op, "", { ...base, source }));
    assert.ok(!matches("lastVisitAt", "is_not", "2026-10-01", { ...base, source }));
  }
  for (const lastVisitAt of [undefined, "", "not-a-date", "2026-02-30", "2026-02-30T10:00:00Z"]) assert.ok(!matches("lastVisitAt", "is_not_empty", "", { ...base, lastVisitAt }));
  assert.ok(matches("lastVisitAt", "today"));
  assert.ok(matches("lastVisitAt", "today", "", { ...base, source: " WEBSITE FORM " }));
});

test("untouched uses recorded edit state and does not invent unknown history", () => {
  assert.ok(matches("untouched", "is_true"));
  assert.ok(matches("untouched", "is_false", "", { ...base, modifiedAt: "2026-10-19" }));
  assert.ok(matches("untouched", "is_false", "", { ...base, hasBeenEdited: true }));
  assert.ok(matches("untouched", "is_true", "", { ...base, hasBeenEdited: false }));
  for (const op of ["is_true", "is_false"]) assert.ok(!matches("untouched", op, "", { ...base, createdAt: undefined }));
  assert.ok(matches("untouched", "is_true", "", { ...base, createdAt: "2026-10-19T00:00:00Z", modifiedAt: "2026-10-19T05:30:00+05:30" }));
});

test("invalid, incomplete, reversed or unsupported conditions fail explicitly", () => {
  for (const c of [
    criterion("createdAt", "contains", "2026"), criterion("createdAt", "is", "2026-02-30"),
    criterion("createdAt", "between", "2026-10-20", "2026-10-19"),
    criterion("createdAt", "between", "2026-10-19"), criterion("name", "contains"),
    criterion("followUpAt", "last_days", "0"), criterion("followUpAt", "last_days", "1.5"),
    criterion("phone", "contains", "---"), criterion("untouched", "is", "yes"),
  ]) assert.throws(() => api.filterLeads([base], filter([c]), now), c.operator);
});

test("all/any, global search, quick view, archived records and empty result sets", () => {
  const conditions = [criterion("stage", "is", "Warm"), criterion("country", "is", "Ireland")];
  assert.equal(api.filterLeads([base], filter(conditions), now).length, 0);
  assert.equal(api.filterLeads([base], filter(conditions, "any"), now).length, 1);
  assert.equal(api.filterLeads([base], filter([], "all", "9876543210"), now).length, 1);
  assert.equal(api.filterLeads([{ ...base, isArchived: true }], filter([]), now).length, 0);
  assert.equal(api.filterLeads([{ ...base, assignee: "Other" }], { ...filter([]), quickView: "My Leads" }, now).length, 0);
  assert.equal(api.filterLeads([], filter([]), now).length, 0);
});

test("relative month boundaries handle leap years and year transitions", () => {
  const c = criterion("createdAt", "last_month");
  assert.equal(api.filterLeads([{ ...base, createdAt: "2024-02-29" }], filter([c]), new Date(2024, 2, 1)).length, 1);
  assert.equal(api.filterLeads([{ ...base, createdAt: "2025-12-31" }], filter([c]), new Date(2026, 0, 1)).length, 1);
});

test("lead edits and newly created leads persist without losing tracking data", () => {
  const storage = new Map();
  const events = [];
  const exports = {};
  const detailsSource = readFileSync(join(__dirname, "..", "src", "lib", "demo-lead-details-store.ts"), "utf8");
  vm.runInNewContext(ts.transpileModule(detailsSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, {
    exports, Date, Event: class { constructor(type) { this.type = type; } },
    window: { dispatchEvent: (event) => events.push(event.type) },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    require: (name) => (name === "@/lib/lead-filters" ? api : { LEAD_STAGES: ["Fresh", "Warm", "Hot"] }),
  });
  exports.saveDemoCreatedLead({ ...base, id: "created", hasBeenEdited: false });
  assert.equal(exports.applyDemoLeadDetails([base]).length, 2);
  assert.equal(exports.applyDemoLeadDetails([base])[1].hasBeenEdited, false);
  exports.saveDemoLeadDetails(base.id, { country: "Ireland", followUpAt: "2026-10-20" });
  let updated = exports.applyDemoLeadDetails([base])[0];
  assert.equal(updated.country, "Ireland");
  assert.equal(updated.modifiedBy, "Jordan Davis");
  assert.equal(updated.hasBeenEdited, true);
  assert.ok(Number.isFinite(Date.parse(updated.modifiedAt)));
  exports.saveDemoLeadChanges([{ id: base.id, details: { stage: "Hot" } }, { id: "created", details: { assignee: "Priya Sharma" } }]);
  updated = exports.applyDemoLeadDetails([base]);
  assert.equal(updated[0].country, "Ireland");
  assert.equal(updated[0].stage, "Hot");
  assert.equal(updated[1].assignee, "Priya Sharma");
  assert.equal(updated[1].hasBeenEdited, true);
  assert.equal(updated[0].editedAt.length, 2, "every edit date is recorded");
  assert.equal(updated[1].editedAt.length, 1);
  const seedEdited = { ...base, id: "seed", modifiedAt: "2026-10-05" };
  exports.saveDemoLeadDetails("seed", { stage: "Warm" });
  assert.equal(exports.applyDemoLeadDetails([seedEdited])[0].editedAt, undefined, "earlier unknown edits keep history incomplete");
  assert.equal(events.length, 4);
  storage.set("dmhca.demo.lead-details", '{"bad":{"unexpected":12}}');
  assert.throws(() => exports.applyDemoLeadDetails([base]), /invalid field/);
});

test("untouched On/Before/After/Between/Custom date options use full edit history and stay conservative without it", () => {
  const edited = { ...base, createdAt: "2026-09-01", modifiedAt: "2026-10-10T09:00:00", hasBeenEdited: true, editedAt: ["2026-09-20T10:00:00", "2026-10-10T09:00:00"] };
  const never = { ...base, createdAt: "2026-09-01", modifiedAt: "2026-09-01", hasBeenEdited: false };
  // Untouched after X: no edits after X.
  assert.ok(matches("untouched", "after", "2026-10-10", edited));
  assert.ok(!matches("untouched", "after", "2026-10-09", edited));
  assert.ok(matches("untouched", "after", "2026-09-15", never));
  assert.ok(!matches("untouched", "after", "2026-08-31", never), "lead did not exist yet");
  // Untouched before X: no edits before X.
  assert.ok(matches("untouched", "before", "2026-09-20", edited));
  assert.ok(!matches("untouched", "before", "2026-09-21", edited));
  assert.ok(matches("untouched", "before", "2026-10-01", never));
  assert.ok(!matches("untouched", "before", "2026-09-01", never), "created on that date");
  // Untouched between A and B (inclusive).
  assert.ok(matches("untouched", "between", "2026-09-21", edited, "2026-10-09"));
  assert.ok(!matches("untouched", "between", "2026-09-21", edited, "2026-10-10"));
  assert.ok(!matches("untouched", "between", "2026-09-20", edited, "2026-09-25"));
  assert.ok(matches("untouched", "between", "2026-09-05", never, "2026-10-19"));
  // Only the latest edit is known: answer only when it proves the result.
  const partial = { ...base, createdAt: "2026-09-01", modifiedAt: "2026-10-10" };
  assert.ok(matches("untouched", "after", "2026-10-12", partial));
  assert.ok(!matches("untouched", "after", "2026-10-05", partial));
  assert.ok(!matches("untouched", "before", "2026-10-05", partial), "earlier edits are unknown");
  assert.ok(matches("untouched", "between", "2026-10-11", partial, "2026-10-15"));
  assert.ok(!matches("untouched", "between", "2026-09-05", partial, "2026-09-10"), "earlier edits are unknown");
  for (const op of ["before", "after", "is"]) assert.ok(!matches("untouched", op, "2026-10-01", { ...base, createdAt: undefined }));
  // On / Custom date: no edit on that day.
  assert.ok(matches("untouched", "is", "2026-10-11", edited));
  assert.ok(!matches("untouched", "custom_date", "2026-10-10", edited));
  assert.ok(matches("untouched", "custom_date", "2026-10-12", partial));
  assert.ok(!matches("untouched", "is", "2026-10-09", partial), "earlier edits are unknown");
  assert.ok(matches("untouched", "is_false", "", edited), "legacy saved option still works");
  assert.equal(api.criterionError(criterion("untouched", "is_false")), null);
  assert.ok(api.criterionError(criterion("untouched", "contains", "x")));
  const legacyFilter = api.renameLegacyUntouchedOperators(filter([criterion("untouched", "untouched_between", "2026-10-01", "2026-10-05")]));
  assert.equal(legacyFilter.criteria[0].operator, "between");
  assert.ok(api.isSavedLeadFilter({ ...legacyFilter, id: "f", name: "Old" }));
  // Validation.
  for (const bad of [criterion("untouched", "after", ""), criterion("untouched", "before", "2026-02-30"),
    criterion("untouched", "between", "2026-10-10", "2026-10-01"), criterion("untouched", "between", "2026-10-10")]) {
    assert.ok(api.criterionError(bad), JSON.stringify(bad));
  }
  assert.equal(api.criterionError(criterion("untouched", "between", "2026-10-01", "2026-10-10")), null);
});