alter table public.invoices
  add column enrollment_subtotal numeric(12,2),
  add column enrollment_discount numeric(12,2),
  add column enrollment_tax numeric(12,2),
  add column enrollment_tax_percent numeric(5,2),
  add column installment_number integer;

create policy "Administrators read every invoice" on public.invoices for select to authenticated
  using (public.has_permission('invoices.view') and exists (
    select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')
      and status='active' and deleted_at is null));
create policy "Only administrators decide invoices" on public.invoices as restrictive for update to authenticated
  using (exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')))
  with check (exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')));
create policy "Only administrators decide discounts" on public.invoice_approvals as restrictive for update to authenticated
  using (exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')))
  with check (exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')));

create or replace function public.operational_create_invoice(p_input jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_lead public.leads;
  v_course public.courses;
  v_company public.invoice_companies;
  v_parent public.invoices;
  v_id uuid := gen_random_uuid();
  v_currency text := coalesce(p_input->>'currency','INR');
  v_type text := coalesce(p_input->>'payment_type','one_shot');
  v_price numeric(12,2);
  v_discount_percent numeric := coalesce((p_input->>'discount_percent')::numeric,0);
  v_tax_percent numeric := (p_input->>'tax_percent')::numeric;
  v_course_discount numeric(12,2);
  v_course_tax numeric(12,2);
  v_course_total numeric(12,2);
  v_due numeric;
  v_subtotal numeric(12,2);
  v_discount numeric(12,2);
  v_tax numeric(12,2);
  v_paid numeric(12,2) := 0;
  v_paid_discount numeric(12,2) := 0;
  v_paid_tax numeric(12,2) := 0;
  v_number integer := 1;
  v_address text;
  v_owner_email text;
  v_description text;
  v_reason text := nullif(trim(p_input->>'discount_reason'),'');
  v_approval boolean;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.create')
    then raise exception 'Not authorized'; end if;
  if v_type not in ('one_shot','installments','loan','emi') then raise exception 'Invalid payment type'; end if;
  if v_currency not in ('INR','USD') then raise exception 'Choose INR or USD'; end if;
  select * into v_lead from public.leads where id=(p_input->>'lead_id')::uuid
    and not is_archived and merged_into_id is null
    and (assignee_id=auth.uid() or public.user_in_scope(assignee_id) or public.has_permission('users.view'));
  if not found then raise exception 'Lead unavailable'; end if;
  -- Serialize enrollment selection as well as child creation, including concurrent first invoices.
  perform pg_advisory_xact_lock(hashtext(v_lead.id::text || coalesce(p_input->>'course_id','historical')
    || coalesce(p_input->>'company_code','') || v_currency));
  if nullif(p_input->>'parent_invoice_id','') is not null then
    select * into v_parent from public.invoices where id=(p_input->>'parent_invoice_id')::uuid and lead_id=v_lead.id;
    if not found or v_parent.parent_invoice_id is not null or v_parent.payment_type <> 'installments'
      or v_parent.status not in ('sent','paid','pending_approval') or v_type <> 'installments'
      then raise exception 'Invalid installment parent'; end if;
  elsif v_type='installments' then
    select i.* into v_parent from public.invoices i where i.lead_id=v_lead.id
      and i.course_id=nullif(p_input->>'course_id','')::uuid and i.company_code=p_input->>'company_code'
      and i.currency=v_currency and i.payment_type='installments' and i.parent_invoice_id is null
      and i.status not in ('rejected','cancelled')
      and i.course_total > (select coalesce(sum(c.total),0) from public.invoices c
        where coalesce(c.parent_invoice_id,c.id)=i.id and c.status='paid')
      order by i.created_at limit 1;
  end if;
  if v_parent.id is not null then
    perform pg_advisory_xact_lock(hashtext(v_parent.id::text));
    if exists(select 1 from public.invoices where coalesce(parent_invoice_id,id)=v_parent.id
      and status in ('sent','pending_approval')) then raise exception 'An unpaid or pending installment already exists for this course'; end if;
    if v_parent.course_id is null and (nullif(p_input->>'course_id','') is not null or v_currency <> 'INR' or p_input->>'company_code' <> 'DMHCA')
      then raise exception 'Historical installments retain the original DMHCA/INR enrollment'; end if;
    if v_parent.course_id is distinct from nullif(p_input->>'course_id','')::uuid
      or coalesce(v_parent.company_code,'DMHCA') <> p_input->>'company_code'
      or v_parent.currency <> v_currency then raise exception 'Installment must use the original course, company and currency'; end if;
    select coalesce(sum(total),0),count(*)+1 into v_paid,v_number from public.invoices
      where coalesce(parent_invoice_id,id)=v_parent.id and status='paid';
    if v_parent.enrollment_subtotal is not null then
      select coalesce(sum(discount_amount),0),coalesce(sum(tax_amount),0) into v_paid_discount,v_paid_tax
        from public.invoices where coalesce(parent_invoice_id,id)=v_parent.id and status='paid';
    end if;
    v_price := coalesce(v_parent.enrollment_subtotal,v_parent.course_total);
    v_course_discount := coalesce(v_parent.enrollment_discount,0);
    v_course_tax := coalesce(v_parent.enrollment_tax,0);
    v_course_total := v_parent.course_total;
    v_tax_percent := coalesce(v_parent.enrollment_tax_percent,0);
    v_discount_percent := case when v_parent.enrollment_subtotal is null then 0 else v_parent.discount_percent end;
    v_reason := v_parent.discount_reason;
    select description into v_description from public.invoice_items where invoice_id=v_parent.id order by id limit 1;
    v_description := coalesce(v_description,'Historical course installment');
  else
    select * into v_course from public.courses where id=nullif(p_input->>'course_id','')::uuid for share;
    if not found or not v_course.is_active then raise exception 'Choose an active catalog course'; end if;
    v_price := case when v_currency='USD' then v_course.price_usd else v_course.price_inr end;
    v_description := v_course.name;
    if v_discount_percent < 0 or v_discount_percent > 100 or v_discount_percent <> round(v_discount_percent,2)
      then raise exception 'Invalid discount'; end if;
    if v_discount_percent > 0 and v_reason is null then raise exception 'Discount reason is required'; end if;
    if v_discount_percent=0 and v_reason is not null then raise exception 'Discount reason requires a discount'; end if;
    if v_tax_percent is not null and (v_tax_percent < 0 or v_tax_percent > 100 or v_tax_percent <> round(v_tax_percent,2))
      then raise exception 'Invalid tax percentage'; end if;
    v_course_discount := round(v_price*v_discount_percent/100,2);
    v_course_tax := case when v_tax_percent is not null then round((v_price-v_course_discount)*v_tax_percent/100,2)
      else coalesce((p_input->>'tax_amount')::numeric,0) end;
    if v_course_tax < 0 or v_course_tax <> round(v_course_tax,2) then raise exception 'Invalid tax'; end if;
    v_tax_percent := coalesce(v_tax_percent,case when v_price>v_course_discount
      then round(v_course_tax/(v_price-v_course_discount)*100,2) else 0 end);
    v_course_total := v_price-v_course_discount+v_course_tax;
  end if;
  v_due := case when v_type='installments' then (p_input->>'installment_amount')::numeric else v_course_total end;
  if v_due is null or v_due < 1 or v_due <> round(v_due,2) then raise exception 'Invalid installment amount'; end if;
  if v_due > v_course_total-v_paid then raise exception 'Installment exceeds the remaining course balance'; end if;
  if v_type='installments' and v_course_total-v_paid-v_due > 0 and v_course_total-v_paid-v_due < 1
    then raise exception 'This installment would leave less than one currency unit. Include the remaining balance in this payment'; end if;
  select * into v_company from public.invoice_companies where code=p_input->>'company_code' for share;
  if not found or trim(v_company.address)='' then raise exception 'Complete company billing details in Courses before issuing invoices'; end if;
  v_address := trim(coalesce(p_input->>'billing_address',v_lead.billing_address,''));
  if length(v_address) not between 1 and 2000 then raise exception 'Lead billing address is required (maximum 2000 characters)'; end if;
  if coalesce(v_lead.email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    then raise exception 'A valid lead email is required'; end if;
  select email into v_owner_email from public.profiles where id=v_lead.assignee_id and status='active' and deleted_at is null;
  if coalesce(v_owner_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    then raise exception 'Assign an active lead owner with a valid email before issuing an invoice'; end if;
  -- Allocate cumulative cents so small installments cannot over-allocate tax or discounts.
  v_discount := round(v_course_discount*(v_paid+v_due)/v_course_total,2)-v_paid_discount;
  v_tax := round(v_course_tax*(v_paid+v_due)/v_course_total,2)-v_paid_tax;
  v_subtotal := v_due+v_discount-v_tax;
  v_approval := v_parent.id is null and v_discount_percent>0;
  insert into public.invoices(id,invoice_no,lead_id,created_by,status,subtotal,tax_amount,
    discount_type,discount_value,discount_percent,discount_amount,discount_reason,total,due_date,notes,
    payment_type,course_total,parent_invoice_id,creator_email,currency,course_id,company_code,company_snapshot,
    billing_name,billing_email,billing_address,owner_email,enrollment_subtotal,enrollment_discount,enrollment_tax,
    enrollment_tax_percent,installment_number)
  values(v_id,'INV-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(v_id::text,'-',''),1,12)),
    v_lead.id,auth.uid(),case when v_approval then 'pending_approval'::public.invoice_status else 'sent'::public.invoice_status end,
    v_subtotal,v_tax,'percentage',v_discount_percent,v_discount_percent,v_discount,v_reason,v_due,(p_input->>'due_date')::date,
    p_input->>'notes',v_type,v_course_total,v_parent.id,(select email from public.profiles where id=auth.uid()),
    v_currency,coalesce(v_parent.course_id,v_course.id),v_company.code,coalesce(v_parent.company_snapshot,to_jsonb(v_company)),
    v_lead.name,v_lead.email,v_address,v_owner_email,v_price,v_course_discount,v_course_tax,v_tax_percent,
    case when v_type='installments' then v_number end);
  insert into public.invoice_items(invoice_id,description,quantity,unit_price,amount)
    values(v_id,v_description,1,v_subtotal,v_subtotal);
  if v_approval then insert into public.invoice_approvals(invoice_id,requested_by) values(v_id,auth.uid()); end if;
  if coalesce((p_input->>'save_billing_address')::boolean,false) then
    if not public.has_permission('leads.edit') then raise exception 'Lead editing permission is required to save the billing address'; end if;
    update public.leads set billing_address=v_address,modified_by=auth.uid() where id=v_lead.id;
  end if;
  return v_id;
end $$;

create or replace function public.operational_confirm_external_payment(p_invoice_id uuid,p_reference text,p_evidence text)
returns void language plpgsql security definer set search_path = public as $$
declare v_invoice public.invoices;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.approve')
    or not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin'))
    then raise exception 'Not authorized'; end if;
  if coalesce(trim(p_reference),'')='' or length(trim(p_reference))>200
    or coalesce(trim(p_evidence),'')='' or length(trim(p_evidence))>2000 then raise exception 'Payment reference and evidence are required'; end if;
  select * into v_invoice from public.invoices where id=p_invoice_id for update;
  if not found then raise exception 'Invoice unavailable'; end if;
  if v_invoice.status='paid' and v_invoice.external_payment_reference=p_reference then return; end if;
  if v_invoice.status <> 'sent' then raise exception 'Only issued unpaid invoices can be verified externally'; end if;
  insert into public.payments(invoice_id,razorpay_payment_id,external_reference,amount,method,status,paid_at,raw_payload,verified_by)
    values(p_invoice_id,'external:'||p_reference,p_reference,v_invoice.total,'external','verified_external',now(),
      jsonb_build_object('evidence',p_evidence),auth.uid());
  update public.invoices set status='paid',paid_at=now(),external_payment_reference=p_reference,
    external_payment_evidence=p_evidence,payment_verified_by=auth.uid(),payment_verified_at=now() where id=p_invoice_id;
end $$;

create function public.operational_record_verified_url(
  p_invoice_id uuid,p_provider text,p_payment_id text,p_link_id text,p_amount_cents bigint,p_currency text,p_url text,p_payload jsonb
) returns boolean language plpgsql security invoker set search_path = public as $$
declare v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id=p_invoice_id for update;
  if not found or v_invoice.status not in ('sent','paid') or v_invoice.payment_type not in ('one_shot','installments')
    or v_invoice.currency <> p_currency or round(v_invoice.total*100)::bigint <> p_amount_cents
    or not ((p_provider='razorpay' and p_currency='INR') or (p_provider='stripe' and p_currency='USD'))
    then raise exception 'Verified payment does not match an issued invoice'; end if;
  if exists(select 1 from public.payments where razorpay_payment_id=case when p_provider='stripe'
    then 'stripe:'||p_payment_id else p_payment_id end and invoice_id=p_invoice_id) then return false; end if;
  if v_invoice.status='paid' then raise exception 'Invoice already paid'; end if;
  insert into public.payments(invoice_id,razorpay_payment_id,stripe_payment_id,payment_link_id,amount,method,status,paid_at,raw_payload)
    values(p_invoice_id,case when p_provider='stripe' then 'stripe:'||p_payment_id else p_payment_id end,
      case when p_provider='stripe' then p_payment_id end,p_link_id,p_amount_cents::numeric/100,p_provider,'captured',now(),p_payload);
  update public.invoices set status='paid',paid_at=now(),external_payment_reference=p_provider||':'||p_payment_id,
    external_payment_evidence=p_url,payment_verified_at=now() where id=p_invoice_id;
  return true;
end $$;
revoke all on function public.operational_record_verified_url(uuid,text,text,text,bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.operational_record_verified_url(uuid,text,text,text,bigint,text,text,jsonb) to service_role;
