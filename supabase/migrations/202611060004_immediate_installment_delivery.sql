create function public.operational_release_due_invoices(p_ids uuid[])
returns setof public.invoices language plpgsql security definer set search_path=public as $$
begin
  if p_ids is null or cardinality(p_ids)<1 or cardinality(p_ids)>36 then
    raise exception 'Select between 1 and 36 installment invoices for delivery';
  end if;
  return query
    with due as (
      select i.id from public.invoices i
      join public.invoices r on r.id=coalesce(i.parent_invoice_id,i.id)
      where i.id=any(p_ids) and i.scheduled_for is not null
        and i.invoice_date<=(now() at time zone 'Asia/Kolkata')::date
        and i.status in ('scheduled','sent') and i.payment_expires_at>now()
        and i.email_message_id is null and i.email_lock_at is null
        and i.payment_link_lock_at is null and not i.tax_review_required and not r.tax_review_required
        and r.status not in ('pending_approval','rejected')
        and ((r.discount_percent=0 and r.pricing_review_note is null) or r.approved_at is not null)
        and (i.delivery_attempted_at is null or i.delivery_attempted_at<now()-interval '15 minutes')
      order by i.scheduled_for,i.id for update of i skip locked
    )
    update public.invoices i set status='sent',delivery_attempted_at=now(),
      payment_expires_at=case when i.scheduled_for>now() then now()+interval '96 hours' else i.payment_expires_at end,
      scheduled_for=least(i.scheduled_for,now())
      from due where i.id=due.id returning i.*;
end $$;
revoke all on function public.operational_release_due_invoices(uuid[]) from public,anon,authenticated;
grant execute on function public.operational_release_due_invoices(uuid[]) to service_role;
