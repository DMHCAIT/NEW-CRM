const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const compiled = ts.transpileModule(readFileSync(join(__dirname, "..", "src", "app", "login", "page.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function render(overrides = {}) {
  const states = { step: "password", email: "", password: "", code: "", busy: false, error: "", notice: "", showPassword: false, ...overrides };
  const values = Object.values(states);
  let index = 0;
  const api = {};
  vm.runInNewContext(compiled, {
    exports: api,
    require: (name) => {
      if (name === "react") return { ...React, useState: () => [values[index++], () => {}], useEffect: () => {} };
      if (name === "./login.module.css") return {};
      if (name === "@/lib/auth-routing" || name === "@/lib/crm-data") return {};
      return require(name);
    },
  });
  return renderToStaticMarkup(React.createElement(api.default));
}

test("the first sign-in step contains only email and password credentials", () => {
  const html = render();
  assert.equal((html.match(/<input\b/g) ?? []).length, 2);
  assert.match(html, /id="login-email" type="email" autoComplete="username"/);
  assert.match(html, /id="login-password" type="password" autoComplete="current-password"/);
  assert.match(html, /aria-label="Show password"/);
  assert.doesNotMatch(html, /id="login-code"/);
  assert.match(html, /aria-current="step"/);
});

test("verification replaces credentials with a single six-digit paste/autofill input", () => {
  const html = render({ step: "code", email: "person@example.com" });
  assert.equal((html.match(/<input\b/g) ?? []).length, 1);
  assert.match(html, /id="login-code"/);
  assert.match(html, /autoComplete="one-time-code"/);
  assert.match(html, /inputMode="numeric"/);
  assert.match(html, /maxLength="6"/);
  assert.match(html, /person@example.com/);
  assert.match(html, /Verify and sign in/);
  assert.match(html, /request a new code/);
  assert.doesNotMatch(html, /id="login-password"|id="login-email"/);
});

test("busy/error and password visibility states remain explicit and accessible", () => {
  const busy = render({ busy: true });
  assert.match(busy, /aria-busy="true"/);
  assert.match(busy, /<fieldset disabled=""/);
  assert.match(busy, /Sending verification code/);
  const error = render({ error: "Incorrect <code>" });
  assert.match(error, /role="alert"/);
  assert.match(error, /Incorrect &lt;code&gt;/);
  const visible = render({ showPassword: true });
  assert.match(visible, /id="login-password" type="text"/);
  assert.match(visible, /aria-label="Hide password" aria-pressed="true"/);
});
