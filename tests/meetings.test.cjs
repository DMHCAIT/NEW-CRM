const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const attendeeId = "8c5b3271-8bdc-4ccc-9d40-8c741505bb98";
const hostId = "9c5b3271-8bdc-4ccc-9d40-8c741505bb99";
const defaultStaff = [{ id: attendeeId, full_name: "Counselor One", email: "counselor@example.com", role: "counselor", status: "active", deleted_at: null }];
const errorApi = class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } };

function load(relativePath, mocks) {
  const exports = {};
  const source = readFileSync(join(__dirname, "..", ...relativePath.split("/")), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText, {
    exports,
    require: name => name in mocks ? mocks[name] : require(name),
    Buffer, Date, Number, Intl, process, console, Response, URL, crypto: require("node:crypto").webcrypto,
  });
  return exports;
}
const schemaExports = load("src/lib/server/operational-validation.ts", { "@/lib/server/auth": { HttpError: errorApi } });

function buildRoute(options = {}) {
  const staff = options.staff ?? defaultStaff;
  const supabaseState = { meeting: null, attendees: [], meetingInsertError: options.meetingInsertError ?? null, deleted: false };
  const profileQuery = () => {
    const query = {
      select() { return this; }, in() { return this; }, eq() { return this; }, is() { return this; },
      order: async () => ({ data: staff, error: null }),
    };
    return query;
  };
  const overlapQuery = () => {
    const query = {
      select() { return this; }, not() { return this; }, in() { return this; }, gte() { return this; }, lt() { return this; }, limit() { return this; },
      then(resolve, reject) { return Promise.resolve({ data: options.overlaps ?? [], error: null }).then(resolve, reject); },
    };
    return query;
  };
  const supabase = { from(table) {
    if (table === "profiles") return profileQuery();
    if (table === "meeting_attendees") return { insert: rows => { supabaseState.attendees = rows; return { error: null }; } };
    const query = {
      select() { return this; },
      insert(row) { supabaseState.meeting = row; return this; },
      single: async () => ({ data: { id: supabaseState.meeting.id, title: supabaseState.meeting.title, start_at: supabaseState.meeting.start_at, duration_min: supabaseState.meeting.duration_min, join_url: supabaseState.meeting.join_url, passcode: supabaseState.meeting.passcode }, error: supabaseState.meetingInsertError }),
      not() { return this; }, in() { return this; }, gte() { return this; }, lt() { return this; }, limit() { return this; },
      then(resolve, reject) { return Promise.resolve({ data: options.overlaps ?? [], error: null }).then(resolve, reject); },
    };
    return query;
  } };
  const admin = { from(table) {
    if (table === "profiles") return profileQuery();
    return { delete() { return { eq: async () => { supabaseState.deleted = true; return { error: null }; } }; } };
  } };
  const HttpError = errorApi;
  const mocks = {
    "next/server": { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } },
    "@/lib/server/auth": {
      HttpError,
      requireUser: async permission => {
        if (options.permissionError) throw new HttpError(403, "No permission");
        assert.equal(permission, "meetings.manage");
        return { supabase, user: { id: hostId, email: "host@example.com", profile: { role: options.role ?? "manager", fullName: "Meeting Host" }, permissions: ["meetings.manage"] } };
      },
      jsonError: error => ({ status: error.status ?? 500, error: error.message }),
      readJson: request => request.json(),
      isEmail: value => /^[^@]+@[^@]+\.[^@]+$/.test(value),
    },
    "@/lib/server/operational": {
      databaseError: error => { if (error) throw error; },
      integrationRequirements: { zoom: ["ZOOM_ACCOUNT_ID", "ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET"] },
      parseInput: (schema, input) => {
        const result = schema.safeParse(input);
        if (!result.success) throw new HttpError(400, result.error.issues.map(issue => issue.message).join(" "));
        return result.data;
      },
    },
    "@/lib/server/integration-settings": { integrationStatus: async () => ({ configured: true, missing: [], required: [] }) },
    "@/lib/server/operational-validation": { meetingInput: schemaExports.meetingInput },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => admin },
    "@/lib/server/zoom": {
      createZoomMeeting: async () => { if (options.zoomError) throw options.zoomError; return { id: 123, join_url: "https://zoom.us/j/123", start_url: "secret-host-url", password: "123abc" }; },
      deleteZoomMeeting: async id => { options.deletedZoom = id; },
    },
    "@/lib/server/meeting-mail": { emailMeetingRecipients: async (_meeting, recipients) => {
      if (options.emailError) throw options.emailError;
      options.recipients = recipients;
      return { emailed: recipients.length };
    } },
  };
  const route = load("src/app/api/meetings/route.ts", mocks);
  return { route, supabaseState, options };
}
function request(data) {
  return new Request("https://crm.example/api/meetings", { method: "POST", body: JSON.stringify({
    title: "Staff planning", start_at: new Date(Date.now() + 3_600_000).toISOString(), duration_min: 30,
    provider: "internal", attendee_ids: [attendeeId], ...data,
  }) });
}

test("counselor cannot POST meetings even when an override grants the permission", async () => {
  const { route } = buildRoute({ role: "counselor" });
  const result = await route.POST(request({}));
  assert.equal(result.status, 403);
  assert.match(result.error, /Only managers/);
});

