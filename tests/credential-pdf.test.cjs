const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const ts = require("typescript");
const { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } = require("pdf-lib");
const api = {};
new Function("exports", "require", ts.transpileModule(readFileSync(require("node:path").join(__dirname, "..", "src", "lib", "credential-pdf.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
}).outputText)(api, require);

test("credential PDF contains only email and password text, without profile details", async () => {
  const bytes = await api.createCredentialPdf("test@example.com", "A-new-password123");
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  const contents = pdf.getPage(0).node.Contents();
  assert.ok(contents instanceof PDFArray);
  const stream = contents.lookup(0, PDFRawStream);
  const commands = Buffer.from(decodePDFRawStream(stream).decode()).toString();
  const text = [...commands.matchAll(/<([0-9A-F]+)> Tj/g)].map((match) => Buffer.from(match[1], "hex").toString());
  assert.deepEqual(text, ["Email: test@example.com", "Password: A-new-password123"]);
});

test("long credentials fit within the PDF page without truncation", async () => {
  const password = "x".repeat(128);
  const pdf = await PDFDocument.load(await api.createCredentialPdf("test@example.com", password));
  const commands = Buffer.from(decodePDFRawStream(pdf.getPage(0).node.Contents().lookup(0, PDFRawStream)).decode()).toString();
  const text = [...commands.matchAll(/<([0-9A-F]+)> Tj/g)].map((match) => Buffer.from(match[1], "hex").toString());
  assert.equal(text.slice(1).join(""), `Password: ${password}`);
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
  const bytes = await lazy.createCredentialPdf("test@example.com", "A-new-password123");
  assert.equal(loads, 1);
  assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
});
