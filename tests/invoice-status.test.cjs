const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { createHash } = require("node:crypto");

function loadRoute(mocks) {
  const exports = {};
  const source = readFileSync(join(__dirname, "..", "src", "app", "api", "invoice-status", "[token]", "route.ts"), "utf8");
  const policy={invoiceWindowExpired:invoice=>!!invoice.payment_expires_at&&new Date(invoice.payment_expires_at).getTime()<=Date.now()};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText, { exports, require: name => name==="@/lib/invoice-policy"?policy:mocks[name], Buffer });
  return exports;
}

test("public invoice status uses a random token hash and returns no customer PII", async () => {
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
  assert.match(selected, /invoice_no,created_at,due_date,billing_name,billing_email,billing_address/);
  assert.match(selected, /invoice_items\(description,quantity,unit_price,amount\)/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.data)), {
    invoiceNo: "INV-1", issueDate: "2026-10-20T10:00:00Z", dueDate: "2026-10-25",
    billingName: "Customer", billingEmail: "customer@example.com", billingAddress: "Street 1",
    items: [{ description: "Course enrollment", quantity: 1, unitPrice: 125, amount: 125 }],
    subtotal: 125, discountAmount: 0, discountReason: null, taxAmount: 0,
    total: 125, currency: "INR", status: "paid", paidAt: "2026-10-24T10:00:00Z",
    courseTotal: null, installmentNumber: null, paymentType: "one_shot", notes: "Thank you",
    company: { name: "DMHCA", address: "", taxId: "", code: "DMHCA" },
    primaryColor: "#800020", accentColor: "#f7cbd7", paymentUrl: null,
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
  assert.equal((await read()).data.paymentUrl,`/api/invoice-status/${token}`);
  assert.equal((await read()).data.company,"IBMP");
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

test("public Stripe checkout validates origin and opaque token before provider work",async()=>{
  let queries=0,checkout=0,allowOrigin=false;
  class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
  const token=Buffer.alloc(32,9).toString("base64url");
  const invoice={id:"invoice",payment_type:"one_shot"};
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
  const result=await post(token);assert.match(result.data.url,/checkout.stripe.com/);assert.equal(checkout,1);
  invoice.payment_type="loan";
  assert.equal((await post(token)).status,409);assert.equal(checkout,1);
});
