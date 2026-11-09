const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const ts = require("typescript");
const { PDFDocument, PDFRawStream, PDFName, PDFArray } = require("pdf-lib");
const { pdfCommands, pdfText } = require("./helpers/invoice-pdf.cjs");

function load(file, mocks = {}) {
  const api = {};
  const code = ts.transpileModule(readFileSync(join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  new Function("exports", "require", code)(api, name => name in mocks ? mocks[name]
    : name.startsWith("@/") ? load(`${name.replace("@/", "src\\").replaceAll("/", "\\")}.ts`, mocks) : require(name));
  return api;
}
const { installmentPaymentSummary } = load("src\\lib\\invoice-payment-summary.ts");
const { buildInvoiceHtml } = load("src\\lib\\invoice-document.ts");
const { buildInvoicePdf } = load("src\\lib\\server\\invoice-pdf.ts");
const { invoicePresentation } = load("src\\lib\\invoice-presentation.ts");
const { invoiceCompanyProfile, invoiceDocumentDetails } = load("src\\lib\\billing.ts");
const profile = {
  billing_email: "billing@example.com", phone: "Company contact", website: "https://example.com",
  refund_policy_url: "https://example.com/refund",
  bank_accounts: [{ account_name: "Example Education", bank_name: "Example Bank", account_number: "TEST-ACCOUNT-ONLY", ifsc: "TEST0000001", branch: "Example branch", swift: "" }],
};
const family = [
  { id: "first", total: 30000, status: "paid", installment_number: 1, due_date: "2027-01-05" },
  { id: "second", total: 20000, status: "sent", installment_number: 2, due_date: "2027-02-05" },
  { id: "third", total: 50000, status: "scheduled", installment_number: 3, due_date: "2027-03-05" },
];
function invoice(code = "DMHCA", paid = false) {
  const rows = family.map(row => ({ ...row, ...(paid && row.id === "second" ? { status: "paid" } : {}) }));
  return {
    id: "second", parent_invoice_id: "first", invoice_no: "INV-DEMO-ONLY", lead_id: "fixture",
    created_at: new Date().toISOString(), due_date: "2027-02-05", currency: "INR",
    subtotal: 18000, discount_amount: 1000, discount_reason: "Enrollment concession", tax_amount: 3000, total: 20000,
    status: paid ? "paid" : "sent", paid_at: paid ? new Date().toISOString() : null, notes: null,
    payment_type: "installments", course_total: 100000, installment_number: 2,
    invoice_items: [{ description: "Example course", quantity: 1, unit_price: 18000, amount: 18000 }],
    company_snapshot: { code, legal_name: `${code} Education`, address: "Example registered address", tax_id: "TEST-TAX",
      primary_color: "#ffffff", accent_color: "#ffffff", invoice_profile: profile },
    billing_name: "Example Student", billing_email: "student@example.com", billing_address: "Example billing address",
    document_details: { student_id: "STUDENT-TEST", billing_phone: "Student contact", place_of_supply: "Example State",
      course_details: "12 months / online", sac_code: "TEST-SAC" },
    payment_summary: installmentPaymentSummary(100000, rows[1], rows),
  };
}

test("installment balances subtract only confirmed payments and never deduct a paid installment twice", () => {
  const summary = installmentPaymentSummary(100000, family[1], family);
  assert.deepEqual([summary.courseTotal, summary.paidToDate, summary.outstanding, summary.balanceAfterPayment], [100000, 30000, 70000, 50000]);
  assert.equal(summary.schedule[1].current, true);
  const secondPaid = family.map(row => row.id === "second" ? { ...row, status: "paid" } : row);
  const after = installmentPaymentSummary(100000, secondPaid[1], secondPaid);
  assert.deepEqual([after.paidToDate, after.outstanding, after.balanceAfterPayment], [50000, 50000, 50000]);
  assert.equal(installmentPaymentSummary(100000, family[1], secondPaid).balanceAfterPayment, 50000, "a newer verified family read must not deduct an already-paid invoice twice");
  const third = installmentPaymentSummary(100000, secondPaid[2], secondPaid);
  assert.equal(third.balanceAfterPayment, 0);
  const allPaid = secondPaid.map(row => ({ ...row, status: "paid" }));
  assert.equal(installmentPaymentSummary(100000, allPaid[2], allPaid).outstanding, 0);
  for (const status of ["pending_approval", "expired", "scheduled", "sent", "cancelled", "rejected"])
    assert.equal(installmentPaymentSummary(100000, { ...family[1], status }, [{ ...family[0], status }, family[1]]).paidToDate, 0);
  assert.equal(installmentPaymentSummary(0.30, { id: "b", total: 0.20, status: "sent" }, [{ id: "a", total: 0.10, status: "paid" }]).balanceAfterPayment, 0);
});

test("both invoice outputs preserve current palettes and share student, bank, terms and balances", async () => {
  for (const [code, primary, accent] of [["DMHCA", "#1c1d4e", "#c44754"], ["IBMP", "#1c1d4e", "#c44754"]]) {
    for (const paid of [false, true]) {
      const record = invoice(code, paid);
      const html = buildInvoiceHtml(record, { paymentUrl: "https://example.com/pay-current" });
      assert.ok(html.includes(primary) && html.includes(accent));
      for (const value of ["STUDENT-TEST", "Student contact", "Example State", "12 months / online", "TEST-SAC",
        "TEST-ACCOUNT-ONLY", "TEST0000001", "Example branch", "billing@example.com", "dmhca.in/refund-returns-policy", "Balance still unpaid"])
        assert.ok(html.includes(value), value);
      assert.equal((html.match(/<li>/g) ?? []).length, 3);
      assert.ok(!html.includes("4. If") && !html.includes("copy and paste"));
      assert.doesNotMatch(html, /PAYMENT DETAILS|Pay securely with Razorpay/);
      if (paid) {
        assert.match(html, /background:#167844;color:#fff/);
        assert.doesNotMatch(html, /Pay Now|Balance after this installment/);
      } else {
        assert.match(html, /class="invoice-pay-button"/);
        assert.doesNotMatch(html, /Pay Now ₹/);
        assert.ok(html.includes("₹70,000.00") && html.includes("₹50,000.00"));
      }
      const doc = await PDFDocument.load(await buildInvoicePdf(record, null, "https://example.com/pay-current"));
      assert.equal(doc.getPageCount(), 1, `${code} metadata-rich invoice must fit one page`);
      const text = pdfText(doc);
      assert.ok(!text.includes("PAYMENT DETAILS"));
      for (const value of ["STUDENT-TEST", "TEST-ACCOUNT-ONLY", "TEST-SAC", "₹50,000.00", "TERMS & CONDITIONS"]) {
        assert.ok(text.includes(value), `${code} PDF: ${value}`);
      }
      const annotations = doc.getPages().flatMap(page => {
        const values = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
        return values ? values.asArray() : [];
      });
      assert.ok(annotations.length >= (paid ? 0 : 1));
      assert.ok(text.includes(paid ? "Paid ₹20,000.00" : "Pay Now"));
    }
  }
});

test("invoice details escape input and missing bank fields never become invented data", () => {
  const record = invoice();
  record.document_details.student_id = "<script>alert(1)</script>";
  record.company_snapshot.invoice_profile = undefined;
  const html = buildInvoiceHtml(record);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|BANK DETAILS|TEST-ACCOUNT-ONLY|https:\/\/example.com\/refund/);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
});

test("softened DMHCA accents stay consistent in PDF and HTML with accessible white text", async () => {
  const record = invoice();
  const { company } = invoicePresentation(record);
  assert.equal(company.accent_color, "#c44754");
  const channels = company.accent_color.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
  const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const contrast = 1.05 / (linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722 + 0.05);
  assert.ok(contrast >= 4.5, `White text contrast must be at least 4.5:1, received ${contrast}`);
  const html = buildInvoiceHtml(record, { paymentUrl: "https://example.com/pay" });
  assert.doesNotMatch(html, /#a91e2c/i);
  assert.match(html, /background:#f7f8fa/);
  const commands = pdfCommands(await PDFDocument.load(await buildInvoicePdf(record, null)));
  const fills = [...commands.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) rg/g)].map(match => match.slice(1).map(Number));
  assert.ok(fills.some(fill => fill.every((value, i) => Math.abs(value - channels[i]) < 0.0001)));
  assert.equal(invoicePresentation(invoice("IBMP")).company.accent_color, "#c44754");
});

test("DMHCA replaces all old terms and renders a padded bank grid in HTML and PDF", async () => {
  const record = invoice();
  const expected = [
    "Fees once paid are subject to the DMHCA Refund Policy (dmhca.in/refund-returns-policy).",
    "This invoice is issued against enrolment in the program named above.",
    "Billing queries: info@dmhca.in, quoting the invoice number.",
  ];
  assert.deepEqual(invoicePresentation(record).terms, expected);
  const html = buildInvoiceHtml(record);
  const terms = html.split('class="invoice-terms"')[1].split("</ol>")[0];
  for (const term of expected) assert.ok(terms.includes(term));
  assert.doesNotMatch(terms, /example.com|admissions team|enrollment in the course/);
  const bank = html.split('class="invoice-bank-details"')[1].split("</table>")[0];
  assert.match(bank, /scope="row"/);
  assert.equal((bank.match(/padding:10px 12px;border:1px solid #cbd5e1/g) ?? []).length, 10);
  const doc = await PDFDocument.load(await buildInvoicePdf(record, null));
  const text = pdfText(doc);
  for (const term of expected) assert.ok(text.includes(term), term);
  assert.doesNotMatch(text, /enrollment in the course named above/);
  assert.equal(invoicePresentation(invoice("IBMP")).terms[1], expected[1]);
});

test("DMHCA reference format removes detail status, issuer, payment type and discount reason in HTML and PDF", async () => {
  for (const paid of [false, true]) {
    const record = invoice("DMHCA", paid);
    const html = buildInvoiceHtml(record, { paymentUrl: "https://example.com/pay" });
    const details = html.split('class="invoice-document-details"')[1].split("</td>")[0];
    assert.doesNotMatch(details, /Status:|Issued by:|Payment type:|Payment:/);
    assert.doesNotMatch(html, /Discount reason:|Enrollment concession/);
    assert.match(details, /Invoice No:|Invoice date:|Due date:/);
    const header = html.split('class="invoice-document-header"')[1].split("</table>")[0];
    const logoStyle = header.match(/<img[^>]*style="([^"]+)"/)[1];
    assert.doesNotMatch(logoStyle, /background:|border-radius:|padding:/);
    assert.match(logoStyle, /border:0/);
    assert.match(header, /background:#fff/);
    const doc = await PDFDocument.load(await buildInvoicePdf(record, null, "https://example.com/pay"));
    for (const text of ["Status:", "Issued by:", "Payment:", "Discount reason:", "Enrollment concession"]) {
      assert.ok(!pdfText(doc).includes(text), `PDF must omit ${text}`);
    }
    assert.equal(record.discount_reason, "Enrollment concession", "approval metadata must not be modified");
  }
  const ibmp = buildInvoiceHtml(invoice("IBMP"));
  assert.doesNotMatch(ibmp, /Issued by:|Status:|Discount reason:/);
});

test("PDF totals retain the same labels and amounts as the email", async () => {
  const record = invoice();
  const doc = await PDFDocument.load(await buildInvoicePdf(record, null));
  const text = pdfText(doc);
  for (const label of ["Subtotal", "Taxable value", "Verified payments received", "Balance after this installment is paid", "₹50,000.00"])
    assert.ok(text.includes(label), label);
});

test("invoice uses the supplied combined DMHCA wordmark, readable sections and legal footer", async () => {
  const record = invoice();
  const html = buildInvoiceHtml(record);
  assert.match(html, /DMHCA-invoice-wordmark.png/);
  assert.match(html, /width="160"[^>]*width:160px/);
  assert.doesNotMatch(html, />DMHCA<\/td>|Thank you for choosing|computer-generated/i);
  assert.match(html, /class="invoice-bank-details" style="margin-top:18px"/);
  assert.match(html, /<col style="width:22%">/);
  assert.match(html, /class="invoice-terms" style="margin-top:18px"/);
  assert.match(html, /font-size:20px;line-height:1.35">NEWDELHI MEDICAL HEALTH CARE PVT. LTD./);
  assert.match(html, /Online payments update automatically after provider confirmation/);
  assert.match(html, /receipt verification is required/);
  const doc = await PDFDocument.load(await buildInvoicePdf(record, null));
  const text = pdfText(doc);
  assert.equal(doc.getPageCount(), 1);
  assert.ok(text.includes("NEWDELHI MEDICAL HEALTH CARE PVT. LTD."));
  assert.ok(!text.includes("Thank you for choosing"));
  assert.ok(!text.includes("Finance verifies receipt before marking this invoice paid."));
});

test("DMHCA header retains the reference artwork at native size and its bottom rule", async () => {
  const asset = readFileSync(join(__dirname, "..", "public", "DMHCA-invoice-wordmark.png"));
  assert.equal(asset.readUInt32BE(16), 160);
  assert.equal(asset.readUInt32BE(20), 28);
  const html = buildInvoiceHtml(invoice());
  assert.match(html, /class="invoice-document-header"[^>]*style="border-bottom:1px solid #cbd5e1"/);
  assert.match(html, /width="160"[^>]*width:160px/);
  const doc = await PDFDocument.load(await buildInvoicePdf(invoice(), null));
  const images = doc.context.enumerateIndirectObjects().filter(([, object]) =>
    object instanceof PDFRawStream && object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
  assert.ok(images.some(([, image]) => image.dict.get(PDFName.of("Width"))?.asNumber() === 160
    && image.dict.get(PDFName.of("Height"))?.asNumber() === 28), "PDF must embed the reference artwork without substituting a font");
});

test("company and document schemas reject unsafe URLs, incomplete accounts and oversized fields", () => {
  assert.equal(invoiceCompanyProfile.safeParse(profile).success, true);
  for (const website of ["javascript:alert(1)", "http://example.com", "https://", "https://user:password@example.com"])
    assert.equal(invoiceCompanyProfile.safeParse({ ...profile, website }).success, false);
  assert.equal(invoiceCompanyProfile.safeParse({ ...profile, bank_accounts: [{ ...profile.bank_accounts[0], account_number: "" }] }).success, false);
  assert.equal(invoiceCompanyProfile.safeParse({ ...profile, bank_accounts: [{ ...profile.bank_accounts[0], ifsc: "", swift: "" }] }).success, false);
  assert.equal(invoiceDocumentDetails.safeParse({ student_id: "x".repeat(101) }).success, false);
  assert.equal(invoiceDocumentDetails.safeParse({ sac_code: "x".repeat(31) }).success, false);
});

test("line discounts and tax allocations preserve the exact final cent across multiple items", () => {
  const record = { ...invoice(), subtotal: 0.30, discount_amount: 0.01, tax_amount: 0.05, total: 0.34,
    invoice_items: [1, 2, 3].map(() => ({ description: "Item", quantity: 1, unit_price: 0.1, amount: 0.1 })) };
  const { items } = invoicePresentation(record);
  assert.equal(items.reduce((sum, item) => sum + Math.round(item.discount * 100), 0), 1);
  assert.equal(items.reduce((sum, item) => sum + Math.round(item.tax * 100), 0), 5);
  assert.equal(items.reduce((sum, item) => sum + Math.round(item.total * 100), 0), 34);
  const { taxes } = invoicePresentation(record);
  assert.deepEqual(taxes, [{ label: "CGST (9%)", amount: 0.03 }, { label: "SGST (9%)", amount: 0.02 }]);
  for (let i = 0; i < 2; i++) assert.equal(items.reduce((sum, item) => sum + Math.round(item.taxes[i] * 100), 0), Math.round(taxes[i].amount * 100));
});

test("GST components and obvious secure-payment button render consistently without changing checkout amounts", async () => {
  const record = { ...invoice(), tax_amount: 9152.54 };
  const presentation = invoicePresentation(record);
  assert.deepEqual(presentation.taxes.map(tax => tax.amount), [4576.27, 4576.27]);
  const html = buildInvoiceHtml(record, { paymentUrl: "https://example.com/pay" });
  for (const label of ["CGST (9%)", "SGST (9%)"]) assert.equal(html.split(label).length - 1, 2);
  assert.match(html, /class="invoice-pay-button"[^>]*border-radius:8px;box-shadow:/);
  assert.match(html, /Click Pay Now to make a secure payment/);
  const doc = await PDFDocument.load(await buildInvoicePdf(record, null, "https://example.com/pay"));
  const text = pdfText(doc);
  for (const label of ["CGST (9%)", "SGST (9%)", "₹4,576.27", "Click Pay Now to make a secure payment."])
    assert.ok(text.includes(label), label);
  const usd = invoicePresentation({ ...record, currency: "USD" });
  assert.deepEqual(usd.taxes, [{ label: "Tax", amount: 9152.54 }]);
  assert.equal(usd.items[0].taxes.length, 1);
  const paidHtml = buildInvoiceHtml(invoice("DMHCA", true), { paymentUrl: "https://example.com/pay" });
  assert.doesNotMatch(paidHtml, /invoice-pay-button|Click Pay Now/);
});

test("invoice footer keeps email-client detected address and contact links white", () => {
  for (const code of ["DMHCA", "IBMP"]) {
    const html = buildInvoiceHtml(invoice(code));
    assert.match(html, /\.invoice-document-footer,\.invoice-document-footer \*\{color:#fff!important\}/);
    assert.match(html, /\.invoice-document-footer a\{text-decoration:none!important\}/);
    assert.match(html, /Example registered address/);
    assert.match(html, /billing@example.com/);
  }
});

test("billing details have readable spacing, DMHCA GST and a compact palette-matched payment button", async () => {
  const record = invoice();
  const html = buildInvoiceHtml(record, { paymentUrl: "https://example.com/pay-current" });
  const details = html.split('class="invoice-document-details"')[1].split("</td>")[0];
  assert.match(details, /GST:<\/strong> 07AAICN9985A1Z3/);
  assert.match(details, /padding:3px 0;line-height:1.6/);
  const button = html.match(/<a class="invoice-pay-button"[\s\S]*?<\/a>/)[0];
  assert.match(button, /width:auto;background:#1c1d4e/);
  assert.match(button, />Pay Now<\/a>$/);
  assert.doesNotMatch(button, /&rarr;|aria-hidden/);
  assert.match(html, /class="invoice-document-footer" style="padding:16px 28px 8px/);
  assert.match(button, /href="https:\/\/example.com\/pay-current"/);
  assert.doesNotMatch(button, /20,000|INR|₹/);
  const text = pdfText(await PDFDocument.load(await buildInvoicePdf(record, null, "https://example.com/pay-current")));
  assert.ok(text.includes("GST: 07AAICN9985A1Z3"));
  assert.ok(text.includes("Pay Now"));
  assert.ok(!text.includes("Pay Now INR"));
  assert.equal(invoicePresentation(invoice("IBMP")).gstNumber, "07AAICN9985A1Z3");
  const simple = { ...record, payment_type: "one_shot", course_total: null, payment_summary: undefined,
    document_details: {}, billing_address: "", company_snapshot: {
    ...record.company_snapshot, tax_id: "", invoice_profile: { bank_accounts: profile.bank_accounts },
  } };
  assert.equal((await PDFDocument.load(await buildInvoicePdf(simple, null))).getPageCount(), 1, "a short invoice should still fit one page with readable details");
});

test("summary loader scopes reads to this enrollment and surfaces database failures", async () => {
  const queries = [];
  function client(failure) {
    return { from(table) {
      assert.equal(table, "invoices");
      const query = {
        select(value) { queries.push(value); return query; },
        eq(key, value) { assert.deepEqual([key, value], ["id", "first"]); return query; },
        maybeSingle: async () => ({ data: { course_total: 100000 }, error: null }),
        or(value) { assert.equal(value, "id.eq.first,parent_invoice_id.eq.first"); return query; },
        order(value) { assert.equal(value, "id"); return query; },
        range: async () => ({ data: family.map(row => ({ ...row, created_at: new Date().toISOString() })), error: failure }),
      };
      return query;
    } };
  }
  const { loadInvoicePaymentSummary } = load("src\\lib\\server\\invoice-payment-summary.ts", {
    "@/lib/server/operational": { databaseError: error => { if (error) throw error; } },
  });
  const result = await loadInvoicePaymentSummary(client(), invoice());
  assert.equal(result.outstanding, 70000);
  assert.ok(!JSON.stringify(result).includes('"id"'));
  await assert.rejects(loadInvoicePaymentSummary(client(new Error("Database unavailable")), invoice()), /Database unavailable/);
  assert.equal(await loadInvoicePaymentSummary({}, { ...invoice(), payment_type: "one_shot" }), undefined);
  assert.ok(queries.every(value => !value.includes("billing_") && !value.includes("token")));
});

test("summary loader reads every page of a long enrollment instead of truncating verified payments", async () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ id: `row-${i}`, total: 1, status: "paid", installment_number: i + 1 }));
  const ranges = [];
  const client = { from() {
    const query = {
      select: () => query, eq: () => query, or: () => query, order: () => query,
      maybeSingle: async () => ({ data: { course_total: 300 }, error: null }),
      range: async (start, end) => { ranges.push([start, end]); return { data: rows.slice(start, end + 1), error: null }; },
    };
    return query;
  } };
  const { loadInvoicePaymentSummary } = load("src\\lib\\server\\invoice-payment-summary.ts", {
    "@/lib/server/operational": { databaseError: error => { if (error) throw error; } },
  });
  const result = await loadInvoicePaymentSummary(client, { ...rows[0], payment_type: "installments" });
  assert.deepEqual(ranges, [[0, 199], [200, 399]]);
  assert.equal(result.paidToDate, 205);
  assert.equal(result.outstanding, 95);
});
