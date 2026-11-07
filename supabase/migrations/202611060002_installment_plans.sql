alter table public.invoices
  add column invoice_date date,
  add column scheduled_for timestamptz,
  add column plan_request_id uuid,
  add column delivery_error text,
  add column delivery_attempted_at timestamptz;
create index invoices_scheduled_delivery_idx on public.invoices(scheduled_for)
  where scheduled_for is not null and email_message_id is null;
create index invoices_plan_request_idx on public.invoices(created_by,plan_request_id)
  where plan_request_id is not null;

alter function public.operational_create_invoice(jsonb) rename to operational_create_unscheduled_invoice;
revoke all on function public.operational_create_unscheduled_invoice(jsonb) from public,anon,authenticated;
create function public.operational_create_invoice(p_input jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
begin
  if p_input->>'payment_type'='installments' then raise exception 'Use the installment schedule to create installment invoices'; end if;
  return public.operational_create_unscheduled_invoice(p_input);
end $$;
revoke all on function public.operational_create_invoice(jsonb) from public,anon;
grant execute on function public.operational_create_invoice(jsonb) to authenticated;

create function public.operational_create_installment_plan(p_input jsonb)
returns uuid[] language plpgsql security definer set search_path=public as $$
declare
  v_root public.invoices;
  v_row public.invoices;
  v_entry jsonb;
  v_ids uuid[] := '{}';
  v_request uuid := (p_input->>'request_id')::uuid;
  v_id uuid;
  v_parent uuid := nullif(p_input->>'parent_invoice_id','')::uuid;
  v_lead public.leads;
  v_date date;
  v_previous date;
  v_scheduled timestamptz;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_amount numeric;
  v_sum numeric := 0;
  v_reserved numeric := 0;
  v_discount numeric := 0;
  v_tax numeric := 0;
  v_number integer;
  v_count integer;
  v_first boolean := true;
  v_new boolean := false;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.create')
    then raise exception 'Not authorized'; end if;
  if v_request is null or p_input->>'payment_type' is distinct from 'installments'
    or jsonb_typeof(p_input->'installments') is distinct from 'array'
    then raise exception 'An installment schedule and request ID are required'; end if;
  v_count := jsonb_array_length(p_input->'installments');
  if v_count not between 1 and 36 then raise exception 'Create between 1 and 36 installments'; end if;
  select * into v_lead from public.leads where id=(p_input->>'lead_id')::uuid
    and not is_archived and merged_into_id is null
    and (assignee_id=auth.uid() or public.user_in_scope(assignee_id) or public.has_permission('users.view'));
  if not found then raise exception 'Lead unavailable'; end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text||v_request::text));
  select array_agg(id order by installment_number) into v_ids from public.invoices
    where created_by=auth.uid() and plan_request_id=v_request;
  if v_ids is not null then return v_ids; end if;
  v_ids := '{}';
  perform pg_advisory_xact_lock(hashtext(v_lead.id::text || coalesce(p_input->>'course_id','historical')
    || coalesce(p_input->>'company_code','') || coalesce(p_input->>'currency','INR')));
  if v_parent is null then
    select id into v_parent from public.invoices i where lead_id=v_lead.id
      and course_id=nullif(p_input->>'course_id','')::uuid and company_code=p_input->>'company_code'
      and currency=coalesce(p_input->>'currency','INR') and payment_type='installments'
      and parent_invoice_id is null and status<>'rejected'
      and not (status='cancelled' and (discount_percent>0 or pricing_review_note is not null) and approved_at is null)
      order by created_at desc,id limit 1;
  end if;
  if v_parent is not null then
    perform pg_advisory_xact_lock(hashtext(v_parent::text));
    select * into v_root from public.invoices where id=v_parent and lead_id=v_lead.id for update;
    if not found or v_root.parent_invoice_id is not null or v_root.payment_type<>'installments'
      or v_root.status not in ('sent','paid','pending_approval','scheduled','expired','cancelled')
      or v_root.tax_review_required then raise exception 'Enrollment is unavailable or requires administrator review'; end if;
    if (v_root.discount_percent>0 or v_root.pricing_review_note is not null)
      and v_root.approved_at is null and v_root.status<>'pending_approval'
      then raise exception 'The original enrollment discount still requires administrator approval'; end if;
    if v_root.course_id is distinct from nullif(p_input->>'course_id','')::uuid
      or coalesce(v_root.company_code,'DMHCA') is distinct from p_input->>'company_code'
      or v_root.currency is distinct from coalesce(p_input->>'currency','INR')
      then raise exception 'Installments must retain the original course, company and currency'; end if;
  end if;
  for v_entry in select value from jsonb_array_elements(p_input->'installments') loop
    v_amount := (v_entry->>'amount')::numeric;
    v_date := (v_entry->>'invoice_date')::date;
    if v_amount is null or v_amount<1 or v_amount>99999999 or v_amount<>round(v_amount,2)
      then raise exception 'Each installment needs an amount of at least one currency unit with at most two decimals'; end if;
    if v_date is null or v_date<v_today or v_date>v_today+interval '5 years'
      or (v_previous is not null and v_date<v_previous)
      then raise exception 'Choose chronological invoice dates from today through five years ahead'; end if;
    v_previous := v_date;
    v_sum := v_sum+v_amount;
  end loop;
  if v_root.id is null then
    v_new := true;
    v_entry := p_input->'installments'->0;
    v_id := public.operational_create_unscheduled_invoice(
      p_input || jsonb_build_object('installment_amount',v_entry->'amount','parent_invoice_id',null,'save_billing_address',false));
    select * into v_root from public.invoices where id=v_id;
    v_parent := v_root.id;
  end if;
  select coalesce(sum(total),0),coalesce(sum(discount_amount),0),coalesce(sum(tax_amount),0)
    into v_reserved,v_discount,v_tax from public.invoices
    where coalesce(parent_invoice_id,id)=v_parent and status not in ('cancelled','rejected')
      and not (id=v_parent and v_new);
  if v_sum>v_root.course_total-v_reserved then raise exception 'The plan exceeds the unallocated course balance'; end if;
  if v_root.course_total-v_reserved-v_sum between 0.01 and 0.99
    then raise exception 'Include the remaining balance; an installment cannot be less than one currency unit'; end if;
  select coalesce(max(installment_number),0)+1 into v_number from public.invoices where coalesce(parent_invoice_id,id)=v_parent;
  for v_entry in select value from jsonb_array_elements(p_input->'installments') loop
    v_amount := (v_entry->>'amount')::numeric;
    v_date := (v_entry->>'invoice_date')::date;
    v_scheduled := (v_date+time '09:00') at time zone 'Asia/Kolkata';
    if v_first and v_new then
      v_row := v_root;
    else
      v_row := v_root;
      v_row.id := gen_random_uuid();
      v_row.invoice_no := 'INV-'||to_char(now(),'YYYYMMDD')||'-'||upper(substr(replace(v_row.id::text,'-',''),1,12));
      v_row.parent_invoice_id := v_parent;
      v_row.created_by := auth.uid();
      v_row.created_at := now();
      v_row.installment_number := v_number;
      v_number := v_number+1;
      v_row.status := 'scheduled';
      v_row.total := v_amount;
      v_row.discount_amount := round(coalesce(v_root.enrollment_discount,0)*(v_reserved+v_amount)/v_root.course_total,2)-v_discount;
      v_row.tax_amount := round(coalesce(v_root.enrollment_tax,0)*(v_reserved+v_amount)/v_root.course_total,2)-v_tax;
      v_row.subtotal := v_amount+v_row.discount_amount-v_row.tax_amount;
      v_row.notes := p_input->>'notes';
      v_row.creator_email := (select email from public.profiles where id=auth.uid());
      v_row.billing_address := trim(p_input->>'billing_address');
      if coalesce(v_row.billing_address,'')='' or length(v_row.billing_address)>2000
        then raise exception 'A valid billing address is required'; end if;
      if coalesce(v_lead.email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        then raise exception 'A valid lead email is required'; end if;
      v_row.billing_name := v_lead.name; v_row.billing_email := v_lead.email;
      v_row.owner_email := (select email from public.profiles where id=v_lead.assignee_id and status='active' and deleted_at is null);
      if coalesce(v_row.owner_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        then raise exception 'Assign an active lead owner with a valid email before issuing an invoice'; end if;
      v_row.approved_by := null; v_row.approved_at := null;
      v_row.sent_at := null; v_row.paid_at := null;
      v_row.razorpay_payment_link_id := null; v_row.razorpay_short_url := null;
      v_row.stripe_session_id := null; v_row.stripe_checkout_url := null; v_row.stripe_expires_at := null;
      v_row.status_token_hash := null; v_row.status_token_encrypted := null;
      v_row.email_message_id := null; v_row.email_lock_at := null; v_row.payment_link_lock_at := null;
      v_row.external_payment_reference := null; v_row.external_payment_evidence := null;
      v_row.payment_verified_by := null; v_row.payment_verified_at := null;
      v_row.payment_revision := 1;
      v_row.pdf_url := null; v_row.razorpay_qr_id := null; v_row.qr_image_url := null;
      v_row.qr_expires_at := null; v_row.payment_lock_at := null;
      v_row.receipt_email_message_id := null; v_row.receipt_email_lock_at := null;
      v_row.delivery_error := null; v_row.delivery_attempted_at := null;
      v_row.company_code := coalesce(v_root.company_code,'DMHCA');
      v_row.company_snapshot := coalesce(v_root.company_snapshot,
        (select to_jsonb(c) from public.invoice_companies c where code=v_row.company_code));
      insert into public.invoices select (v_row).*;
      insert into public.invoice_items(invoice_id,description,quantity,unit_price,amount)
        select v_row.id,description,1,v_row.subtotal,v_row.subtotal from public.invoice_items
          where invoice_id=v_parent order by id limit 1;
    end if;
    update public.invoices set invoice_date=v_date,scheduled_for=v_scheduled,plan_request_id=v_request,
      payment_expires_at=v_scheduled+interval '96 hours',due_date=v_date+4,
      status=case when status='pending_approval' then status else 'scheduled'::public.invoice_status end
      where id=v_row.id;
    v_ids := array_append(v_ids,v_row.id);
    v_reserved := v_reserved+v_row.total;
    v_discount := v_discount+v_row.discount_amount;
    v_tax := v_tax+v_row.tax_amount;
    v_first := false;
  end loop;
  if coalesce((p_input->>'save_billing_address')::boolean,false) then
    if not public.has_permission('leads.edit') then raise exception 'Lead editing permission is required to save the billing address'; end if;
    update public.leads set billing_address=trim(p_input->>'billing_address'),modified_by=auth.uid() where id=v_lead.id;
  end if;
  return v_ids;
end $$;
revoke all on function public.operational_create_installment_plan(jsonb) from public,anon;
grant execute on function public.operational_create_installment_plan(jsonb) to authenticated;

alter function public.operational_decide_invoice(uuid,text,text) rename to operational_decide_unscheduled_invoice;
revoke all on function public.operational_decide_unscheduled_invoice(uuid,text,text) from public,anon,authenticated;
create function public.operational_decide_invoice(p_id uuid,p_decision text,p_comment text)
returns void language plpgsql security definer set search_path=public as $$
declare v_invoice public.invoices;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.approve')
    or not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin') and status='active' and deleted_at is null)
    then raise exception 'Not authorized'; end if;
  select * into v_invoice from public.invoices where id=p_id for update;
  if not found then raise exception 'Invoice unavailable'; end if;
  perform public.operational_decide_unscheduled_invoice(p_id,p_decision,p_comment);
  if v_invoice.scheduled_for is not null and p_decision='approved' then
    update public.invoices set status='scheduled' where id=p_id;
  elsif p_decision='rejected' then
    update public.invoices set status='cancelled',delivery_error='Enrollment discount request was rejected'
      where parent_invoice_id=p_id and status='scheduled';
  end if;
end $$;
revoke all on function public.operational_decide_invoice(uuid,text,text) from public,anon;
grant execute on function public.operational_decide_invoice(uuid,text,text) to authenticated;

create function public.operational_release_due_invoices()
returns setof public.invoices language plpgsql security definer set search_path=public as $$
begin
  update public.invoices set status='expired',delivery_error='Scheduled payment window expired before delivery; administrator reconciliation required'
    where status='scheduled' and payment_expires_at<=now();
  return query
    with due as (
      select i.id from public.invoices i
      join public.invoices r on r.id=coalesce(i.parent_invoice_id,i.id)
      where i.scheduled_for<=now() and i.status in ('scheduled','sent')
        and i.payment_expires_at>now() and i.email_message_id is null and i.email_lock_at is null
        and i.payment_link_lock_at is null and not i.tax_review_required and not r.tax_review_required
        and r.status not in ('pending_approval','rejected')
        and ((r.discount_percent=0 and r.pricing_review_note is null) or r.approved_at is not null)
        and (i.delivery_attempted_at is null or i.delivery_attempted_at<now()-interval '15 minutes')
      order by i.scheduled_for,i.id limit 5 for update of i skip locked
    )
    update public.invoices i set status='sent',delivery_attempted_at=now()
      from due where i.id=due.id returning i.*;
end $$;
revoke all on function public.operational_release_due_invoices() from public,anon,authenticated;
grant execute on function public.operational_release_due_invoices() to service_role;
