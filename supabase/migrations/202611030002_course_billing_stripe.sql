create table public.courses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 200),
  price_inr numeric(12,2) not null check (price_inr between 1 and 99999999),
  price_usd numeric(12,2) not null check (price_usd between 1 and 99999999),
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.invoice_companies (
  code text primary key check (code in ('DMHCA','IBMP')),
  legal_name text not null check (length(trim(legal_name)) between 1 and 200),
  address text not null default '' check (length(address) <= 2000),
  tax_id text not null default '' check (length(tax_id) <= 100),
  primary_color text not null check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  accent_color text not null check (accent_color ~ '^#[0-9a-fA-F]{6}$')
);
insert into public.invoice_companies(code,legal_name,primary_color,accent_color) values
  ('DMHCA','DMHCA','#800020','#f7cbd7'),('IBMP','IBMP','#0b1e3b','#d7b770');
alter table public.courses enable row level security;
alter table public.invoice_companies enable row level security;
create policy "Invoice staff read courses" on public.courses for select to authenticated
  using (public.has_permission('invoices.view'));
create policy "Invoice staff read companies" on public.invoice_companies for select to authenticated
  using (public.has_permission('invoices.view'));
create policy "Administrators manage courses" on public.courses for all to authenticated
  using (public.has_permission('settings.manage') and exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')))
  with check (public.has_permission('settings.manage') and exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')));
create policy "Administrators update billing companies" on public.invoice_companies for update to authenticated
  using (public.has_permission('settings.manage') and exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')))
  with check (public.has_permission('settings.manage') and exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')));
create policy "Verified course sessions" on public.courses as restrictive to authenticated
  using (public.is_verified_session()) with check (public.is_verified_session());
create policy "Verified company sessions" on public.invoice_companies as restrictive to authenticated
  using (public.is_verified_session()) with check (public.is_verified_session());
revoke all on public.courses,public.invoice_companies from anon,authenticated;
grant select,insert,update on public.courses to authenticated;
grant select,update on public.invoice_companies to authenticated;
grant all on public.courses,public.invoice_companies to service_role;

alter table public.leads add column billing_address text not null default '' check (length(billing_address) <= 2000);
alter table public.invoices
  add column course_id uuid references public.courses(id),
  add column company_code text references public.invoice_companies(code),
  add column company_snapshot jsonb,
  add column billing_name text,
  add column billing_email text,
  add column billing_address text,
  add column owner_email text,
  add column status_token_encrypted text,
  add column stripe_session_id text unique,
  add column stripe_checkout_url text;
alter table public.payments add column stripe_payment_id text unique;
alter table public.integration_credentials drop constraint integration_credentials_provider_check;
alter table public.integration_credentials add constraint integration_credentials_provider_check
  check (provider in ('zoom','razorpay','stripe','smtp','gmail','intake','facebook'));

alter function public.operational_create_invoice(jsonb) rename to operational_create_legacy_invoice;
revoke all on function public.operational_create_legacy_invoice(jsonb) from public,anon,authenticated;
-- All new invoice inserts go through catalog pricing and immutable billing snapshots.
revoke insert on public.invoices,public.invoice_items,public.invoice_approvals from authenticated;
create function public.operational_create_invoice(p_input jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_lead public.leads;
  v_course public.courses;
  v_company public.invoice_companies;
  v_parent public.invoices;
  v_currency text := coalesce(p_input->>'currency','INR');
  v_price numeric(12,2);
  v_due numeric(12,2);
  v_discount numeric := coalesce((p_input->>'discount_percent')::numeric,0);
  v_tax numeric := coalesce((p_input->>'tax_amount')::numeric,0);
  v_address text;
  v_id uuid;
  v_owner_email text;
  v_description text;
  v_input jsonb;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.create')
    then raise exception 'Not authorized'; end if;
  select * into v_lead from public.leads where id=(p_input->>'lead_id')::uuid
    and not is_archived and merged_into_id is null
    and (assignee_id=auth.uid() or public.user_in_scope(assignee_id) or public.has_permission('users.view'));
  if not found then raise exception 'Lead unavailable'; end if;
  if nullif(p_input->>'parent_invoice_id','') is not null then
    select * into v_parent from public.invoices where id=(p_input->>'parent_invoice_id')::uuid and lead_id=v_lead.id;
    if not found or v_parent.parent_invoice_id is not null or p_input->>'payment_type' is distinct from 'installments'
      then raise exception 'Invalid installment parent'; end if;
  end if;
  if v_parent.id is not null and v_parent.course_id is null then
    if nullif(p_input->>'course_id','') is not null or v_parent.currency <> 'INR' or v_currency <> v_parent.currency or p_input->>'company_code' <> 'DMHCA'
      then raise exception 'Historical installments retain the original DMHCA/INR enrollment'; end if;
    select description into v_description from public.invoice_items where invoice_id=v_parent.id order by id limit 1;
    v_description := coalesce(v_description,'Historical course installment');
    v_price := v_parent.course_total;
  else
    select * into v_course from public.courses where id=nullif(p_input->>'course_id','')::uuid for share;
    if not found or (not v_course.is_active and v_parent.id is null) then raise exception 'Choose an active catalog course'; end if;
    v_description := v_course.name;
    v_price := case when v_currency='USD' then v_course.price_usd else v_course.price_inr end;
    if v_parent.id is not null then
      if v_parent.course_id is distinct from v_course.id or v_parent.company_code is distinct from p_input->>'company_code'
        or v_parent.currency <> v_currency then raise exception 'Installment must use the original course, company and currency'; end if;
      v_price := v_parent.course_total;
    end if;
  end if;
  if v_currency not in ('INR','USD') then raise exception 'Choose INR or USD'; end if;
  select * into v_company from public.invoice_companies where code=p_input->>'company_code' for share;
  if not found or trim(v_company.address)='' then raise exception 'Complete company billing details in Courses before issuing invoices'; end if;
  v_address := trim(coalesce(p_input->>'billing_address',v_lead.billing_address,''));
  if length(v_address) not between 1 and 2000 then raise exception 'Lead billing address is required (maximum 2000 characters)'; end if;
  if coalesce(v_lead.email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    then raise exception 'A valid lead email is required'; end if;
  if v_discount < 0 or v_discount > 100 or v_tax < 0 or v_tax <> round(v_tax,2)
    or v_discount <> round(v_discount,2) then raise exception 'Invalid discount or tax'; end if;
  v_due := case when p_input->>'payment_type'='installments'
    then (p_input->>'installment_amount')::numeric else v_price end;
  if v_due is null or v_due < 1 or v_due > v_price or v_due <> round(v_due,2)
    then raise exception 'Invalid installment amount'; end if;
  select email into v_owner_email from public.profiles where id=v_lead.assignee_id and status='active' and deleted_at is null;
  if coalesce(v_owner_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    then raise exception 'Assign an active lead owner with a valid email before issuing an invoice'; end if;
  v_input := p_input || jsonb_build_object('description',v_description,'quantity',1,'unit_price',v_due,
    'course_total',v_price-round(v_due*v_discount/100,2)+v_tax);
  v_id := public.operational_create_legacy_invoice(v_input);
  update public.invoices set currency=v_currency,course_id=v_course.id,company_code=v_company.code,
    company_snapshot=coalesce(v_parent.company_snapshot,to_jsonb(v_company)),
    billing_name=v_lead.name,billing_email=v_lead.email,billing_address=v_address,owner_email=v_owner_email where id=v_id;
  update public.invoices set creator_email=(select email from public.profiles where id=auth.uid()) where id=v_id;
  if coalesce((p_input->>'save_billing_address')::boolean,false) then
    if not public.has_permission('leads.edit') then raise exception 'Lead editing permission is required to save the billing address'; end if;
    update public.leads set billing_address=v_address,modified_by=auth.uid() where id=v_lead.id;
  end if;
  return v_id;
end $$;
revoke all on function public.operational_create_invoice(jsonb) from public,anon;
grant execute on function public.operational_create_invoice(jsonb) to authenticated;

create function public.operational_record_stripe_payment(
  p_invoice_id uuid,p_session_id text,p_payment_id text,p_amount_cents bigint,p_currency text,p_payload jsonb
) returns boolean language plpgsql security invoker set search_path = public as $$
declare v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id=p_invoice_id for update;
  if not found or v_invoice.stripe_session_id is distinct from p_session_id
    or v_invoice.currency <> 'USD' or p_currency <> 'usd'
    or v_invoice.payment_type not in ('one_shot','installments')
    or v_invoice.status not in ('sent','paid')
    or round(v_invoice.total*100)::bigint <> p_amount_cents then
    raise exception 'Stripe payment does not match an issued invoice';
  end if;
  if exists(select 1 from public.payments where stripe_payment_id=p_payment_id) then return false; end if;
  if v_invoice.status='paid' then raise exception 'Invoice already paid'; end if;
  insert into public.payments(invoice_id,razorpay_payment_id,stripe_payment_id,payment_link_id,amount,method,status,paid_at,raw_payload)
    values(p_invoice_id,'stripe:'||p_payment_id,p_payment_id,p_session_id,p_amount_cents::numeric/100,'stripe','captured',now(),p_payload);
  update public.invoices set status='paid',paid_at=now() where id=p_invoice_id;
  return true;
end $$;
revoke all on function public.operational_record_stripe_payment(uuid,text,text,bigint,text,jsonb) from public,anon,authenticated;
grant execute on function public.operational_record_stripe_payment(uuid,text,text,bigint,text,jsonb) to service_role;
