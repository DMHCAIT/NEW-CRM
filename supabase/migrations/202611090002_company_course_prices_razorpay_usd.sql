alter table public.courses
  add column price_ibmp_usd numeric(12,2)
    check (price_ibmp_usd between 1 and 99999999);

-- Preserve the existing enrollment/approval implementation and change only its
-- catalog lookup and issuer snapshot. Abort if the expected implementation differs.
do $migration$
declare
  v_source text := pg_get_functiondef('public.operational_create_priced_invoice(jsonb)'::regprocedure);
  v_old text;
  v_new text;
begin
  for v_old,v_new in select * from (values
    ('if v_currency not in (''INR'',''USD'') then raise exception ''Choose INR or USD''; end if;',
     'if v_currency not in (''INR'',''USD'') then raise exception ''Choose INR or USD''; end if;
  if coalesce(p_input->>''company_code'','''') not in (''DMHCA'',''IBMP'') then raise exception ''Choose DMHCA or IBMP''; end if;
  if p_input->>''company_code''=''IBMP'' and v_currency<>''USD'' then raise exception ''IBMP invoices use USD only''; end if;'),
    ('v_price := case when v_currency=''USD'' then v_course.price_usd else v_course.price_inr end;',
     'v_price := case when p_input->>''company_code''=''IBMP'' then v_course.price_ibmp_usd
      when v_currency=''USD'' then v_course.price_usd else v_course.price_inr end;
    if v_price is null then raise exception ''Set the IBMP USD price in Courses before issuing this invoice''; end if;'),
    ('where code=p_input->>''company_code'' for share;',
     'where code=''DMHCA'' for share;'),
    ('v_currency,coalesce(v_parent.course_id,v_course.id),v_company.code,coalesce(v_parent.company_snapshot,to_jsonb(v_company)),',
     'v_currency,coalesce(v_parent.course_id,v_course.id),p_input->>''company_code'',coalesce(v_parent.company_snapshot,to_jsonb(v_company)),')
  ) as patches(old_text,new_text) loop
    if position(v_old in v_source)=0 then raise exception 'Unexpected invoice pricing function; reconcile migration before applying'; end if;
    v_source := replace(v_source,v_old,v_new);
  end loop;
  execute v_source;
end $migration$;

create or replace function public.operational_create_installment_plan(p_input jsonb)
returns uuid[] language plpgsql security definer set search_path=public as $$
declare v_ids uuid[]; v_previous text := current_setting('crm.invoice_document_details',true);
begin
  if p_input->>'company_code'='IBMP' and coalesce(p_input->>'currency','INR')<>'USD'
    then raise exception 'IBMP invoices use USD only'; end if;
  perform set_config('crm.invoice_document_details',coalesce((p_input->'document_details')::text,'{}'),true);
  v_ids := public.operational_create_documentless_installment_plan(p_input);
  perform set_config('crm.invoice_document_details',coalesce(v_previous,''),true);
  return v_ids;
end $$;
revoke all on function public.operational_create_installment_plan(jsonb) from public,anon;
grant execute on function public.operational_create_installment_plan(jsonb) to authenticated;

create or replace function public.operational_record_verified_url(
  p_invoice_id uuid,p_provider text,p_payment_id text,p_link_id text,p_amount_cents bigint,p_currency text,p_url text,p_payload jsonb
) returns boolean language plpgsql security invoker set search_path=public as $$
declare v_invoice public.invoices; v_root public.invoices;
begin
  select r.* into v_root from public.invoices i join public.invoices r on r.id=coalesce(i.parent_invoice_id,i.id)
    where i.id=p_invoice_id for update of r;
  select * into v_invoice from public.invoices where id=p_invoice_id for update;
  if not found or v_invoice.status not in ('sent','scheduled','expired','paid')
    or v_invoice.payment_type not in ('one_shot','installments')
    or v_invoice.tax_review_required or v_root.tax_review_required
    or v_root.status in ('pending_approval','rejected')
    or ((v_root.discount_percent>0 or v_root.pricing_review_note is not null) and v_root.approved_at is null)
    or v_invoice.currency<>p_currency or round(v_invoice.total*100)::bigint<>p_amount_cents
    or not ((p_provider='razorpay' and p_currency in ('INR','USD')) or (p_provider='stripe' and p_currency='USD'))
    then raise exception 'Verified payment does not match an approved invoice'; end if;
  if exists(select 1 from public.payments where razorpay_payment_id=case when p_provider='stripe'
    then 'stripe:'||p_payment_id else p_payment_id end and invoice_id=p_invoice_id) then return false; end if;
  if v_invoice.status='paid' then raise exception 'Invoice already paid'; end if;
  insert into public.payments(invoice_id,razorpay_payment_id,stripe_payment_id,payment_link_id,amount,method,status,paid_at,raw_payload)
    values(p_invoice_id,case when p_provider='stripe' then 'stripe:'||p_payment_id else p_payment_id end,
      case when p_provider='stripe' then p_payment_id end,p_link_id,p_amount_cents::numeric/100,p_provider,'captured',now(),p_payload);
  update public.invoices set status='paid',paid_at=now(),external_payment_reference=p_provider||':'||p_payment_id,
    external_payment_evidence=p_url,payment_verified_at=now(),delivery_error=null where id=p_invoice_id;
  return true;
end $$;
revoke all on function public.operational_record_verified_url(uuid,text,text,text,bigint,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.operational_record_verified_url(uuid,text,text,text,bigint,text,text,jsonb) to service_role;
