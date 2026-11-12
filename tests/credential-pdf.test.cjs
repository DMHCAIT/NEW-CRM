const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
const { PDFDocument, PDFRawStream, decodePDFRawStream } = require("pdf-lib");
const api = {};
new Function("exports", "require", ts.transpileModule(readFileSync(require("node:path").join(__dirname, "..", "src", "lib", "credential-pdf.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText)(api, require);

function textFromPdf(pdf) {
  const contents = pdf.getPage(0).node.Contents();
  const streams = contents instanceof PDFRawStream ? [contents] : contents.asArray().map(item => pdf.context.lookup(item, PDFRawStream));
  return streams.flatMap(stream => {
    const commands = Buffer.from(decodePDFRawStream(stream).decode()).toString();
    return [...commands.matchAll(/<([0-9A-F]+)> Tj/g)].map(match => Buffer.from(match[1], "hex").toString());
  });
}

test("credential PDF includes the user name, email, password and public CRM URL", async () => {
  const bytes = await api.createCredentialPdf("Example User", "test@example.com", "A-new-password123");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  const text = textFromPdf(pdf);
  assert.ok(text.includes("Example User"));
  assert.ok(text.includes("test@example.com"));
  assert.ok(text.includes("A-new-password123"));
  assert.ok(text.includes("https://www.ibmpcrm.xyz/"));
  assert.ok(text.includes("IBMP CRM"));
});

test("long credentials fit within the PDF page without truncation", async () => {
  const password = "x".repeat(128);
  const pdf = await PDFDocument.load(await api.createCredentialPdf("Example User", "test@example.com", password));
  assert.equal(textFromPdf(pdf).filter(text => /^[x]+$/.test(text)).join(""), password);
});

test("credential download filename uses a filesystem-safe version of the user name", () => {
  assert.equal(api.credentialPdfFilename("Example User"), "Example-User-user-details.pdf");
  assert.equal(api.credentialPdfFilename("  ../Test User?  "), "Test-User-user-details.pdf");
});

test("the PDF library loads only when a credential download is requested", async () => {
  const lazy = {};
  let loads = 0;
  new Function("exports", "require", ts.transpileModule(readFileSync(require("node:path").join(__dirname, "..", "src", "lib", "credential-pdf.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText)(lazy, name => {
    assert.equal(name, "pdf-lib");
    loads++;
    return require(name);
  });
  assert.equal(loads, 0);
  const bytes = await lazy.createCredentialPdf("Example User", "test@example.com", "A-new-password123");
  assert.equal(loads, 1);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});
