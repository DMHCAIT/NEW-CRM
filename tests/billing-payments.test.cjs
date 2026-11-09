const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { createHmac } = require("node:crypto");
const { pdfText } = require("./helpers/invoice-pdf.cjs");
class HttpError extends Error { constructor(status,message) { super(message); this.status=status; } }
const root=path.join(__dirname,"..");
function load(file,mocks={}) {
  const exports={};
  const output=ts.transpileModule(fs.readFileSync(path.join(root,file),"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021},
  }).outputText;
  new Function("exports","require","fetch",output)(exports,name=>{
    if(name in mocks) return mocks[name];
    if(name==="@/lib/server/auth") return {HttpError,isEmail:value=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),jsonError:error=>({status:error.status??500,error:error.message})};
    if(name==="@/lib/server/env") return {appUrl:()=>"https://crm.example",requireEnv:()=> "test-secret"};
    if(name==="@/lib/server/operational") return {databaseError:error=>{if(error)throw error;},integrationRequirements:{razorpay:[],stripe:[],smtp:[]}};
    if(name==="next/server") return {NextResponse:{json:data=>({status:200,data})}};
    if(name.startsWith("@/")) return load(`${name.replace("@/","src\\").replaceAll("/","\\")}.ts`,mocks);
    return require(name);
  },mocks.fetch??(()=>assert.fail("Unexpected network request")));
  return exports;
}
const invoiceId="50000000-0000-4000-8000-000000000001";
const secret="whsec_test_secret";
const settings={
  getIntegrationConfig:async()=>({STRIPE_SECRET_KEY:"sk_test_example",STRIPE_WEBHOOK_SECRET:secret}),
  requireIntegrationValue:(values,key)=>values[key],
};
test("Stripe Checkout binds fixed USD amount, invoice, customer and stable return status URL",async()=>{
  let sent;
  const api=load("src\\lib\\server\\stripe.ts",{
    "@/lib/server/integration-settings":settings,
    fetch:async(url,init)=>{sent={url,init};return Response.json({id:"cs_test_session",url:"https://checkout.stripe.com/c/pay/cs_test_session"});},
  });
  await api.createStripeCheckout({invoiceId,invoiceNo:"INV-TEST",amount:123.45,email:"lead@example.com",statusToken:"public-token"});
  assert.equal(sent.url,"https://api.stripe.com/v1/checkout/sessions");
  assert.equal(sent.init.headers["Idempotency-Key"],`invoice-${invoiceId}`);
  assert.equal(sent.init.redirect,"error");
  assert.equal(sent.init.cache,"no-store");
  assert.equal(sent.init.body.get("line_items[0][price_data][currency]"),"usd");
  assert.equal(sent.init.body.get("line_items[0][price_data][unit_amount]"),"12345");
  assert.equal(sent.init.body.get("metadata[invoice_id]"),invoiceId);
  assert.equal(sent.init.body.get("success_url"),"https://crm.example/invoice-status/public-token");
  assert.equal(sent.init.body.get("cancel_url"),sent.init.body.get("success_url"));
  await assert.rejects(api.createStripeCheckout({invoiceId,invoiceNo:"INV",amount:0.50,email:"a@example.com",statusToken:"t"}),/at least/);
});
test("Stripe signatures verify exact payload, timestamp tolerance and rotated signatures",()=>{
  const api=load("src\\lib\\server\\stripe.ts");
  const raw='{"type":"checkout.session.completed"}';
  const now=Date.now(),timestamp=Math.floor(now/1000);
  const digest=createHmac("sha256",secret).update(`${timestamp}.${raw}`).digest("hex");
  assert.equal(api.stripeSignatureValid(raw,`t=${timestamp},v1=${digest}`,secret,now),true);
  assert.equal(api.stripeSignatureValid(raw,`t=${timestamp},v1=${"a".repeat(64)},v1=${digest}`,secret,now),true);
  assert.equal(api.stripeSignatureValid(raw+" ",`t=${timestamp},v1=${digest}`,secret,now),false);
  assert.equal(api.stripeSignatureValid(raw,`t=${timestamp},v1=${digest}`,secret,now+301000),false);
  assert.equal(api.stripeSignatureValid(raw,null,secret,now),false);
});
test("Stripe webhook rejects unsigned/unpaid/mismatched events and processes signed paid sessions",async()=>{
  let acquired=0,recorded=0,receipts=0;
  const stripe=load("src\\lib\\server\\stripe.ts");
  const route=load("src\\app\\api\\webhooks\\stripe\\route.ts",{
    "@/lib/server/integration-settings":settings,
    "@/lib/server/stripe":stripe,
    "@/lib/supabase/server":{getSupabaseAdminClient:()=>{acquired++;return {rpc:async(name,args)=>{
      assert.equal(name,"operational_record_stripe_payment");
      assert.equal(args.p_invoice_id,invoiceId);assert.equal(args.p_amount_cents,10000);
      recorded++;return {data:recorded===1,error:null};
    }};}},
    "@/lib/server/invoice-delivery":{sendPaymentReceipt:async(_admin,id)=>{assert.equal(id,invoiceId);receipts++;}},
  });
  const session={id:"cs_test_session",mode:"payment",payment_status:"paid",client_reference_id:invoiceId,
    metadata:{invoice_id:invoiceId},amount_total:10000,currency:"usd",payment_intent:"pi_test_payment"};
  const post=async(object=session,type="checkout.session.completed",signed=true)=>{
    const raw=JSON.stringify({type,data:{object}});
    const timestamp=Math.floor(Date.now()/1000);
    const signature=createHmac("sha256",secret).update(`${timestamp}.${raw}`).digest("hex");
    return route.POST(new Request("https://crm.example/api/webhooks/stripe",{method:"POST",body:raw,
      headers:signed?{"stripe-signature":`t=${timestamp},v1=${signature}`}:{}}));
  };
  assert.equal((await post(session,undefined,false)).status,401);
  assert.equal(acquired,0);
  assert.equal((await post({...session,payment_status:"unpaid"})).data.pending,true);
  assert.equal(acquired,0);
  assert.equal((await post({...session,currency:"inr"})).status,400);
  assert.equal((await post({...session,metadata:{invoice_id:"50000000-0000-4000-8000-000000000002"}})).status,400);
  assert.equal((await post(session,"payment_intent.succeeded")).data.ignored,true);
  assert.equal(acquired,0);
  assert.equal((await post()).data.recorded,true);
  assert.equal((await post()).data.recorded,false);
  assert.equal(receipts,2,"idempotent receipt helper must retry failed delivery on webhook retries");
  assert.equal((await post(session,"checkout.session.async_payment_succeeded")).status,200);
});

