const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createHash } = require("node:crypto");

function statusPageFixture() {
  let effect, cleanup, requests = 0, nextResponse = { status: "expired" };
  const states = [], errors = [], timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  const document = {
    visibilityState: "visible",
    addEventListener: (name, handler) => documentEvents.set(name, handler),
    removeEventListener: name => documentEvents.delete(name),
  };
  const source = readFileSync(join(__dirname, "..", "src", "app", "invoice-status", "[token]", "page.tsx"), "utf8");
  const policy = {};
  new Function("exports", ts.transpileModule(readFileSync(join(__dirname, "..", "src", "lib", "invoice-policy.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText)(policy);
  const exports = {};
  let stateIndex = 0;
  const mocks = {
    react: {
      useEffect: callback => { effect = callback; },
      useState: initial => [initial, stateIndex++ === 0 ? value => states.push(value) : value => errors.push(value)],
    },
    "react/jsx-runtime": { jsx: () => null, jsxs: () => null },
    "next/navigation": { useParams: () => ({ token: "a".repeat(43) }) },
    "@/lib/billing": {},
    "@/lib/invoice-document": { buildInvoiceHtml: () => "" },
    "@/lib/invoice-policy": policy,
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, {
    exports, Error, require: name => { assert.ok(name in mocks, name); return mocks[name]; },
    document, window: {
      addEventListener: (name, handler) => windowEvents.set(name, handler),
      removeEventListener: name => windowEvents.delete(name),
    },
    fetch: async () => {
      requests++;
      if (nextResponse instanceof Error) throw nextResponse;
      return { ok: true, json: async () => nextResponse };
    },
    setTimeout: (callback, delay) => { assert.equal(delay, 2000); const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  exports.default();
  cleanup = effect();
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    states, errors, timers, windowEvents, documentEvents, document, flush,
    requests: () => requests,
    respond: value => { nextResponse = value; },
    tick: async () => { assert.equal(timers.size, 1); const callback = timers.values().next().value; await callback(); await flush(); },
    cleanup: () => cleanup(),
  };
}

test("public invoice refresh survives expiry and transient errors until verified Paid", async () => {
  const page = statusPageFixture();
  await page.flush();
  assert.equal(page.states.at(-1).status, "expired");
  assert.equal(page.timers.size, 1);
  page.respond(new Error("Network unavailable"));
  await page.tick();
  assert.equal(page.errors.at(-1), "Network unavailable");
  assert.equal(page.timers.size, 1, "failed refresh must retry");
  page.respond({ status: "paid", paidAt: "2026-11-07T09:00:00Z", paymentUrl: null });
  await page.tick();
  assert.equal(page.states.at(-1).status, "paid");
  assert.equal(page.errors.at(-1), "");
  assert.equal(page.timers.size, 0);
  page.windowEvents.get("focus")();
  await page.flush();
  assert.equal(page.requests(), 3, "verified Paid is terminal");
  page.cleanup();
  assert.equal(page.windowEvents.size, 0);
  assert.equal(page.documentEvents.size, 0);
});

test("returning from checkout refreshes once immediately without overlapping requests", async () => {
  const page = statusPageFixture();
  await page.flush();
  page.respond({ status: "sent" });
  page.windowEvents.get("focus")();
  page.documentEvents.get("visibilitychange")();
  await page.flush();
  assert.equal(page.requests(), 2);
  assert.equal(page.timers.size, 1);
  page.document.visibilityState = "hidden";
  page.documentEvents.get("visibilitychange")();
  await page.flush();
  assert.equal(page.requests(), 2);
  page.cleanup();
  assert.equal(page.timers.size, 0);
});

test("hidden public invoices avoid background requests and resume the two-second status check", async () => {
  const page = statusPageFixture();
  await page.flush();
  page.document.visibilityState = "hidden";
  await page.tick();
  assert.equal(page.requests(), 1);
  assert.equal(page.timers.size, 1);
  page.document.visibilityState = "visible";
  page.respond({ status: "paid" });
  page.documentEvents.get("visibilitychange")();
  await page.flush();
  assert.equal(page.requests(), 2);
  assert.equal(page.states.at(-1).status, "paid");
  assert.equal(page.timers.size, 0);
  page.cleanup();
});

function loadRoute(mocks) {
  const load = file => {
    const api = {};
    new Function("exports", "require", ts.transpileModule(readFileSync(join(__dirname, "..", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText)(api, name => name in mocks ? mocks[name] : name.startsWith("@/") ? load(`${name.replace("@/", "src\\").replaceAll("/", "\\")}.ts`) : require(name));
    return api;
  };
  const exports = {};
  const source = readFileSync(join(__dirname, "..", "src", "app", "api", "invoice-status", "[token]", "route.ts"), "utf8");
  const policy={invoiceWindowExpired:invoice=>!!invoice.payment_expires_at&&new Date(invoice.payment_expires_at).getTime()<=Date.now()};
  new Function("exports", ts.transpileModule(readFileSync(join(__dirname,"..","src","lib","invoice-policy.ts"),"utf8"), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021},
  }).outputText)(policy);
  const branding = {}, billing = {};
  for (const [file, api] of [["invoice-branding", branding], ["billing", billing]]) {
    const code = readFileSync(join(__dirname, "..", "src", "lib", `${file}.ts`), "utf8");
    new Function("exports", "require", ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    }).outputText)(api, require);
  }
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, { exports, require: name => name==="@/lib/invoice-policy"?policy:name==="@/lib/invoice-branding"?branding:name==="@/lib/billing"?billing:name in mocks ? mocks[name] : load(`${name.replace("@/", "src\\").replaceAll("/", "\\")}.ts`), Buffer });
  return exports;
}

test("public invoice status uses a random token hash and returns the billing snapshot without internal IDs", async () => {
  const token = Buffer.alloc(32, 7).toString("base64url");
  const expectedHash = createHash("sha256").update(token).digest("hex");
  let queriedHash;
  let selected;
  const route = loadRoute({
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200, headers: options?.headers }) } },
    "@/lib/server/razorpay": { statusTokenHash: value => createHash("sha256").update(value).digest("hex") },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => ({
      from: table => {
        assert.equal(table, "invoices");
        return {
          select: fields => { selected = fields; return { eq: (_field, value) => {
            queriedHash = value;
            return { maybeSingle: async () => ({ data: {
              invoice_no: "INV-1", created_at: "2026-10-20T10:00:00Z", due_date: "2026-10-25",
              billing_name: "Customer", billing_email: "customer@example.com", billing_address: "Street 1",
              subtotal: "125.00", discount_amount: "0", discount_reason: null, tax_amount: "0", total: "125.00",
              currency: "INR", status: "paid", paid_at: "2026-10-24T10:00:00Z", notes: "Thank you",
              company_code: "DMHCA", company_snapshot: null, payment_type: "one_shot", course_total: null, installment_number: null,
              invoice_items: [{ description: "Course enrollment", quantity: "1", unit_price: "125", amount: "125" }],
            }, error: null }) };
          } }; },
        };
      },
    }) },
  });
  const result = await route.GET(new Request("https://crm.example/api/invoice-status/token"), { params: Promise.resolve({ token }) });
  assert.equal(result.status, 200);
  assert.equal(queriedHash, expectedHash);
  assert.match(selected, /invoice_no,created_at,invoice_date,due_date,billing_name,billing_email,billing_address/);
  assert.match(selected, /invoice_items\(description,quantity,unit_price,amount\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    invoiceNo: "INV-1", issueDate: "2026-10-20T10:00:00Z", dueDate: "2026-10-25",
    billingName: "Customer", billingEmail: "customer@example.com", billingAddress: "Street 1", documentDetails: {},
    items: [{ description: "Course enrollment", quantity: 1, unitPrice: 125, amount: 125 }],
    subtotal: 125, discountAmount: 0, discountReason: null, taxAmount: 0,
    total: 125, currency: "INR", status: "paid", paidAt: "2026-10-24T10:00:00Z",
    courseTotal: null, installmentNumber: null, paymentType: "one_shot", notes: "Thank you",
    company: { name: "NEWDELHI MEDICAL HEALTH CARE PVT. LTD.", address: "", taxId: "", code: "DMHCA" },
    primaryColor: "#1c1d4e", accentColor: "#c44754", paymentUrl: null,
    expiresAt: null,
  });
  assert.equal("leadEmail" in result.data, false);
  assert.equal("leadName" in result.data, false);
  assert.equal(result.headers["Cache-Control"], "no-store");
});

