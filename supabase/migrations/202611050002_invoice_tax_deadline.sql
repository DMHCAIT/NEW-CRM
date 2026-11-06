alter table public.invoices
  add column payment_expires_at timestamptz,
  add column stripe_expires_at timestamptz,
  add column tax_review_required boolean not null default false,
  add column payment_revision integer not null default 1,
  add column pricing_review_note text;
update public.invoices set payment_expires_at=created_at+interval '96 hours';
update public.invoices set due_date=((created_at+interval '96 hours') at time zone 'UTC')::date
  where status in ('sent','pending_approval');
alter table public.invoices alter column payment_expires_at set not null;
alter table public.invoices alter column payment_expires_at set default (now()+interval '96 hours');

create table public.invoice_checkout_sessions (
  session_id text primary key,
  invoice_id uuid not null references public.invoices(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index invoice_checkout_sessions_invoice_idx on public.invoice_checkout_sessions(invoice_id);
alter table public.invoice_checkout_sessions enable row level security;
revoke all on public.invoice_checkout_sessions from public,anon,authenticated;
grant all on public.invoice_checkout_sessions to service_role;
insert into public.invoice_checkout_sessions(session_id,invoice_id,expires_at)
  select stripe_session_id,id,coalesce(sent_at,created_at)+interval '24 hours' from public.invoices where stripe_session_id is not null;

-- Flag wholly unpaid agreements for review; do not rewrite issued totals or paid history.
update public.invoices i set tax_review_required=true
where i.parent_invoice_id is null and i.status in ('sent','pending_approval')
  and not exists(select 1 from public.invoices c where coalesce(c.parent_invoice_id,c.id)=i.id and c.status='paid')
  and coalesce(i.enrollment_tax_percent,case when i.subtotal>i.discount_amount
    then round(i.tax_amount/(i.subtotal-i.discount_amount)*100,2) else 0 end)
    <> case when i.currency='INR' then 18 else 0 end;

alter function public.operational_create_invoice(jsonb) rename to operational_create_priced_invoice;
revoke all on function public.operational_create_priced_invoice(jsonb) from public,anon,authenticated;
create function public.operational_create_invoice(p_input jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_id uuid;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.create')
    then raise exception 'Not authorized'; end if;
  if exists(select 1 from public.invoices where tax_review_required and status in ('sent','pending_approval') and lead_id=(p_input->>'lead_id')::uuid
    and (id=nullif(p_input->>'parent_invoice_id','')::uuid or
      (course_id=nullif(p_input->>'course_id','')::uuid and company_code=p_input->>'company_code'
        and currency=coalesce(p_input->>'currency','INR'))))
    then raise exception 'An administrator must review the existing enrollment tax before creating another installment'; end if;
  v_id := public.operational_create_priced_invoice(p_input || jsonb_build_object(
    'tax_percent',case when p_input->>'currency'='USD' then 0 else 18 end,
    'due_date',((now()+interval '96 hours') at time zone 'UTC')::date));
  update public.invoices set payment_expires_at=created_at+interval '96 hours',
    due_date=((created_at+interval '96 hours') at time zone 'UTC')::date where id=v_id;
  return v_id;
end $$;
revoke all on function public.operational_create_invoice(jsonb) from public,anon;
grant execute on function public.operational_create_invoice(jsonb) to authenticated;

create function public.operational_review_invoice_tax(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_invoice public.invoices; v_base numeric(12,2); v_discount numeric(12,2); v_tax numeric(12,2);
  v_total numeric(12,2); v_due numeric(12,2); v_invoice_discount numeric(12,2); v_invoice_tax numeric(12,2); v_rate numeric;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.approve')
    or not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin'))
    then raise exception 'Not authorized'; end if;
  perform pg_advisory_xact_lock(hashtext(p_id::text));
  select * into v_invoice from public.invoices where id=p_id for update;
  if not found or not v_invoice.tax_review_required or v_invoice.parent_invoice_id is not null
    or v_invoice.status not in ('sent','pending_approval') then raise exception 'Tax review is unavailable'; end if;
  if exists(select 1 from public.invoices where coalesce(parent_invoice_id,id)=p_id and status='paid')
    then raise exception 'Payments have been received. Finance must reconcile the agreement without rewriting paid history'; end if;
  if v_invoice.razorpay_payment_link_id is not null or v_invoice.stripe_session_id is not null
    or v_invoice.payment_link_lock_at is not null or v_invoice.email_lock_at is not null
    then raise exception 'Reconcile and cancel existing payment links before reviewing tax'; end if;
  v_rate := case when v_invoice.currency='INR' then 18 else 0 end;
  v_base := coalesce(v_invoice.enrollment_subtotal,case when v_invoice.payment_type='installments'
    then v_invoice.course_total else v_invoice.subtotal end);
  v_discount := round(v_base*v_invoice.discount_percent/100,2);
  v_tax := round((v_base-v_discount)*v_rate/100,2);
  v_total := v_base-v_discount+v_tax;
  v_due := case when v_invoice.payment_type='installments' then least(v_invoice.total,v_total) else v_total end;
  if v_due<1 or (v_total>v_due and v_total-v_due<1) then raise exception 'Finance must reconcile the installment amount before applying the tax policy'; end if;
  v_invoice_discount := round(v_discount*v_due/v_total,2);
  v_invoice_tax := round(v_tax*v_due/v_total,2);
  update public.invoices set enrollment_subtotal=v_base,enrollment_discount=v_discount,enrollment_tax=v_tax,
    enrollment_tax_percent=v_rate,course_total=v_total,total=v_due,subtotal=v_due+v_invoice_discount-v_invoice_tax,
    discount_amount=v_invoice_discount,tax_amount=v_invoice_tax,tax_review_required=false,status='pending_approval',
    pricing_review_note='Tax policy revised to '||v_rate||'%. Previous course total: '||coalesce(v_invoice.course_total,v_invoice.total)||'. Admin approval required.',
    approved_by=null,approved_at=null,email_message_id=null,sent_at=null,
    status_token_hash=null,status_token_encrypted=null,payment_revision=payment_revision+1
    where id=p_id;
  update public.invoice_items set unit_price=v_due+v_invoice_discount-v_invoice_tax,
    amount=v_due+v_invoice_discount-v_invoice_tax,quantity=1 where invoice_id=p_id;
  if not exists(select 1 from public.invoice_approvals where invoice_id=p_id and decision='pending') then
    insert into public.invoice_approvals(invoice_id,requested_by) values(p_id,auth.uid());
  end if;
end $$;
revoke all on function public.operational_review_invoice_tax(uuid) from public,anon;
grant execute on function public.operational_review_invoice_tax(uuid) to authenticated;

create or replace function public.operational_decide_invoice(p_id uuid,p_decision text,p_comment text)
returns void language plpgsql security invoker set search_path=public as $$
declare v_invoice public.invoices;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.approve')
    or not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin'))
    then raise exception 'Not authorized'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  select * into v_invoice from public.invoices where id=p_id for update;
  if not found or v_invoice.status<>'pending_approval' or v_invoice.tax_review_required
    or (v_invoice.discount_percent<=0 and v_invoice.pricing_review_note is null)
    then raise exception 'Invoice approval unavailable or already decided; complete any tax review first'; end if;
  if p_decision='approved' and v_invoice.payment_expires_at<=now() then raise exception 'Invoice payment window expired. Issue a new invoice instead'; end if;
  update public.invoices set status=case when p_decision='approved' then 'sent'::public.invoice_status else 'rejected'::public.invoice_status end,
    approved_by=auth.uid(),approved_at=now() where id=p_id;
  update public.invoice_approvals set decision=p_decision,decided_by=auth.uid(),comment=p_comment,decided_at=now()
    where invoice_id=p_id and decision='pending';
end $$;

create or replace function public.operational_record_stripe_payment(
  p_invoice_id uuid,p_session_id text,p_payment_id text,p_amount_cents bigint,p_currency text,p_payload jsonb
) returns boolean language plpgsql security invoker set search_path=public as $$
declare v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id=p_invoice_id for update;
  if not found or (v_invoice.stripe_session_id is distinct from p_session_id and not exists(
      select 1 from public.invoice_checkout_sessions where session_id=p_session_id and invoice_id=p_invoice_id))
    or v_invoice.currency<>'USD' or p_currency<>'usd' or v_invoice.payment_type not in ('one_shot','installments')
    or v_invoice.status not in ('sent','paid')
    or round(v_invoice.total*100)::bigint<>p_amount_cents then raise exception 'Stripe payment does not match an issued invoice'; end if;
  if exists(select 1 from public.payments where stripe_payment_id=p_payment_id and invoice_id=p_invoice_id) then return false; end if;
  if v_invoice.status='paid' then raise exception 'Invoice already paid'; end if;
  insert into public.payments(invoice_id,razorpay_payment_id,stripe_payment_id,payment_link_id,amount,method,status,paid_at,raw_payload)
    values(p_invoice_id,'stripe:'||p_payment_id,p_payment_id,p_session_id,p_amount_cents::numeric/100,'stripe','captured',now(),p_payload);
  update public.invoices set status='paid',paid_at=now() where id=p_invoice_id;
  return true;
end $$;
