const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const ts = require("typescript");

const code = ts.transpileModule(readFileSync(join(__dirname, "..", "src", "lib", "login-activity-time.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText;

test("login activity always shows exact IST time including seconds on UTC and non-India hosts", () => {
  const script = `${code}
    console.log(JSON.stringify([
      exports.formatLoginActivityTime("2026-11-10T09:48:12Z"),
      exports.formatLoginActivityTime("2026-11-10T10:12:34+00:00"),
      exports.formatLoginActivityTime("2026-11-10T15:00:00+05:30"),
      exports.formatLoginActivityTime("2026-11-10T21:00:01Z")
    ]));`;
  for (const timezone of ["UTC", "America/Los_Angeles", "Asia/Kolkata"]) {
    const result = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: timezone }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout).map(value => value.replace(/\s+/g, " "));
    assert.deepEqual(actual, [
      "10 Nov 2026, 3:18:12 pm IST",
      "10 Nov 2026, 3:42:34 pm IST",
      "10 Nov 2026, 3:00:00 pm IST",
      "11 Nov 2026, 2:30:01 am IST",
    ], timezone);
  }
});