test("malformed status tokens return the same unavailable response without database access", async () => {
  let calls = 0;
  const route = loadRoute({
    "next/server": { NextResponse: { json: (data, options) => ({ data, status: options?.status ?? 200 }) } },
    "@/lib/server/razorpay": { statusTokenHash: value => value },
    "@/lib/supabase/server": { getSupabaseAdminClient: () => { calls++; throw new Error("Should not query"); } },
  });
  const result = await route.GET(new Request("https://crm.example/api/invoice-status/token"), { params: Promise.resolve({ token: "short" }) });
  assert.equal(result.status, 404);
  assert.equal(calls, 0);
});

test("public payment links select the correct provider and disappear immediately after verified payment",async()=>{
  const token=Buffer.alloc(32,8).toString("base64url");
  const invoice={invoice_no:"INV-PAY",total:"100.00",currency:"USD",status:"sent",paid_at:null,payment_type:"one_shot",
    company_snapshot:{legal_name:"IBMP",primary_color:"#0b1e3b",accent_color:"#d7b770"},
    stripe_checkout_url:"https://checkout.stripe.com/c/pay/test",razorpay_short_url:"https://rzp.io/i/test"};
  let error=null;
  const route=loadRoute({
    "next/server":{NextResponse:{json:(data,options)=>({data,status:options?.status??200})}},
    "@/lib/server/razorpay":{statusTokenHash:value=>value},
    "@/lib/supabase/server":{getSupabaseAdminClient:()=>({from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:invoice,error})})})})})},
  });
  const read=()=>route.GET(new Request("https://crm.example/status"),{params:Promise.resolve({token})});
  assert.equal((await read()).data.paymentUrl,invoice.razorpay_short_url);
  assert.equal((await read()).data.company.name,"NEWDELHI MEDICAL HEALTH CARE PVT. LTD.");
  invoice.currency="INR";
  assert.equal((await read()).data.paymentUrl,invoice.razorpay_short_url);
  invoice.payment_expires_at=new Date(Date.now()-1).toISOString();
  assert.equal((await read()).data.status,"expired");
  assert.equal((await read()).data.paymentUrl,null);
  invoice.payment_expires_at=new Date(Date.now()+86400000).toISOString();
  invoice.tax_review_required=true;
  assert.equal((await read()).data.status,"pending_review");
  assert.equal((await read()).data.paymentUrl,null);
  invoice.status="paid";
  assert.equal((await read()).data.status,"paid","verified paid status wins over deadline or review flags");
  assert.equal((await read()).data.paymentUrl,null);
  error={code:"connection-failed",message:"Private database diagnostic"};
  const failed=await read();
  assert.equal(failed.status,503);
  assert.ok(!JSON.stringify(failed).includes("Private database diagnostic"));
});