test("attendee roles resolve to active profiles and Zoom's free plan accepts 40 minutes only", async () => {
  const { route, supabaseState, options } = buildRoute();
  const leadMeeting = await route.POST(request({ lead_id: attendeeId }));
  assert.equal(leadMeeting.status, 400);
  const result = await route.POST(request({ attendee_ids: [], attendee_roles: ["counselor"] }));
  assert.equal(result.status, 201);
  assert.equal(supabaseState.meeting.lead_id, null);
  assert.equal(JSON.stringify(supabaseState.attendees.map(row => row.user_id)), JSON.stringify([attendeeId]));
  assert.equal(JSON.stringify(options.recipients.map(row => row.email)), JSON.stringify(["counselor@example.com"]));

  const limited = buildRoute();
  const invalid = await limited.route.POST(request({ provider: "zoom", duration_min: 41 }));
  assert.equal(invalid.status, 400);
  assert.match(invalid.error, /40 minutes/);
  const allowed = buildRoute();
  const valid = await allowed.route.POST(request({ provider: "zoom", duration_min: 40 }));
  assert.equal(valid.status, 201);
  assert.equal(valid.body.meeting.id, allowed.supabaseState.meeting.id);
  assert.equal("start_url" in valid.body, false);
});

test("overlapping non-cancelled Zoom meetings are rejected with HTTP 409", async () => {
  const start = Date.now() + 3_600_000;
  const route = buildRoute({ overlaps: [{ start_at: new Date(start - 10 * 60_000).toISOString(), duration_min: 30 }] });
  const result = await route.route.POST(request({ provider: "zoom", start_at: new Date(start).toISOString() }));
  assert.equal(result.status, 409);
  assert.match(result.error, /overlaps another scheduled Zoom meeting/);
});

test("Zoom meetings are deleted when database persistence fails", async () => {
  const route = buildRoute({ meetingInsertError: { message: "database unavailable" } });
  const result = await route.route.POST(request({ provider: "zoom" }));
  assert.equal(result.status, 500);
  assert.equal(route.options.deletedZoom, "123");
  assert.equal(route.supabaseState.deleted, true);
});

test("email failures are returned as warnings without failing meeting creation", async () => {
  const route = buildRoute({ emailError: new Error("SMTP is not configured") });
  const result = await route.route.POST(request({}));
  assert.equal(result.status, 201);
  assert.equal(result.body.emailed, 0);
  assert.ok(result.body.emailError);
});

test("meeting invitations include stable calendar UID, method, sequence, and ICS attachment", async () => {
  let sent;
  const mail = load("src/lib/server/meeting-mail.ts", {
    "@/lib/server/env": { appUrl: () => "https://crm.example" },
    "@/lib/server/mailer": { emailLayout: (_title, html) => html, escapeHtml: value => value, sendMail: async value => { sent = value; } },
  });
  const meeting = { id: attendeeId, title: "Planning, Q&A", start_at: "2027-01-01T09:00:00.000Z", duration_min: 40, join_url: "https://zoom.us/j/123", passcode: "123abc" };
  const invitation = mail.buildMeetingIcs(meeting, "REQUEST", 3);
  assert.match(invitation, /METHOD:REQUEST/);
  assert.match(invitation, new RegExp("UID:" + attendeeId + "@crm\\.example"));
  assert.match(invitation, /SEQUENCE:3/);
  assert.match(invitation, /SUMMARY:Planning\\, Q&A/);
  const result = await mail.emailMeetingRecipients(meeting, [{ name: "Staff", email: "staff@example.com" }], "Host", "CANCEL", 4);
  assert.equal(result.emailed, 1);
  assert.match(sent.attachments[0].content.toString(), /METHOD:CANCEL/);
  assert.equal(sent.attachments[0].contentType, "text/calendar; method=CANCEL; charset=UTF-8");
});

test("meeting list, staff and configuration requests run concurrently without changing attendee visibility", async () => {
  const pending = new Map();
  const held = (name, data) => new Promise(resolve => pending.set(name, () => resolve({ data, error: null })));
  const route = load("src/app/api/meetings/route.ts", {
    "next/server": { NextResponse: { json: body => ({ status: 200, body }) } },
    "@/lib/server/auth": {
      requireUser: async permission => {
        assert.equal(permission, "meetings.view");
        return {
          supabase: { from: table => {
            assert.equal(table, "meetings");
            const query = {
              select() { return this; }, is() { return this; }, order() { return this; },
              limit: () => held("meetings", [{ id: "meeting-1", title: "Planning" }]),
            };
            return query;
          } },
          user: { id: hostId, profile: { role: "manager" }, permissions: ["meetings.manage"] },
        };
      },
      jsonError: error => { throw error; },
    },
    "@/lib/server/operational": {
      databaseError: error => { if (error) throw error; }, integrationRequirements: { zoom: [] },
    },
    "@/lib/server/integration-settings": { integrationStatus: async () => (await held("zoom", { configured: true })).data },
    "@/lib/server/operational-validation": {},
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({
      from: table => {
        const query = {
          select() { return this; }, eq() { return this; }, is() { return this; }, in() { return this; },
          order: () => held("staff", defaultStaff),
          then(resolve, reject) { return Promise.resolve({
            data: table === "meeting_attendees" ? [{ meeting_id: "meeting-1", user_id: attendeeId }] : defaultStaff,
            error: null,
          }).then(resolve, reject); },
        };
        return query;
      },
    }) },
    "@/lib/server/zoom": {}, "@/lib/server/meeting-mail": {},
  });
  let finished = false;
  const response = route.GET().then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...pending.keys()].sort(), ["meetings", "staff", "zoom"]);
  pending.get("staff")(); pending.get("zoom")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  pending.get("meetings")();
  const result = await response;
  assert.equal(result.body.meetings[0].attendees[0].id, attendeeId);
  assert.equal(result.body.meetings[0].isAttendee, false);
  assert.equal(result.body.staff[0].email, defaultStaff[0].email);
  assert.equal(result.body.canManage, true);
  assert.equal(result.body.canAdminManage, false);
  assert.equal(result.body.zoom.configured, true);
});