function deliveryFixture(currency="INR",paymentType="one_shot"){
  const invoice={id:invoiceId,invoice_no:"INV-TEST",lead_id:"lead",created_by:"creator",status:"sent",total:100,subtotal:100,
    tax_amount:0,discount_amount:0,discount_reason:null,notes:null,currency,payment_type:paymentType,
    billing_name:"Saved Customer",billing_email:"saved@example.com",billing_address:"Saved address",
    creator_email:"creator@example.com",owner_email:"owner@example.com",created_at:new Date().toISOString(),due_date:null,
    payment_expires_at:new Date(Date.now()+4*86400000).toISOString()};
  const calls=[],updates=[],emails=[];
  const family=[invoice];
  let smtpFailure=false,saveFailure=false,pdfFailure=false,ownerEmail="owner@example.com",ownerError=null,stripeConfigured=true;
  const admin={from:table=>{
    assert.ok(["invoices","leads","profiles"].includes(table));
    let update;
    const query={
      update:values=>{update=values;return query;},eq:()=>query,is:()=>query,select:()=>query,
      or:()=>query,order:()=>query,range:async(start,end)=>({data:family.slice(start,end+1),error:null}),
      maybeSingle:async()=>{
        if(table==="leads")return {data:{id:"lead",name:"Lead",email:"live@example.com",assignee_id:"current-owner"},error:null};
        if(table==="profiles")return {data:{email:ownerEmail},error:ownerError};
        if(update){
          updates.push(update);
          if(saveFailure&&(update.stripe_session_id||update.razorpay_payment_link_id))return {data:null,error:new Error("Persistence unavailable")};
          Object.assign(invoice,update);return {data:{id:invoiceId},error:null};
        }
        return {data:invoice,error:null};
      },
      then(resolve,reject){return query.maybeSingle().then(resolve,reject);},
    };
    return query;
  }};
  const helpers=load("src\\lib\\server\\invoice-delivery.ts",{
    "@/lib/server/integration-settings":{
      integrationStatus:async provider=>({configured:provider!=="stripe"||stripeConfigured,missing:provider==="stripe"&&!stripeConfigured?["STRIPE_SECRET_KEY","STRIPE_WEBHOOK_SECRET"]:[]}),
      encryptIntegrationValues:values=>Buffer.from(JSON.stringify(values)).toString("base64"),
      decryptIntegrationValues:value=>JSON.parse(Buffer.from(value,"base64").toString()),
    },
    "@/lib/server/razorpay":{
      createPublicStatusToken:()=>({token:"random-public-status-token",hash:"hashed-token"}),
      createInvoicePaymentLink:async input=>{calls.push({provider:"razorpay",input});return {id:"plink_test",short_url:"https://rzp.io/i/test"};},
    },
    "@/lib/server/stripe":{createStripeCheckout:async input=>{calls.push({provider:"stripe",input});return {id:"cs_test",url:"https://checkout.stripe.com/c/pay/test"};}},
    "@/lib/server/invoice-checkout":{ensureInvoiceCheckout:async(_admin,input)=>{
      calls.push({provider:"stripe",input});
      invoice.stripe_session_id="cs_test";invoice.stripe_checkout_url="https://checkout.stripe.com/c/pay/test";
      if(saveFailure){invoice.payment_link_lock_at="retained";throw new Error("Reconcile persistence failure");}
      return invoice.stripe_checkout_url;
    }},
    "@/lib/server/invoice-pdf":{buildInvoicePdf:async(record,lead,paymentUrl,viewUrl)=>{
      if(pdfFailure)throw new Error("PDF preparation failed");
      calls.push({pdf:true,paymentUrl,viewUrl,record});return Buffer.from("pdf");
    }},
    "@/lib/server/mailer":{
      emailLayout:(_title,body)=>body,escapeHtml:value=>value,
      sendMail:async options=>{if(smtpFailure)throw new Error("SMTP delivery uncertain");emails.push(options);return "smtp-message";},
    },
  });
  return {invoice,admin,calls,updates,emails,helpers,family,
    send:()=>helpers.deliverInvoice(admin,invoice,{id:"lead",name:"Live Name",email:"live@example.com"},"creator@example.com"),
    failSmtp:()=>{smtpFailure=true;},failPersistence:()=>{saveFailure=true;},
    failPdf:()=>{pdfFailure=true;},setOwnerEmail:value=>{ownerEmail=value;},failOwner:()=>{ownerError=new Error("Owner lookup failed");},
    disableStripe:()=>{stripeConfigured=false;},
  };
}
test("invoice delivery routes INR and USD to Razorpay and copies creator plus assigned owner",async()=>{
  for(const currency of ["INR","USD"]){
    const f=deliveryFixture(currency);
    await f.send();
    assert.equal(f.calls[0].provider,"razorpay");
    assert.equal(f.calls[0].input.currency,currency);
    assert.equal(f.calls.filter(call=>call.provider).length,1);
    assert.equal(f.calls.find(call=>call.pdf).paymentUrl,"https://rzp.io/i/test");
    assert.match(f.emails[0].html,/>Pay Now<\/a>/);
    assert.doesNotMatch(f.emails[0].html,/Hello |Please find your invoice|A copy is sent|Keep this invoice/);
    assert.equal(f.calls.find(call=>call.pdf).viewUrl,"https://crm.example/invoice-status/random-public-status-token");
    assert.equal(f.emails[0].attachments[0].contentType,"application/pdf");
    assert.equal(f.emails[0].to,"saved@example.com");
    assert.equal(f.emails[0].cc,"creator@example.com, owner@example.com");
    assert.ok(f.emails[0].html.includes('href="https://rzp.io/i/test"'));
    assert.doesNotMatch(f.emails[0].html,/View complete invoice|Pay Now · View invoice/);
    assert.doesNotMatch(f.emails[0].html,/View invoice payment status/);
    if(currency==="INR") assert.equal(f.calls.find(call=>call.provider==="razorpay").input.callbackUrl,"https://crm.example/invoice-status/random-public-status-token");
    assert.equal(f.invoice.status_token_hash,"hashed-token");
    assert.ok(!f.invoice.status_token_encrypted.includes("random-public-status-token"));
    assert.equal(f.invoice.email_lock_at,null);
    await assert.rejects(f.send(),/already accepted/);
    assert.equal(f.calls.filter(call=>call.provider).length,1);
  }
});
test("installment delivery and paid receipts share verified balances with PDF and charge only the installment",async()=>{
  const f=deliveryFixture("INR","installments");
  Object.assign(f.invoice,{course_total:100000,total:20000,subtotal:20000,installment_number:2});
  f.family.unshift({id:"prior",total:30000,status:"paid",installment_number:1,created_at:new Date().toISOString()});
  await f.send();
  assert.equal(f.calls.find(call=>call.provider==="razorpay").input.amount,20000);
  const pending=f.calls.find(call=>call.pdf).record.payment_summary;
  assert.deepEqual([pending.paidToDate,pending.outstanding,pending.balanceAfterPayment],[30000,70000,50000]);
  assert.match(f.emails[0].html,/class="invoice-pay-button"/);
  assert.doesNotMatch(f.emails[0].html,/Pay Now ₹/);
  assert.match(f.emails[0].html,/₹70,000\.00/);
  assert.doesNotMatch(f.emails[0].html,/View live invoice and payment status|Payment deadline/);
  f.invoice.status="paid";
  await f.helpers.sendPaymentReceipt(f.admin,invoiceId);
  const received=f.calls.filter(call=>call.pdf).at(-1).record.payment_summary;
  assert.deepEqual([received.paidToDate,received.outstanding,received.balanceAfterPayment],[50000,50000,50000]);
  assert.match(f.emails[1].html,/background:#167844;color:#fff/);
  assert.doesNotMatch(f.emails[1].html,/Pay Now|Balance after this installment is paid/);
});
test("Loan/EMI delivery omits status link and creates no online payment; copied recipients deduplicate",async()=>{
  for(const type of ["loan","emi"]){
    const f=deliveryFixture("USD",type);await f.send();
    assert.equal(f.calls.filter(call=>call.provider).length,0);
    assert.equal(f.calls.find(call=>call.pdf).paymentUrl,null);
    assert.match(f.emails[0].html,/financing confirmation/);
    assert.doesNotMatch(f.emails[0].html,/invoice-status|Payment deadline/);
    assert.equal(f.helpers.invoiceRecipients("Lead@Example.com","LEAD@example.com","Owner@example.com","owner@example.com"),"owner@example.com");
  }
});
test("missing Stripe keys do not block either brand's INR or USD invoice or paid email",async()=>{
  for(const code of ["DMHCA","IBMP"]){
    const f=deliveryFixture("INR");
    f.invoice.company_code=code;
    f.disableStripe();
    await f.send();
    assert.equal(f.emails.length,1);
    assert.equal(f.calls.filter(call=>call.provider==="razorpay").length,1);
    assert.equal(f.calls.filter(call=>call.provider==="stripe").length,0);
    assert.match(f.emails[0].html,/Pay securely with Razorpay/);
    f.invoice.status="paid";
    f.invoice.paid_at=new Date().toISOString();
    await f.helpers.sendPaymentReceipt(f.admin,invoiceId);
    assert.equal(f.emails.length,2);
    assert.match(f.emails[1].html,/role="status"[^>]*>Paid /);
    assert.doesNotMatch(f.emails[1].html,/Pay Now/);
  }
  const usd=deliveryFixture("USD");
  usd.disableStripe();
  await usd.send();
  assert.equal(usd.emails.length,1);
  assert.equal(usd.calls.filter(call=>call.provider==="razorpay").length,1);
});
test("approval delivery copies the original creator rather than replacing them with the approving administrator",async()=>{
  const f=deliveryFixture();
  await f.helpers.deliverInvoice(f.admin,f.invoice,{id:"lead",name:"Live name",email:"live@example.com"},"approver@example.com");
  assert.equal(f.emails[0].cc,"creator@example.com, owner@example.com");
});
test("invoice email uses the full branded document and embeds the correct logo for both companies",async()=>{
  for(const [code,primary,accent] of [["DMHCA","#1c1d4e","#c44754"],["IBMP","#1c1d4e","#c44754"]]){
    const f=deliveryFixture();
    f.invoice.company_code=code;
    f.invoice.company_snapshot={code,legal_name:`${code} Education`,address:"Company address",tax_id:"GST-123",primary_color:"#ffffff",accent_color:"#ffffff"};
    f.invoice.invoice_items=[{description:"Clinical Cardiology",quantity:1,unit_price:100,amount:100}];
    await f.send();
    const mail=f.emails[0];
    for(const value of ["BILL TO","INVOICE DETAILS","Clinical Cardiology","Subtotal","Discount","GST","PAYMENT SCHEDULE","PAYMENT DETAILS","Company address",primary,accent]){
      assert.ok(mail.html.includes(value),value);
    }
    assert.match(mail.html,/src="cid:invoice-logo"/);
    assert.equal(mail.fromName,"NEWDELHI MEDICAL HEALTH CARE PVT. LTD.");
    assert.equal(mail.attachments[0].contentType,"application/pdf");
    assert.equal(mail.attachments[1].filename,"DMHCA-logo.png");
    assert.equal(mail.attachments[1].cid,"invoice-logo");
    assert.ok(mail.attachments[1].content.length>1000);
    if(code==="DMHCA"){
      assert.deepEqual(mail.attachments[1].content,fs.readFileSync(path.join(__dirname,"..","public","DMHCA-invoice-wordmark.png")));
      assert.match(mail.html,/NEWDELHI MEDICAL HEALTH CARE PVT. LTD./);
      assert.doesNotMatch(mail.html,/Thank you for choosing|computer-generated/i);
    }
    assert.equal(f.invoice.delivery_error,null);
    assert.equal(f.invoice.email_message_id,"smtp-message");
  }
});
test("delivery copies the current owner, not a stale invoice owner snapshot",async()=>{
  const f=deliveryFixture();
  f.invoice.owner_email="former-owner@example.com";
  f.setOwnerEmail("Current.Owner@example.com");
  await f.send();
  assert.equal(f.emails[0].cc,"creator@example.com, current.owner@example.com");
  assert.doesNotMatch(f.emails[0].cc,/former-owner/);
});
test("missing or unreadable owner emails stop sending and save an actionable delivery error",async()=>{
  for(const mode of ["missing","query-error"]){
    const f=deliveryFixture();
    if(mode==="missing")f.setOwnerEmail("");else f.failOwner();
    await assert.rejects(f.send(),mode==="missing"?/valid email.*lead owner/:/Owner lookup failed/);
    assert.equal(f.emails.length,0);
    assert.equal(f.calls.filter(call=>call.provider).length,0);
    assert.ok(f.invoice.delivery_error);
    assert.ok(!f.invoice.email_lock_at);
  }
});
test("document preparation failure releases the email lease but uncertain SMTP does not",async()=>{
  const f=deliveryFixture();f.failPdf();
  await assert.rejects(f.send(),/PDF preparation failed/);
  assert.equal(f.invoice.email_lock_at,null);
  assert.equal(f.invoice.delivery_error,"PDF preparation failed");
  assert.equal(f.emails.length,0);
});
test("shared invoice document escapes billing content and only offers payment for eligible invoices",()=>{
  const {buildInvoiceHtml}=load("src\\lib\\invoice-document.ts");
  const invoice=deliveryFixture().invoice;
  invoice.billing_name='<script>alert("name")</script>';
  invoice.invoice_items=[{description:'<img src=x onerror="alert(1)">',quantity:1,unit_price:100,amount:100}];
  invoice.notes="<script>notes</script>";
  const options={paymentUrl:"https://crm.example/invoice-status/opaque",remainingBalance:90000};
  const html=buildInvoiceHtml(invoice,options);
  assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>|<img src=x/);
  assert.match(html,/>Pay Now<\/a>/);
  assert.match(html,/Remaining course balance/);
  assert.match(html,/₹90,000\.00/);
  for(const status of ["pending_approval","scheduled","expired","paid","cancelled","rejected"]){
    assert.doesNotMatch(buildInvoiceHtml({...invoice,status},options),/>Pay Now<\/a>/);
  }
  assert.doesNotMatch(buildInvoiceHtml({...invoice,tax_review_required:true},options),/>Pay Now<\/a>/);
  assert.doesNotMatch(buildInvoiceHtml(invoice,{paymentUrl:"javascript:alert(1)"}),/javascript:|>Pay Now<\/a>/);
});
test("invoice billing panels improve hierarchy and distinguish paid status for both brands",()=>{
  const {buildInvoiceHtml}=load("src\\lib\\invoice-document.ts");
  for(const company_code of ["DMHCA","IBMP"]){
    const invoice={...deliveryFixture().invoice,company_code,billing_name:"Customer & Partners",billing_address:"Line 1\nLine 2"};
    const html=buildInvoiceHtml(invoice);
    assert.match(html,/class="invoice-parties"/);
    assert.match(html,/table-layout:fixed/);
    assert.match(html,/font-size:15px/);
    assert.match(html,/Customer &amp; Partners/);
    assert.match(html,/white-space:pre-line/);
    assert.doesNotMatch(html,/Status:|Issued by:|Payment type:/);
    const paid=buildInvoiceHtml({...invoice,status:"paid",paid_at:"2026-11-07T09:00:00Z"});
    assert.match(paid,/background:#167844;color:#fff/);
    assert.match(paid,/role="status"[^>]*>Paid /);
    assert.match(paid,/Paid on:<\/strong> 7 Nov 2026/);
  }
});

test("uncertain payment persistence and SMTP delivery retain leases instead of allowing duplicate sends",async()=>{
  const persistence=deliveryFixture("USD");persistence.failPersistence();
  await assert.rejects(persistence.send(),/reconcile|Reconcile/);
  assert.ok(persistence.invoice.payment_link_lock_at);
  assert.equal(persistence.emails.length,0);
  const smtp=deliveryFixture("USD");smtp.failSmtp();
  await assert.rejects(smtp.send(),/uncertain/);
  assert.ok(smtp.invoice.email_lock_at);
  assert.equal(smtp.invoice.razorpay_payment_link_id,"plink_test");
});
test("both invoice company PDFs use matching layout with snapshot names, addresses and distinct colors",async()=>{
  const {PDFDocument,PDFName,PDFDict,PDFArray}=require("pdf-lib");
  const pdf=load("src\\lib\\server\\invoice-pdf.ts");
  for(const [code,primary,accent] of [["DMHCA","#800020","#f7cbd7"],["IBMP","#0b1e3b","#d7b770"]]){
    const record={invoice_no:"INV-TEST",status:"sent",lead_id:"lead",created_at:new Date().toISOString(),due_date:null,payment_type:"one_shot",
      subtotal:100,total:100,currency:"USD",discount_amount:0,discount_reason:null,tax_amount:0,notes:"Notes",
      billing_name:"Saved Customer",billing_email:"saved@example.com",billing_address:"Line 1\nLine 2",
      company_snapshot:{code,legal_name:code,address:"Company address",tax_id:"TAX-1",primary_color:primary,accent_color:accent},
      invoice_items:[{description:"Catalog course",quantity:1,unit_price:100,amount:100}]};
    const paymentUrl="https://rzp.io/i/test";
    const bytes=await pdf.buildInvoicePdf(record,{name:"Updated name",email:"updated@example.com"},paymentUrl);
    assert.ok(bytes.length>1000);
    const document=await PDFDocument.load(bytes);
    assert.equal(document.getPageCount(),1);
    const page=document.getPages()[0];
    assert.ok(page.node.Resources().lookup(PDFName.of("XObject"),PDFDict).keys().length,"company logo must be embedded");
    const annotations=page.node.lookup(PDFName.of("Annots"),PDFArray);
    assert.equal(annotations.size(),1);
    const link=annotations.lookup(0,PDFDict);
    assert.equal(link.lookup(PDFName.of("Subtype")).toString(),"/Link");
    assert.equal(link.lookup(PDFName.of("A"),PDFDict).lookup(PDFName.of("URI")).decodeText(),paymentUrl);
    const rect=link.lookup(PDFName.of("Rect"),PDFArray).asArray().map(value=>value.asNumber());
    const crop=page.getCropBox();
    assert.ok(rect[0]>=crop.x && rect[2]<=crop.x+crop.width,"payment link stays inside trimmed page width");
    assert.ok(rect[1]>=crop.y && rect[3]<=crop.y+crop.height,"payment link stays inside trimmed page height");
    assert.ok(rect[2]-rect[0]>70 && rect[2]-rect[0]<90,"compact email button retains its clickable PDF bounds");
    assert.ok(rect[3]-rect[1]>25 && rect[3]-rect[1]<40);
  }
});

test("both brands use logo-led diagonal headers and DMHCA omits redundant issuer details",async()=>{
  const {buildInvoiceHtml}=load("src\\lib\\invoice-document.ts");
  const {buildInvoicePdf}=load("src\\lib\\server\\invoice-pdf.ts");
  const {PDFDocument}=require("pdf-lib");
  for(const code of ["DMHCA","IBMP"]){
    const invoice={...deliveryFixture().invoice,invoice_no:`${code}-TEST-001`,company_code:code};
    const html=buildInvoiceHtml(invoice);
    const header=html.slice(0,html.indexOf('class="invoice-parties"'));
    assert.match(header,/linear-gradient/);
    assert.ok(header.includes('alt="DMHCA logo"'));
    assert.match(header,/>INVOICE<\/strong><\/td>/);
    assert.ok(!header.includes(invoice.invoice_no));
    assert.match(html,new RegExp(`Invoice No:</strong> ${invoice.invoice_no}`));
    const pdf=await PDFDocument.load(await buildInvoicePdf(invoice,null));
    const text=pdfText(pdf);
    assert.equal(text.includes(`Issued by: ${code}`),false);
    assert.ok(text.includes(`Invoice No: ${invoice.invoice_no}`));
    assert.equal(text.split(invoice.invoice_no).length-1,1,"invoice number appears in details only");
  }
});

test("PDF payment buttons are absent before approval, after payment or expiry, and for financing",async()=>{
  const {PDFDocument,PDFName,PDFArray}=require("pdf-lib");
  const pdf=load("src\\lib\\server\\invoice-pdf.ts");
  const base={invoice_no:"INV-GATED",status:"sent",lead_id:"lead",created_at:new Date().toISOString(),due_date:null,
    subtotal:100,total:118,currency:"INR",discount_amount:0,discount_reason:null,tax_amount:18,notes:null,payment_type:"one_shot"};
  for(const override of [{status:"pending_approval"},{status:"paid"},{status:"rejected"},{status:"cancelled"},{status:"expired"},
    {tax_review_required:true},{created_at:"2020-01-01"},{payment_type:"loan"},{payment_type:"emi"}]){
    const bytes=await pdf.buildInvoicePdf({...base,...override},null,"https://rzp.io/i/test");
    const document=await PDFDocument.load(bytes);
    const annotations=document.getPages()[0].node.lookupMaybe(PDFName.of("Annots"),PDFArray);
    assert.equal(annotations?.size()??0,0,JSON.stringify(override));
  }
  await assert.rejects(pdf.buildInvoicePdf(base,null,"javascript:alert(1)"),/HTTPS/);
});

test("PDF course descriptions and notes fit one page without losing invoice content",async()=>{
  const {PDFDocument,PDFName,PDFDict}=require("pdf-lib");
  const pdf=load("src\\lib\\server\\invoice-pdf.ts");
  const bytes=await pdf.buildInvoicePdf({invoice_no:"INV-LONG",status:"pending_approval",lead_id:"lead",
    created_at:new Date().toISOString(),due_date:null,subtotal:100,total:100,currency:"USD",discount_amount:0,
    discount_reason:null,tax_amount:0,notes:"A detailed note. ".repeat(600),
    invoice_items:[{description:"A long course description ".repeat(300),quantity:1,unit_price:100,amount:100}]},null);
  const document=await PDFDocument.load(bytes);
  assert.equal(document.getPageCount(),1);
  assert.ok(document.getPage(0).node.Resources().lookup(PDFName.of("XObject"),PDFDict).keys().length);
  for(const page of document.getPages()) assert.ok(page.getWidth()>0 && page.getWidth()<=596);
  const text=pdfText(document);
  assert.equal((text.match(/A long course description/g)??[]).length,300);
  assert.equal((text.match(/A detailed note\./g)??[]).length,600);
});

test("downloaded PDFs link directly to provider checkout for both providers without creating payments",async()=>{
  const base={id:invoiceId,status:"sent",currency:"INR",payment_type:"one_shot",created_at:new Date().toISOString(),
    lead_id:"lead",invoice_no:"INV-DOWNLOAD",razorpay_short_url:"https://rzp.io/i/saved",status_token_encrypted:"encrypted"};
  for(const override of [{},{currency:"USD"},{status:"pending_approval"},{status:"paid"},{tax_review_required:true},{created_at:"2020-01-01"},{payment_type:"loan"}]){
    const invoice={...base,...override};
    let passed,view;
    const query=data=>({select(){return this;},eq(){return this;},async maybeSingle(){return {data,error:null};}});
    const api=load("src\\app\\api\\invoices\\[id]\\pdf\\route.ts",{
      "@/lib/server/auth":{HttpError,jsonError:error=>{throw error;},requireUser:async()=>({supabase:{from:table=>query(table==="invoices"?invoice:{name:"Customer"})}})},
      "@/lib/server/operational":{databaseError:error=>{if(error)throw error;},parseInput:(_schema,value)=>value,uuid:{}},
      "@/lib/server/integration-settings":{decryptIntegrationValues:()=>({token:"stable-token"})},
      "@/lib/server/invoice-pdf":{buildInvoicePdf:async(_invoice,_lead,url,viewUrl)=>{passed=url;view=viewUrl;return Buffer.from("pdf");}},
    });
    const response=await api.GET(new Request("https://crm.example"),{params:Promise.resolve({id:invoiceId})});
    assert.equal(response.status,200);
    assert.equal(view,"https://crm.example/invoice-status/stable-token");
    assert.equal(passed,["sent",undefined].includes(invoice.status)&&!invoice.tax_review_required&&invoice.payment_type==="one_shot"
      &&new Date(invoice.created_at).getTime()>Date.now()-4*86400000?invoice.razorpay_short_url:null);
  }
});
test("PDF and CRM payment links use the public invoice origin and reject invalid saved tokens",()=>{
  let origin;
  const api=load("src\\lib\\server\\invoice-payment-url.ts",{
    "@/lib/server/env":{appUrl:purpose=>{origin=purpose;return "https://invoice.example.com";}},
    "@/lib/server/integration-settings":{decryptIntegrationValues:value=>value==="invalid"?{}:{token:"saved-public-token"}},
  });
  test("INR payment URLs bypass the public host and token dependency with validated saved Razorpay links",()=>{
    const api=load("src\\lib\\server\\invoice-payment-url.ts",{
      "@/lib/server/env":{appUrl:()=>assert.fail("INR must not depend on deployed CRM routes")},
      "@/lib/server/integration-settings":{decryptIntegrationValues:()=>assert.fail("INR must not depend on token decryption")},
    });
    const base={status:"sent",payment_type:"one_shot",currency:"INR",created_at:new Date().toISOString(),status_token_encrypted:"invalid"};
    for(const host of ["rzp.io","rzp.in","payments.razorpay.com","pages.razorpay.com"]){
      const invoice={...base,razorpay_short_url:`https://${host}/i/payment`};
      assert.equal(api.invoicePaymentUrl(invoice),invoice.razorpay_short_url);
      assert.equal(api.invoicePaymentUrl({...invoice,status:"paid"}),null);
      assert.equal(api.invoicePaymentUrl({...invoice,created_at:"2020-01-01"}),null);
    }
    for(const url of ["javascript:alert(1)","https://rzp.io.evil.example/pay","https://rzp.io:444/pay","http://rzp.io/pay","https://user:pass@rzp.io/pay"])
      assert.throws(()=>api.invoicePaymentUrl({...base,razorpay_short_url:url}),/URL is invalid/);
  });
  const invoice={status:"sent",payment_type:"installments",currency:"INR",created_at:new Date().toISOString(),status_token_encrypted:"valid"};
  assert.equal(api.invoicePaymentUrl(invoice),null);
  assert.equal(api.invoiceViewUrl(invoice),"https://invoice.example.com/invoice-status/saved-public-token");
  assert.equal(origin,"invoice");
  assert.throws(()=>api.invoiceViewUrl({...invoice,status_token_encrypted:"invalid"}),/token is invalid/);
  for(const change of [{status:"paid"},{payment_type:"loan"},{currency:"EUR"},{status_token_encrypted:null},{created_at:"2020-01-01"}]){
    assert.equal(api.invoicePaymentUrl({...invoice,...change}),null);
  }
});
test("Pay Now redirects directly to the selected provider for full payment and installments, never another invoice",async()=>{
  const token=Buffer.alloc(32,12).toString("base64url");
  let queries=0,checkouts=0;
  let invoice={id:invoiceId,status:"sent",payment_type:"one_shot",currency:"INR",total:59,course_total:118,
    payment_expires_at:new Date(Date.now()+86400000).toISOString(),razorpay_short_url:"https://rzp.io/i/installment"};
  let stripeUrl="https://checkout.stripe.com/c/pay/installment";
  const api=load("src\\app\\api\\invoice-status\\[token]\\pay\\route.ts",{
    "next/server":{NextResponse:{redirect:(url,options)=>({location:url.href,...options})}},
    "@/lib/server/razorpay":{statusTokenHash:value=>{assert.equal(value,token);return "hash";}},
    "@/lib/supabase/server":{getSupabaseAdminClient:()=>{queries++;return {from:table=>{
      assert.equal(table,"invoices");return {select:()=>({eq:(key,value)=>{
        assert.equal(key,"status_token_hash");assert.equal(value,"hash");
        return {maybeSingle:async()=>({data:invoice,error:null})};
      }})};
    }};}},
    "@/lib/server/invoice-checkout":{ensureInvoiceCheckout:async(_admin,row,value)=>{
      checkouts++;assert.equal(row.total,59);assert.equal(value,token);return stripeUrl;
    }},
  });
  const open=(value=token)=>api.GET(new Request(`https://crm.example/api/invoice-status/${value}/pay`),{params:Promise.resolve({token:value})});
  for(const payment_type of ["one_shot","installments"]){
    invoice.payment_type=payment_type;
    for(const currency of ["INR","USD"]){
      invoice.currency=currency;
      const response=await open();
      assert.equal(response.status,303);
      assert.equal(response.location,invoice.razorpay_short_url);
      assert.doesNotMatch(response.location,/invoice-status/);
      assert.equal(response.headers["Cache-Control"],"private, no-store");
      assert.equal(response.headers["Referrer-Policy"],"no-referrer");
    }
  }
  assert.equal(checkouts,0);
  const base={...invoice};
  for(const override of [{status:"paid"},{status:"pending_approval"},{status:"scheduled"},{status:"cancelled"},
    {status:"rejected"},{tax_review_required:true},{payment_type:"loan"},{payment_type:"emi"},{currency:"EUR"}]){
    invoice={...base,...override};assert.equal((await open()).status,409);
  }
  invoice={...base,payment_expires_at:new Date(Date.now()-1).toISOString()};
  assert.equal((await open()).status,410);
  assert.equal(checkouts,0,"no invoice should create a Stripe checkout");
  invoice={...base,currency:"INR",razorpay_short_url:null};
  assert.equal((await open()).status,409);
  for(const url of ["http://rzp.io/i/test","https://rzp.io.evil.example/test","https://user:pass@rzp.io/i/test"]){
    invoice={...base,currency:"INR",razorpay_short_url:url};assert.equal((await open()).status,502);
  }
  invoice={...base,razorpay_short_url:"https://evil.example/checkout"};
  assert.equal((await open()).status,502);
  invoice=null;assert.equal((await open()).status,404);
  const before=queries;
  assert.equal((await open("short")).status,404);
  assert.equal(queries,before,"invalid tokens must not query the database");
});
test("company email branding changes both identity and colors without changing other transactional mail",()=>{
  const mailer=load("src\\lib\\server\\mailer.ts",{
    "@/lib/server/integration-settings":settings,"@/lib/server/smtp-transport":{smtpTransport:async()=>assert.fail("No SMTP operation expected")},
  });
  const branded=mailer.emailLayout("Invoice","<p>Bill</p>",{legal_name:"IBMP & Partners",primary_color:"#0b1e3b",accent_color:"#d7b770"});
  assert.match(branded,/IBMP &amp; Partners/);
  assert.match(branded,/#0b1e3b/);
  assert.match(branded,/#d7b770/);
  assert.doesNotMatch(branded,/DMHCA/);
  const unbranded=mailer.emailLayout("Login","Code");
  assert.match(unbranded,/DMHCA/);
  assert.match(unbranded,/#0A1A3F/);
});
test("course and company inputs require independently priced currencies and safe complete billing details",()=>{
  const {courseInput,companyInput}=load("src\\lib\\billing.ts");
  const valid={name:"Course",price_inr:25000,price_usd:300,is_active:true};
  assert.equal(courseInput.safeParse(valid).success,true);
  for(const input of [{price_usd:undefined},{price_inr:0},{price_usd:1.234},{name:""},{price_usd:Infinity}]){
    assert.equal(courseInput.safeParse({...valid,...input}).success,false);
  }
  const company={code:"IBMP",legal_name:"IBMP",address:"Company address",tax_id:"",primary_color:"#0b1e3b",accent_color:"#d7b770"};
  assert.equal(companyInput.safeParse(company).success,true);
  assert.equal(companyInput.safeParse({...company,address:"  "}).success,false);
  assert.equal(companyInput.safeParse({...company,primary_color:"red; background:url(example)"}).success,false);
});

test("pasted Razorpay links verify the company account, exact captured amount and invoice or customer",async()=>{
  const invoice={id:invoiceId,total:100,currency:"INR",billing_email:"lead@example.com"};
  const link={id:"plink_external",short_url:"https://rzp.io/i/company",status:"paid",amount:10000,amount_paid:10000,currency:"INR",
    customer:{email:"LEAD@example.com"},notes:{},payments:[{payment_id:"pay_external"}]};
  let payment={id:"pay_external",status:"captured",amount:10000,currency:"INR"};
  const calls=[];
  const api=load("src\\lib\\server\\invoice-payment-verification.ts",{
    "@/lib/server/razorpay":{razorpayRequest:async path=>{
      calls.push(path);
      if(path.startsWith("payment_links?"))return {items:[link]};
      return path.startsWith("payment_links/")?link:payment;
    }},
    "@/lib/server/stripe":{stripeRequest:async()=>assert.fail("Wrong currency provider")},
  });
  const result=await api.verifyInvoicePaymentUrl(invoice,link.short_url);
  assert.equal(result.paymentId,"pay_external");assert.equal(result.amount,10000);
  assert.ok(calls.every(path=>!path.includes("https:")),"never fetch an arbitrary pasted URL");
  for(const url of ["https://evil.example/paid","http://rzp.io/i/company","https://rzp.io.evil.example/i/company","https://user:password@rzp.io/i/company"]){
    const before=calls.length;
    await assert.rejects(api.verifyInvoicePaymentUrl(invoice,url),/Razorpay|HTTPS/);
    assert.equal(calls.length,before);
  }
  link.status="created";await assert.rejects(api.verifyInvoicePaymentUrl(invoice,link.short_url),/not confirmed/);link.status="paid";
  link.customer.email="other@example.com";await assert.rejects(api.verifyInvoicePaymentUrl(invoice,link.short_url),/does not match/);
  link.customer.email="lead@example.com";link.notes.invoice_id="different-invoice";
  await assert.rejects(api.verifyInvoicePaymentUrl(invoice,link.short_url),/does not match/);
  link.notes.invoice_id=invoiceId;
  payment.status="authorized";await assert.rejects(api.verifyInvoicePaymentUrl(invoice,link.short_url),/not captured/);
  payment.status="captured";payment.amount=9999;await assert.rejects(api.verifyInvoicePaymentUrl(invoice,link.short_url),/not captured/);
});

test("Stripe URL and saved-session reconciliation require paid exact-amount customer-bound sessions",async()=>{
  const invoice={id:invoiceId,total:100,currency:"USD",billing_email:"lead@example.com"};
  const session={id:"cs_test_external",mode:"payment",payment_status:"paid",amount_total:10000,currency:"usd",
    payment_intent:"pi_external",metadata:{},customer_details:{email:"lead@example.com"}};
  const api=load("src\\lib\\server\\invoice-payment-verification.ts",{
    "@/lib/server/razorpay":{razorpayRequest:async()=>assert.fail("Wrong provider")},
    "@/lib/server/stripe":{stripeRequest:async path=>{
      if(path.startsWith("payment_links?"))return {data:[{id:"plink_company",url:"https://buy.stripe.com/company"}],has_more:false};
      if(path.startsWith("checkout/sessions?"))return {data:[session],has_more:false};
      assert.equal(path,"checkout/sessions/cs_test_external");return session;
    }},
  });
  const url="https://checkout.stripe.com/c/pay/cs_test_external#details";
  assert.equal((await api.verifyInvoicePaymentUrl(invoice,url)).paymentId,"pi_external");
  assert.equal((await api.verifyInvoicePaymentUrl(invoice,"https://buy.stripe.com/company")).paymentId,"pi_external");
  assert.equal((await api.verifySavedInvoicePayment({...invoice,stripe_session_id:session.id,stripe_checkout_url:url})).amount,10000);
  session.payment_status="unpaid";await assert.rejects(api.verifyInvoicePaymentUrl(invoice,url),/not confirmed/);session.payment_status="paid";
  session.amount_total=9999;await assert.rejects(api.verifyInvoicePaymentUrl(invoice,url),/does not match/);session.amount_total=10000;
  session.customer_details.email="someone@example.com";await assert.rejects(api.verifyInvoicePaymentUrl(invoice,url),/does not match/);
  session.metadata.invoice_id=invoiceId;
  assert.equal((await api.verifyInvoicePaymentUrl(invoice,url)).currency,"USD","invoice metadata may bind a saved company session");
  session.metadata.invoice_id="another-invoice";await assert.rejects(api.verifyInvoicePaymentUrl(invoice,url),/does not match/);
});

test("later discounted installments pass API validation without requesting the original discount again",()=>{
  const {invoiceInput}=load("src\\lib\\server\\operational-validation.ts");
  const input={lead_id:invoiceId,course_id:invoiceId,company_code:"DMHCA",billing_address:"Address",
    parent_invoice_id:invoiceId,payment_type:"installments",installment_amount:25000,
    request_id:invoiceId,installments:[{amount:25000,invoice_date:"2026-12-27"}],
    discount_percent:10,tax_percent:18,due_date:"2026-12-31"};
  assert.equal(invoiceInput.safeParse(input).success,true);
  assert.equal(invoiceInput.safeParse({...input,parent_invoice_id:undefined}).success,false,"first discount still needs a reason");
  assert.equal(invoiceInput.safeParse({...input,tax_percent:101}).success,false);
});

test("scheduled delivery rejects early sending and unapproved enrollment without contacting providers", async () => {
  const future = deliveryFixture();
  future.invoice.scheduled_for = new Date(Date.now() + 86400000).toISOString();
  await assert.rejects(future.send(), /not due for delivery/);
  assert.equal(future.calls.length, 0);
  for (const root of [
    { status: "pending_approval", discount_percent: 10 },
    { status: "rejected", discount_percent: 10 },
    { status: "sent", discount_percent: 10, approved_at: null },
    { status: "paid", discount_percent: 0, tax_review_required: true },
    { status: "cancelled", discount_percent: 0, pricing_review_note: "Tax revised", approved_at: null },
  ]) {
    const f = deliveryFixture();
    f.invoice.scheduled_for = new Date(Date.now() - 60000).toISOString();
    f.invoice.parent_invoice_id = "root";
    await assert.rejects(f.helpers.deliverInvoice({
      from: () => ({ update(values) { Object.assign(f.invoice,values); return this; }, select() { return this; }, eq() { return this; },
        maybeSingle: async () => ({ data: root, error: null }), then(resolve) { return Promise.resolve({ error: null }).then(resolve); } }),
    }, f.invoice, { id: "lead", name: "Lead", email: "lead@example.com" }), /enrollment must be approved/);
    assert.equal(f.calls.length, 0);
  }
});

test("invoice policy locks currency tax and the exact 96-hour cutoff including date boundaries",()=>{
  const policy=load("src\\lib\\invoice-policy.ts");
  assert.equal(policy.invoiceTaxPercent("INR"),18);
  assert.equal(policy.invoiceTaxPercent("USD"),0);
  const created="2026-12-30T23:59:59.000Z";
  assert.equal(policy.invoiceDeadline(created),"2027-01-03T23:59:59.000Z");
  const end=Date.parse(policy.invoiceDeadline(created));
  assert.equal(policy.invoiceWindowExpired({created_at:created},end-1),false);
  assert.equal(policy.invoiceWindowExpired({created_at:created},end),true);
});

test("unsettled invoices keep refreshing after expiry, but paid and closed invoices stop",()=>{
  const {invoiceStatusShouldRefresh}=load("src\\lib\\invoice-policy.ts");
  for(const status of ["sent","pending_approval","pending_review","scheduled","expired"])
    assert.equal(invoiceStatusShouldRefresh(status),true,status);
  for(const status of ["paid","cancelled","rejected"])
    assert.equal(invoiceStatusShouldRefresh(status),false,status);
});

test("paid emails preserve the standard invoice for both brands without a second receipt layout",async()=>{
  for(const code of ["DMHCA","IBMP"]){
    const f=deliveryFixture();
    Object.assign(f.invoice,{
      status:"paid",company_code:code,paid_at:"2026-11-07T09:00:00Z",
      payment_expires_at:"2026-11-06T09:00:00Z",
      invoice_items:[{description:"Clinical Cardiology",quantity:1,unit_price:100,amount:100}],
    });
    await f.helpers.sendPaymentReceipt(f.admin,invoiceId);
    const mail=f.emails[0];
    assert.equal((mail.html.match(/class="invoice-document"/g)||[]).length,1);
    for(const label of ["INVOICE DETAILS","PAYMENT SCHEDULE","PAYMENT DETAILS","Paid on:</strong> 7 Nov 2026","Amount paid"])
      assert.ok(mail.html.includes(label),`${code}: ${label}`);
    assert.match(mail.html,/role="status"[^>]*>Paid /);
    assert.doesNotMatch(mail.html,/Pay Now|Payment deadline|<h1/);
    assert.doesNotMatch(mail.html,/Hello |The same invoice is now Paid|A copy is sent|Keep this invoice/);
    assert.ok(mail.html.includes(f.invoice.invoice_no));
    assert.equal(mail.attachments[1].filename,"DMHCA-logo.png");
    assert.equal(mail.cc,"creator@example.com, owner@example.com");
    if(code==="DMHCA") assert.deepEqual(mail.attachments[1].content,fs.readFileSync(path.join(__dirname,"..","public","DMHCA-invoice-wordmark.png")));
  }
});

function checkoutFixture(){
  const invoice={id:invoiceId,invoice_no:"INV-TEST",status:"sent",total:100,currency:"USD",billing_email:"lead@example.com",
    payment_expires_at:new Date(Date.now()+4*86400000).toISOString(),tax_review_required:false,payment_revision:1};
  const calls=[],updates=[],history=[];
  let state={id:"cs_previous",status:"expired",payment_status:"unpaid",expires_at:Math.floor(Date.now()/1000)-10,url:null};
  let claim=true,save=true;
  const admin={from:table=>{
    const q={update:value=>{updates.push(value);return q;},eq:()=>q,is:()=>q,select:()=>q,
      insert:async value=>{assert.equal(table,"invoice_checkout_sessions");history.push(value);return {error:null};},
      maybeSingle:async()=>({data:(updates.at(-1)?.stripe_session_id?save:claim)?{id:invoiceId}:null,error:null})};
    return q;
  }};
  const api=load("src\\lib\\server\\invoice-checkout.ts",{
    "@/lib/server/stripe":{
      stripeRequest:async path=>{calls.push({path});return state;},
      createStripeCheckout:async input=>{calls.push({input});return {id:"cs_new",url:"https://checkout.stripe.com/c/pay/cs_new"};},
    },
  });
  return {api,invoice,admin,calls,updates,history,setState:value=>{state=value;},denyClaim:()=>{claim=false;},failSave:()=>{save=false;}};
}

test("Stripe session expiry stays within 24 hours and allows only the approved final grace",()=>{
  const {stripeCheckoutExpiry}=checkoutFixture().api;
  const now=Date.now(),seconds=Math.floor(now/1000);
  assert.ok(stripeCheckoutExpiry(new Date(now+4*86400000).toISOString(),now)<=seconds+86400);
  const deadline=new Date(now+2*3600000).toISOString();
  assert.equal(stripeCheckoutExpiry(deadline,now),Math.floor(Date.parse(deadline)/1000));
  const final=new Date(now+10*60000).toISOString();
  assert.equal(stripeCheckoutExpiry(final,now),Math.floor(Date.parse(final)/1000)+1800);
  assert.throws(()=>stripeCheckoutExpiry(new Date(now).toISOString(),now),/expired/);
});

test("USD checkout renews expired sessions once under a database lease and retains session history",async()=>{
  const f=checkoutFixture();f.invoice.stripe_session_id="cs_previous";
  const url=await f.api.ensureInvoiceCheckout(f.admin,f.invoice,"token");
  assert.match(url,/checkout.stripe.com/);
  assert.equal(f.calls[1].input.previousSessionId,"cs_previous");
  assert.equal(f.history[0].session_id,"cs_new");
  assert.equal(f.history[0].invoice_id,invoiceId);
  assert.equal(f.updates.at(-1).payment_link_lock_at,null);
  const busy=checkoutFixture();busy.denyClaim();
  await assert.rejects(busy.api.ensureInvoiceCheckout(busy.admin,busy.invoice,"token"),/in progress|reconciliation/);
  assert.equal(busy.calls.length,0);
  const failed=checkoutFixture();failed.failSave();
  await assert.rejects(failed.api.ensureInvoiceCheckout(failed.admin,failed.invoice,"token"),/invoice changed/);
  assert.equal(failed.history.length,1,"provider session remains tracked for webhook reconciliation after persistence failure");
});

test("USD checkout reuses open sessions, blocks already-completed payments and never renews beyond cutoff",async()=>{
  const f=checkoutFixture();f.invoice.stripe_session_id="cs_previous";
  f.setState({id:"cs_previous",status:"open",payment_status:"unpaid",expires_at:Math.floor(Date.now()/1000)+3000,url:"https://checkout.stripe.com/c/pay/cs_previous"});
  assert.match(await f.api.ensureInvoiceCheckout(f.admin,f.invoice,"token"),/cs_previous/);
  assert.equal(f.updates.length,0);
  f.setState({id:"cs_previous",status:"complete",payment_status:"paid",expires_at:Math.floor(Date.now()/1000)+3000,url:null});
  await assert.rejects(f.api.ensureInvoiceCheckout(f.admin,f.invoice,"token"),/do not pay twice/);
  f.invoice.payment_expires_at=new Date(Date.now()-1).toISOString();
  const before=f.calls.length;
  await assert.rejects(f.api.ensureInvoiceCheckout(f.admin,f.invoice,"token"),/expired/);
  assert.equal(f.calls.length,before);
});

test("invoice delivery cannot bypass expiry or legacy tax review",async()=>{
  const expired=deliveryFixture();expired.invoice.payment_expires_at=new Date(Date.now()-1).toISOString();
  await assert.rejects(expired.send(),/expired/);
  assert.equal(expired.calls.length,0);assert.equal(expired.emails.length,0);
  const review=deliveryFixture();review.invoice.tax_review_required=true;
  await assert.rejects(review.send(),/tax review/);
  assert.equal(review.calls.length,0);assert.equal(review.emails.length,0);
  const current=deliveryFixture();await current.send();
  assert.equal(current.calls[0].input.expiresAt,Math.floor(Date.parse(current.invoice.payment_expires_at)/1000));
  assert.doesNotMatch(current.emails[0].html,/Payment deadline/);
});

test("tax review cancellation confirms both providers before detaching links and retains uncertain leases",async()=>{
  const updates=[],calls=[];
  let razorpayPaid=false,stripePaid=false;
  const admin={from:()=>{const q={update:value=>{updates.push(value);return q;},eq:()=>q,in:()=>q,is:()=>q,select:()=>q,
    maybeSingle:async()=>({data:{id:invoiceId},error:null})};return q;}};
  const api=load("src\\lib\\server\\invoice-link-cancellation.ts",{
    "@/lib/server/razorpay":{razorpayRequest:async(path,method)=>{
      calls.push({path,method});
      return method==="POST"?{status:"cancelled"}:{status:razorpayPaid?"paid":"created",amount_paid:razorpayPaid?10000:0};
    }},
    "@/lib/server/stripe":{stripeRequest:async(path,body)=>{
      calls.push({path,body});
      return body?{status:"expired"}:{status:stripePaid?"complete":"open",payment_status:stripePaid?"paid":"unpaid"};
    }},
  });
  const invoice={id:invoiceId,razorpay_payment_link_id:"plink_old",stripe_session_id:"cs_old"};
  await api.cancelInvoicePaymentLinks(admin,invoice);
  assert.ok(calls.some(call=>call.path.endsWith("/cancel")&&call.method==="POST"));
  assert.ok(calls.some(call=>call.path.endsWith("/expire")));
  assert.equal(updates.at(-1).razorpay_payment_link_id,null);
  assert.equal(updates.at(-1).stripe_session_id,null);
  updates.length=0;razorpayPaid=true;
  await assert.rejects(api.cancelInvoicePaymentLinks(admin,invoice),/Reconcile received funds/);
  assert.equal(updates.length,1,"do not detach provider identities when money may have been received");
  assert.ok(updates[0].payment_link_lock_at);
  razorpayPaid=false;stripePaid=true;updates.length=0;
  await assert.rejects(api.cancelInvoicePaymentLinks(admin,invoice),/Reconcile received funds/);
  assert.equal(updates.length,1);
  await assert.rejects(api.cancelInvoicePaymentLinks(admin,{...invoice,email_lock_at:"interrupted"}),/reconciliation/);
});