test("public installment status returns printable details and verified family balances without internal identifiers",async()=>{
  const token=Buffer.alloc(32,10).toString("base64url");
  const record={id:"internal-current",parent_invoice_id:"internal-root",invoice_no:"INV-PUBLIC",
    created_at:new Date().toISOString(),payment_type:"installments",currency:"INR",status:"sent",total:20000,
    subtotal:20000,discount_amount:0,tax_amount:0,course_total:100000,
    document_details:{student_id:"STUDENT-TEST",billing_phone:"Test phone",place_of_supply:"Test State",course_details:"Online / 12 months",sac_code:"SAC-TEST"},
    company_snapshot:{code:"IBMP",legal_name:"IBMP",invoice_profile:{billing_email:"billing@example.com",bank_accounts:[]}}};
  let familyError=null;
  const admin={from:()=>{
    let field;
    const query={
      select:()=>query,eq:(key)=>{field=key;return query;},order:()=>query,
      maybeSingle:async()=>({data:field==="status_token_hash"?record:{course_total:100000},error:null}),
      or:value=>{assert.equal(value,"id.eq.internal-root,parent_invoice_id.eq.internal-root");return query;},
      range:async()=>({data:[{id:"internal-root",total:30000,status:"paid",installment_number:1},
        {...record,installment_number:2}],error:familyError}),
    };
    return query;
  }};
  const route=loadRoute({
    "next/server":{NextResponse:{json:(data,options)=>({data,status:options?.status??200})}},
    "@/lib/server/razorpay":{statusTokenHash:value=>value},
    "@/lib/supabase/server":{getSupabaseAdminClient:()=>admin},
    "@/lib/server/operational":{databaseError:error=>{if(error)throw error;}},
  });
  const read=()=>route.GET(new Request("https://crm.example/status"),{params:Promise.resolve({token})});
  const result=await read();
  assert.equal(result.status,200);
  assert.equal(result.data.documentDetails.student_id,"STUDENT-TEST");
  assert.equal(result.data.company.invoiceProfile.billing_email,"billing@example.com");
  assert.deepEqual([result.data.paymentSummary.paidToDate,result.data.paymentSummary.outstanding,result.data.paymentSummary.balanceAfterPayment],[30000,70000,50000]);
  assert.ok(!JSON.stringify(result.data).includes("internal-"));
  record.status="paid";
  const paid=await read();
  assert.equal(paid.data.paymentUrl,null);
  assert.equal(paid.data.paymentSummary.outstanding,50000);
  assert.equal(paid.data.paymentSummary.balanceAfterPayment,50000);
  familyError=new Error("Private balance diagnostic");
  const failed=await read();
  assert.equal(failed.status,503);
  assert.ok(!JSON.stringify(failed).includes("Private balance diagnostic"));
});

