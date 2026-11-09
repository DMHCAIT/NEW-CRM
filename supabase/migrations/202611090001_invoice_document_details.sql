alter table public.invoice_companies
  add column invoice_profile jsonb not null default '{"bank_accounts":[],"billing_email":"","phone":"","website":"","refund_policy_url":""}'::jsonb
    check (jsonb_typeof(invoice_profile)='object');
alter table public.invoices
  add column document_details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(document_details)='object');

create function public.capture_invoice_document_details()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  v_input jsonb := coalesce(nullif(current_setting('crm.invoice_document_details',true),''),'{}')::jsonb;
  v_parent jsonb;
  v_phone text;
  v_key text;
begin
  if jsonb_typeof(v_input) is distinct from 'object' then raise exception 'Invalid invoice details'; end if;
  for v_key in select jsonb_object_keys(v_input) loop
    if v_key not in ('student_id','billing_phone','place_of_supply','course_details','sac_code')
      or jsonb_typeof(v_input->v_key)<>'string'
      or length(v_input->>v_key)>(case v_key when 'student_id' then 100 when 'billing_phone' then 100
        when 'place_of_supply' then 200 when 'course_details' then 300 else 30 end)
      then raise exception 'Invalid invoice detail: %',v_key; end if;
  end loop;
  select phone into v_phone from public.leads where id=new.lead_id;
  if new.parent_invoice_id is not null then
    select document_details into v_parent from public.invoices where id=new.parent_invoice_id;
  end if;
  new.document_details := jsonb_build_object('billing_phone',coalesce(v_phone,''))
    || coalesce(v_parent,'{}') || new.document_details || v_input;
  return new;
end $$;
revoke all on function public.capture_invoice_document_details() from public,anon,authenticated;
create trigger capture_invoice_document_details before insert on public.invoices
  for each row execute function public.capture_invoice_document_details();

alter function public.operational_create_invoice(jsonb) rename to operational_create_documentless_invoice;
revoke all on function public.operational_create_documentless_invoice(jsonb) from public,anon,authenticated;
create function public.operational_create_invoice(p_input jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_previous text := current_setting('crm.invoice_document_details',true);
begin
  perform set_config('crm.invoice_document_details',coalesce((p_input->'document_details')::text,'{}'),true);
  v_id := public.operational_create_documentless_invoice(p_input);
  perform set_config('crm.invoice_document_details',coalesce(v_previous,''),true);
  return v_id;
end $$;
revoke all on function public.operational_create_invoice(jsonb) from public,anon;
grant execute on function public.operational_create_invoice(jsonb) to authenticated;

alter function public.operational_create_installment_plan(jsonb) rename to operational_create_documentless_installment_plan;
revoke all on function public.operational_create_documentless_installment_plan(jsonb) from public,anon,authenticated;
create function public.operational_create_installment_plan(p_input jsonb)
returns uuid[] language plpgsql security definer set search_path=public as $$
declare v_ids uuid[]; v_previous text := current_setting('crm.invoice_document_details',true);
begin
  perform set_config('crm.invoice_document_details',coalesce((p_input->'document_details')::text,'{}'),true);
  v_ids := public.operational_create_documentless_installment_plan(p_input);
  perform set_config('crm.invoice_document_details',coalesce(v_previous,''),true);
  return v_ids;
end $$;
revoke all on function public.operational_create_installment_plan(jsonb) from public,anon;
grant execute on function public.operational_create_installment_plan(jsonb) to authenticated;
