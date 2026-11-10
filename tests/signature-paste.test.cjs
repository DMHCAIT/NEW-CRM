const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { chromium } = require("playwright-core");

function compile(file) {
  return ts.transpileModule(readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
}

test("saved signatures retain table layout, borders and photo styling without allowing active CSS or scripts", () => {
  const exports = {};
  new Function("exports", "require", compile("src\\lib\\server\\email-signature.ts"))(exports, name =>
    name === "@/lib/email-signature-policy" ? { MAX_SIGNATURE_LENGTH: 1000000 } : require(name));
  const source = '<table width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;min-width:600px;table-layout:fixed;margin:0;border-collapse:collapse"><tr><td width="134" style="padding-right:8px;vertical-align:middle;border-right:1px solid rgba(255,255,255,0.25)"><img src="https://example.test/photo.png" width="110" height="110" style="width:110px;height:110px;border-radius:50%;border:3px solid #062B67;object-fit:cover;display:block;margin:0 auto"></td><td><a href="https://example.test" style="white-space:nowrap;letter-spacing:-0.3px">Contact</a><div style="font-size:0;line-height:0;border-bottom:2px solid #062B67">&nbsp;</div></td></tr></table>';
  const saved = exports.sanitizeSignature(source);
  for (const style of ["width:600px", "min-width:600px", "table-layout:fixed", "padding-right:8px", "border-radius:50%", "object-fit:cover", "display:block", "margin:0 auto", "white-space:nowrap", "letter-spacing:-0.3px", "font-size:0", "border-right:1px solid rgba(255,255,255,0.25)"])
    assert.ok(saved.includes(style), style);
  assert.match(saved, /cellpadding="0" cellspacing="0" border="0"/);
  assert.match(saved, /href="https:\/\/example.test"/);
  const unsafe = exports.sanitizeSignature('<script>alert(1)</script><img src="https://example.test/image.png" onerror="bad()" style="position:fixed;background-image:url(https://tracker.test);width:expression(bad());border:1px solid url(javascript:bad())"><a href="javascript:bad()">Bad</a>');
  assert.doesNotMatch(unsafe, /script|onerror|position|background-image|expression|javascript/);
});

test("browser signature paste uploads embedded images once, preserves clickable links and handles clipboard-local images safely", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const result = await page.evaluate(async ({ policyCode, helperCode }) => {
      const policy = {}, api = {};
      new Function("exports", policyCode)(policy);
      new Function("exports", "require", helperCode)(api, () => policy);
      const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0AAAAABJRU5ErkJggg==";
      const uploads = [];
      const upload = async file => { uploads.push({ type: file.type, size: file.size }); return `https://storage.example.test/signature-${uploads.length}.png`; };
      const original = `<table><tr><td><a href="https://dmhca.in/admissions"><img src="${image}" srcset="${image} 2x" width="300"></a></td><td><a href="mailto:admissions@example.test">Contact</a><img src="${image}"></td></tr></table>`;
      const html = await api.preparePastedSignature(original, [], upload);
      const parsed = new DOMParser().parseFromString(html, "text/html");
      if (uploads.length !== 1 || uploads[0].type !== "image/png" || uploads[0].size === 0) throw Error("Embedded image upload was not deduplicated.");
      if (parsed.querySelector("a img")?.parentElement.getAttribute("href") !== "https://dmhca.in/admissions") throw Error("Image click-through link was lost.");
      if (!parsed.querySelector('a[href="mailto:admissions@example.test"]')) throw Error("Email link was lost.");
      if (parsed.querySelector('img[srcset]') || parsed.querySelector('img[src^="data:"]')) throw Error("Temporary image source was retained.");
      if ([...parsed.querySelectorAll("img")].some(img => img.getAttribute("src") !== "https://storage.example.test/signature-1.png")) throw Error("Image replacement failed.");
      const file = new File([new Uint8Array([1, 2, 3])], "clipboard.png", { type: "image/png" });
      const recovered = await api.preparePastedSignature('<a href="https://dmhca.in"><img src="file:///clipboard/image.png"></a>', [file], upload);
      if (!recovered.includes('href="https://dmhca.in"') || !recovered.includes("signature-2.png")) throw Error("Clipboard image recovery lost links.");
      await api.preparePastedSignature('<img src="https://example.test/hosted.png">', [], upload);
      if (uploads.length !== 2) throw Error("Hosted images must not be reuploaded.");
      const failures = [
        ['<img src="file:///missing.png">', [], /clipboard did not include/],
        ['<img src="blob:first"><img src="blob:second">', [file], /clipboard did not include/],
        ['<img src="data:image/svg+xml;base64,PHN2Zz4=">', [], /unsupported/],
        ['<img src="data:image/png;base64,====">', [], /decoded/],
        [`<img src="data:image/png;base64,${"A".repeat(1400000)}">`, [], /1,000,000/],
        [`<img src="${image}">`, [], /Storage unavailable/],
      ];
      for (const [source, files, pattern] of failures) {
        let error;
        try { await api.preparePastedSignature(source, files, async () => { throw Error("Storage unavailable"); }); }
        catch (failure) { error = failure; }
        if (!error || !pattern.test(error.message)) throw Error(`Missing expected failure: ${pattern}`);
      }
      const large = `<a href="https://dmhca.in"><img src="${image}"></a><p>${"x".repeat(100000)}</p>`;
      const largeResult = await api.preparePastedSignature(large, [], upload);
      if (largeResult.length < 100000 || !largeResult.includes("https://dmhca.in")) throw Error("Large signature was truncated.");
      return { html, uploads: uploads.length };
    }, {
      policyCode: compile("src\\lib\\email-signature-policy.ts"),
      helperCode: compile("src\\lib\\signature-images.ts"),
    });
    assert.equal(result.uploads, 3);
    const sanitize = require("sanitize-html");
    const saved = sanitize(result.html, { allowedTags: ["table", "tbody", "tr", "td", "a", "img"], allowedAttributes: { a: ["href"], img: ["src", "width"] } });
    assert.match(saved, /href="https:\/\/dmhca.in\/admissions"><img src="https:\/\/storage.example.test/);
    assert.doesNotMatch(saved, /data:image/);
  } finally { await browser.close(); }
});