test("public Razorpay payment endpoint validates origin and opaque token without creating checkout",async()=>{
  let queries=0,checkout=0,allowOrigin=false;
  class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
  const token=Buffer.alloc(32,9).toString("base64url");
  const invoice={id:"invoice",payment_type:"one_shot",currency:"USD",status:"sent",razorpay_short_url:"https://rzp.io/i/test"};
  const route=loadRoute({
    "next/server":{NextResponse:{json:(data,options)=>({data,status:options?.status??200})}},
    "@/lib/server/auth":{HttpError,jsonError:error=>({status:error.status??500,error:error.message})},
    "@/lib/server/login":{checkOrigin:()=>{if(!allowOrigin)throw new HttpError(403,"Invalid origin");}},
    "@/lib/server/operational":{databaseError:error=>{if(error)throw error;}},
    "@/lib/server/razorpay":{statusTokenHash:value=>value},
    "@/lib/supabase/server":{getSupabaseAdminClient:()=>{queries++;return {from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:invoice,error:null})})})})};}},
    "@/lib/server/invoice-checkout":{ensureInvoiceCheckout:async(_admin,row,value)=>{
      assert.equal(row,invoice);assert.equal(value,token);checkout++;return "https://checkout.stripe.com/c/pay/cs_test";
    }},
  });
  const request=new Request("https://crm.example/status",{method:"POST"});
  const post=value=>route.POST(request,{params:Promise.resolve({token:value})});
  assert.equal((await post(token)).status,403);assert.equal(queries,0);
  allowOrigin=true;
  assert.equal((await post("invalid")).status,404);assert.equal(queries,0);
  const result=await post(token);assert.match(result.data.url,/rzp.io/);assert.equal(checkout,0);
  invoice.payment_type="loan";
  assert.equal((await post(token)).status,409);assert.equal(checkout,0);
});
