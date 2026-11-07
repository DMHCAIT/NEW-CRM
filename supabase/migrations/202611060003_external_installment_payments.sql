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
    or not ((p_provider='razorpay' and p_currency='INR') or (p_provider='stripe' and p_currency='USD'))
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

create or replace function public.operational_confirm_external_payment(p_invoice_id uuid,p_reference text,p_evidence text)
returns void language plpgsql security definer set search_path=public as $$
declare v_invoice public.invoices; v_root public.invoices;
begin
  if auth.uid() is null or not public.is_verified_session() or not public.has_permission('invoices.approve')
    or not exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin') and status='active' and deleted_at is null)
    then raise exception 'Not authorized'; end if;
  if coalesce(trim(p_reference),'')='' or length(trim(p_reference))>200
    or coalesce(trim(p_evidence),'')='' or length(trim(p_evidence))>2000 then raise exception 'Payment reference and evidence are required'; end if;
  select r.* into v_root from public.invoices i join public.invoices r on r.id=coalesce(i.parent_invoice_id,i.id)
    where i.id=p_invoice_id for update of r;
  select * into v_invoice from public.invoices where id=p_invoice_id for update;
  if not found then raise exception 'Invoice unavailable'; end if;
  if v_invoice.status='paid' and v_invoice.external_payment_reference=p_reference then return; end if;
  if v_invoice.status not in ('sent','scheduled','expired') or v_invoice.tax_review_required or v_root.tax_review_required
    or v_root.status in ('pending_approval','rejected')
    or ((v_root.discount_percent>0 or v_root.pricing_review_note is not null) and v_root.approved_at is null)
    then raise exception 'Only approved unpaid invoices can be verified externally'; end if;
  insert into public.payments(invoice_id,razorpay_payment_id,external_reference,amount,method,status,paid_at,raw_payload,verified_by)
    values(p_invoice_id,'external:'||p_reference,p_reference,v_invoice.total,'external','verified_external',now(),
      jsonb_build_object('evidence',p_evidence),auth.uid());
  update public.invoices set status='paid',paid_at=now(),external_payment_reference=p_reference,
    external_payment_evidence=p_evidence,payment_verified_by=auth.uid(),payment_verified_at=now(),delivery_error=null where id=p_invoice_id;
end $$;
