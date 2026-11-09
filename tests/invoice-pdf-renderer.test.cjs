const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const ts = require("typescript");
const { PDFDocument } = require("pdf-lib");

function load(file, mocks = {}) {
  const api = {};
  const code = ts.transpileModule(readFileSync(join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  new Function("exports", "require", code)(api, name => name in mocks ? mocks[name]
    : name.startsWith("@/") ? load(`${name.replace("@/", "src\\").replaceAll("/", "\\")}.ts`, mocks) : require(name));
  return api;
}

const record = {
  invoice_no: "INV-RENDER-TEST", status: "sent", lead_id: "fixture", created_at: new Date().toISOString(),
  due_date: null, subtotal: 100, discount_amount: 0, discount_reason: null, tax_amount: 18, total: 118,
  currency: "INR", notes: null, payment_type: "one_shot",
  billing_name: "Saved Student", billing_email: "student@example.com",
  invoice_items: [{ description: "Test course", quantity: 1, unit_price: 100, amount: 100 }],
};

test("PDF renders the exact shared email template with embedded logo, identical links and no remote requests", async () => {
  const calls = {};
  const fixture = await PDFDocument.create();
  fixture.addPage();
  const pdfBytes = await fixture.save();
  const { buildInvoiceHtml } = load("src\\lib\\invoice-document.ts");
  const { buildInvoicePdf } = load("src\\lib\\server\\invoice-pdf.ts", {
    "playwright-core": { chromium: { launch: async options => {
      calls.launch = options;
      return {
        newContext: async options => {
          calls.context = options;
          return { newPage: async () => ({
            route: async (pattern, handler) => {
              assert.equal(pattern, "**/*");
              await handler({ abort: async () => { calls.blocked = true; } });
            },
            setContent: async html => { calls.html = html; },
            emulateMedia: async options => { calls.media = options.media; },
            locator: () => ({ evaluateAll: async () => {}, evaluate: async () => ({ width: 820, height: 1500 }) }),
            pdf: async options => { calls.pdf = options; return pdfBytes; },
          }) };
        },
        close: async () => { calls.closed = true; },
      };
    } } },
  });
  const pay = "https://example.com/pay", view = "https://example.com/invoice";
  const result = await PDFDocument.load(await buildInvoicePdf(record, null, pay, view));
  assert.equal(result.getPageCount(), 1);
  const output = result.getPage(0);
  const expectedScale = (297 / 25.4 * 96 - 2) / 1500;
  assert.ok(Math.abs(output.getWidth() - 820 * expectedScale * 0.75) < 0.001);
  assert.ok(Math.abs(output.getHeight() - 1500 * expectedScale * 0.75) < 0.001);
  assert.deepEqual(output.getCropBox(), output.getMediaBox());
  const logo = readFileSync(join(__dirname, "..", "public", "DMHCA-invoice-wordmark.png")).toString("base64");
  const expected = buildInvoiceHtml(record, { logoUrl: `data:image/png;base64,${logo}`, paymentUrl: pay, viewUrl: view });
  assert.ok(calls.html.endsWith(`<body>${expected}</body></html>`));
  assert.equal(calls.context.javaScriptEnabled, false);
  assert.equal(calls.context.viewport.width, 820);
  assert.equal(calls.media, "screen");
  assert.equal(calls.pdf.format, "A4");
  assert.equal(calls.pdf.scale, (297 / 25.4 * 96 - 2) / 1500);
  assert.equal(calls.pdf.printBackground, true);
  assert.equal(calls.pdf.displayHeaderFooter, false);
  assert.equal(calls.blocked, true);
  assert.equal(calls.closed, true);
  assert.doesNotMatch(calls.html, /Hello |Please find your invoice|View live invoice|Payment deadline/);
});

test("PDF failures propagate and always close the browser", async () => {
  for (const phase of ["context", "content", "image", "pdf"]) {
    let closed = false;
    const fail = () => { throw new Error(`Failed ${phase}`); };
    const { buildInvoicePdf } = load("src\\lib\\server\\invoice-pdf.ts", {
      "playwright-core": { chromium: { launch: async () => ({
        newContext: async () => {
          if (phase === "context") fail();
          return { newPage: async () => ({
            route: async () => {},
            setContent: async () => { if (phase === "content") fail(); },
            emulateMedia: async () => {},
            locator: () => ({ evaluateAll: async () => { if (phase === "image") fail(); },
              evaluate: async () => ({ width: 820, height: 1000 }) }),
            pdf: async () => fail(),
          }) };
        },
        close: async () => { closed = true; },
      }) } },
    });
    await assert.rejects(buildInvoicePdf(record, null), new RegExp(`Failed ${phase}`));
    assert.equal(closed, true, phase);
  }
});

for (const code of ["DMHCA", "IBMP"]) test(`${code} PDF and mail layouts have identical header, tables, typography, button and footer geometry`, async () => {
  const { chromium } = require("playwright-core");
  const { buildInvoiceHtml } = load("src\\lib\\invoice-document.ts");
  const activeRecord = { ...record, company_snapshot: {
    code, legal_name: `${code} Education`, address: "Example registered address", tax_id: "TEST-TAX",
    primary_color: "#ffffff", accent_color: "#ffffff",
    invoice_profile: { bank_accounts: [{ bank_name: "Example Bank", account_name: "Example Education",
      account_number: "TEST-ACCOUNT", ifsc: "TEST0000001", branch: "Example branch", swift: "" }] },
  } };
  const pay = "https://example.com/pay";
  const measurements = async page => page.locator(".invoice-document").evaluate(root => {
    const selectors = [".invoice-document-header", ".invoice-parties", ".invoice-document-details",
      ".invoice-document-totals", ".invoice-pay-button", ".invoice-bank-details", ".invoice-terms", ".invoice-document-footer"];
    return selectors.map(selector => {
      const el = root.querySelector(selector), box = el.getBoundingClientRect(), style = getComputedStyle(el);
      return { selector, x: box.x, y: box.y, width: box.width, height: box.height,
        font: style.font, color: style.color, background: style.backgroundColor, padding: style.padding };
    });
  });
  let actual, expected, dimensions;
  const { buildInvoicePdf } = load("src\\lib\\server\\invoice-pdf.ts", {
    "playwright-core": { chromium: { launch: async options => {
      const browser = await chromium.launch(options);
      return {
        close: () => browser.close(),
        newContext: async options => {
          const context = await browser.newContext(options);
          return { newPage: async () => {
            const page = await context.newPage(), print = page.pdf.bind(page);
            page.pdf = async options => {
              actual = await measurements(page);
              dimensions = await page.locator(".invoice-document").evaluate(element => ({
                width: Math.max(element.scrollWidth, element.getBoundingClientRect().width),
                height: Math.max(element.scrollHeight, element.getBoundingClientRect().height),
              }));
              const email = await context.newPage();
              const logo = readFileSync(join(__dirname, "..", "public", "DMHCA-invoice-wordmark.png")).toString("base64");
              await email.setContent(`<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif">${buildInvoiceHtml(activeRecord, {
                paymentUrl: pay, logoUrl: `data:image/png;base64,${logo}`,
              })}</body></html>`);
              expected = await measurements(email);
              const footerLink = await email.locator(".invoice-document-footer").evaluate(footer => {
                const address = footer.querySelector("div");
                const link = document.createElement("a");
                link.href = "https://example.com/maps";
                link.setAttribute("data-detected-address", "true");
                link.style.color = "blue";
                link.textContent = address.textContent;
                address.replaceChildren(link);
                const style = getComputedStyle(link);
                return { color: style.color, decoration: style.textDecorationLine };
              });
              assert.deepEqual(footerLink, { color: "rgb(255, 255, 255)", decoration: "none" });
              const overlap = await page.locator(".invoice-document-totals tr").evaluateAll(rows => rows.some(row => {
                const [label, amount] = row.cells;
                return label.getBoundingClientRect().right > amount.getBoundingClientRect().left + 1;
              }));
              assert.equal(overlap, false);
              return print(options);
            };
            return page;
          } };
        },
      };
    } } },
  });
  const pdf = await PDFDocument.load(await buildInvoicePdf(activeRecord, null, pay));
  const output = pdf.getPage(0);
  assert.equal(pdf.getPageCount(), 1);
  assert.ok(Math.abs(output.getWidth() / output.getHeight() - dimensions.width / dimensions.height) < 0.00001,
    "PDF canvas must end at the invoice's right edge and footer bottom");
  assert.deepEqual(output.getCropBox(), output.getMediaBox());
  for (let i = 0; i < actual.length; i++) {
    const { x, y, width, height, ...styles } = actual[i];
    const { x: ex, y: ey, width: ew, height: eh, ...emailStyles } = expected[i];
    assert.deepEqual(styles, emailStyles);
    for (const [a, b] of [[x, ex], [y, ey], [width, ew], [height, eh]])
      assert.ok(Math.abs(a - b) <= 2, `${styles.selector}: PDF ${a}, email ${b}`);
  }
});
