const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const ts = require("typescript");

function load(file, mocks = {}) {
  const api = {};
  const code = ts.transpileModule(readFileSync(join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  new Function("exports", "require", "fetch", code)(api, name => name in mocks ? mocks[name]
    : name.startsWith("@/") ? load(`${name.replace("@/", "src\\").replaceAll("/", "\\")}.ts`, mocks) : require(name),
  mocks.fetch ?? (() => assert.fail("Unexpected network request")));
  return api;
}

test("three independent course prices validate and select without conversion or fallback", () => {
  const { courseInput, coursePrice } = load("src\\lib\\billing.ts");
  const values = { name:"Test course",price_inr:"1000",price_usd:"25",price_ibmp_usd:"40",is_active:true };
  const course = { ...courseInput.parse(values),id:"test" };
  assert.equal(coursePrice(course,"DMHCA","INR"),1000);
  assert.equal(coursePrice(course,"DMHCA","USD"),25);
  assert.equal(coursePrice(course,"IBMP","USD"),40);
  assert.equal(coursePrice(course,"IBMP","INR"),null);
  for (const value of ["",null,undefined]) {
    const result = courseInput.parse({...values,price_ibmp_usd:value});
    assert.equal(result.price_ibmp_usd,value===undefined?undefined:null);
    assert.equal(coursePrice({...result,id:"test"},"IBMP","USD"),null);
  }
  for (const value of [0,-1,1.001,100000000,"bad"])
    assert.equal(courseInput.safeParse({...values,price_ibmp_usd:value}).success,false);
});

test("course API persists the independent IBMP USD fee and supports explicitly clearing it", async () => {
  let saved;
  const courseId = "40000000-0000-4000-8000-000000000001";
  const route = load("src\\app\\api\\courses\\route.ts",{
    "next/server":{NextResponse:{json:data=>data}},
    "@/lib/server/login":{checkOrigin(){}},
    "@/lib/server/auth":{
      requireUser:async()=>({user:{profile:{role:"admin"}},supabase:{from:table=>{
        assert.equal(table,"courses");
        return {update:values=>{saved=values;return {eq:(_key,id)=>{
          assert.equal(id,courseId);
          return {select:()=>({maybeSingle:async()=>({data:{id},error:null})})};
        }};}};
      }}}),
      readJson:request=>request.json(),jsonError:error=>{throw error;},
    },
    "@/lib/server/operational":{parseInput:(schema,value)=>schema.parse(value),databaseError:error=>{if(error)throw error;}},
  });
  for (const price_ibmp_usd of [40,"",undefined]) {
    await route.POST(new Request("https://crm.example/api/courses",{method:"POST",body:JSON.stringify({
      kind:"course",id:courseId,values:{name:"Test",price_inr:1000,price_usd:25,price_ibmp_usd,is_active:true},
    })}));
    assert.equal(saved.price_ibmp_usd,price_ibmp_usd===""?null:price_ibmp_usd);
    if (price_ibmp_usd===undefined) assert.equal(Object.hasOwn(saved,"price_ibmp_usd"),false,"older clients must not clear an existing IBMP fee");
    assert.equal(saved.price_inr,1000);
    assert.equal(saved.price_usd,25);
  }
});

test("course catalog is readable by signed-in users while only admins can manage courses", async () => {
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  let queriedCompanies = false;
  const route = load("src\\app\\api\\courses\\route.ts", {
    "next/server": { NextResponse: { json: data => data } },
    "@/lib/server/login": { checkOrigin() {} },
    "@/lib/server/auth": {
      HttpError,
      requireUser: async () => ({
        user: { profile: { role: "counselor" }, permissions: [] },
        supabase: { from: table => {
          if (table === "invoice_companies") {
            queriedCompanies = true;
            return { select: () => ({ order: async () => ({ data: [], error: null }) }) };
          }
          return { select: () => ({ order: () => ({ limit: async () => ({ data: [{ id: "course-1" }], error: null }) }) }) };
        } },
      }),
      readJson: request => request.json(),
      jsonError: error => ({ status: error.status ?? 500, error: error.message }),
    },
    "@/lib/server/operational": { databaseError: error => { if (error) throw error; } },
  });
  const catalog = await route.GET();
  assert.deepEqual(catalog.courses, [{ id: "course-1" }]);
  assert.deepEqual(catalog.companies, []);
  assert.equal(catalog.canManage, false);
  assert.equal(queriedCompanies, false, "billing company details are not loaded for non-admin users");
  const denied = await route.POST(new Request("https://crm.example/api/courses", {
    method: "POST",
    body: JSON.stringify({ kind: "course", values: {} }),
  }));
  assert.equal(denied.status, 403);
});

test("Razorpay creates fixed-amount INR and USD links in their own subunits", async () => {
  const calls = [];
  const { createInvoicePaymentLink } = load("src\\lib\\server\\razorpay.ts",{
    "@/lib/server/env":{requireEnv:()=>assert.fail("Unexpected environment access")},
    "@/lib/server/integration-settings":{
      getIntegrationConfig:async()=>({RAZORPAY_KEY_ID:"test",RAZORPAY_KEY_SECRET:"test"}),
      requireIntegrationValue:(values,key)=>values[key],
    },
    fetch:async(url,options)=>{
      assert.equal(url,"https://api.razorpay.com/v1/payment_links");
      calls.push(JSON.parse(options.body));
      return Response.json({id:"plink_test",short_url:"https://rzp.io/i/test",status:"created"});
    },
  });
  const input = {invoiceId:"fixture",invoiceNo:"TEST",leadId:"fixture",leadName:"Student",leadEmail:"student@example.com",amount:123.45};
  for (const currency of ["INR","USD"]) await createInvoicePaymentLink({...input,currency});
  assert.deepEqual(calls.map(call=>[call.currency,call.amount]),[["INR",12345],["USD",12345]]);
  await assert.rejects(createInvoicePaymentLink({...input,currency:"EUR"}),/INR and USD only/);
});

test("signed Razorpay USD webhook verifies exact currency, amount and reference before marking Paid", async () => {
  let recorded = 0, receipts = 0;
  const invoice = {id:"50000000-0000-4000-8000-000000000001",total:40,currency:"USD",payment_revision:1};
  const link = {id:"plink_usd",status:"paid",reference_id:invoice.id,amount:4000,currency:"USD"};
  const payment = {id:"pay_usd",status:"captured",amount:4000,currency:"USD",method:"card"};
  const route = load("src\\app\\api\\webhooks\\razorpay\\route.ts",{
    "next/server":{NextResponse:{json:data=>({status:200,data})}},
    "@/lib/server/auth":{HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}},
      jsonError:error=>({status:error.status??500,error:error.message})},
    "@/lib/server/razorpay":{razorpaySignatureValid:(_raw,signature)=>signature==="valid"},
    "@/lib/server/integration-settings":{getIntegrationConfig:async()=>({}),requireIntegrationValue:()=>"test"},
    "@/lib/server/invoice-delivery":{sendPaymentReceipt:async()=>{receipts++;}},
    "@/lib/server/operational":{databaseError:error=>{if(error)throw error;}},
    "@/lib/supabase/server":{getSupabaseAdminClient:()=>({
      from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:invoice,error:null})})})}),
      rpc:async(name,args)=>{
        assert.equal(name,"operational_record_payment_link");
        assert.equal(args.p_currency,"USD");assert.equal(args.p_amount_paise,4000);
        recorded++;return {data:true,error:null};
      },
    })},
  });

  test("USD payment recovery verifies Razorpay amounts instead of falling through to Stripe", async () => {
    const { verifySavedInvoicePayment } = load("src\\lib\\server\\invoice-payment-verification.ts",{
      "@/lib/server/auth":{HttpError:class extends Error{constructor(status,message){super(message);this.status=status;}}},
      "@/lib/server/stripe":{stripeRequest:async()=>assert.fail("USD Razorpay verification must not call Stripe")},
      "@/lib/server/razorpay":{razorpayRequest:async path=>path.startsWith("payment_links/") ? {
        id:"plink_usd",short_url:"https://rzp.io/i/test",status:"paid",amount:4000,amount_paid:4000,currency:"USD",
        notes:{invoice_id:"fixture"},payments:[{payment_id:"pay_usd"}],
      } : {id:"pay_usd",status:"captured",amount:4000,currency:"USD"}},
    });
    const invoice = {id:"fixture",total:40,currency:"USD",razorpay_payment_link_id:"plink_usd",razorpay_short_url:"https://rzp.io/i/test"};
    const payment = await verifySavedInvoicePayment(invoice);
    assert.equal(payment.provider,"razorpay");assert.equal(payment.currency,"USD");assert.equal(payment.amount,4000);
    await assert.rejects(verifySavedInvoicePayment({...invoice,total:41}),/does not match/);
  });
  const send = signature => route.POST(new Request("https://crm.example/webhook",{method:"POST",
    headers:{"x-razorpay-signature":signature},body:JSON.stringify({event:"payment_link.paid",
      payload:{payment_link:{entity:link},payment:{entity:payment}}})}));
  assert.equal((await send("invalid")).status,401);
  assert.equal((await send("valid")).status,200);
  assert.equal(recorded,1);assert.equal(receipts,1);
  invoice.currency="INR";
  assert.equal((await send("valid")).status,400);
  assert.equal(recorded,1);
});
