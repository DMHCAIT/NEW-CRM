begin;

do $migration$
declare
  v_source text := pg_get_functiondef('public.operational_decide_invoice(uuid,text,text)'::regprocedure);
  v_old text := 'if not found then raise exception ''Invoice unavailable''; end if;
  perform public.operational_decide_unscheduled_invoice(p_id,p_decision,p_comment);';
  v_new text := 'if not found then raise exception ''Invoice unavailable''; end if;
  if v_invoice.discount_percent > 0 and not exists (
    select 1 from public.profiles where id=auth.uid() and role=''super_admin''
      and status=''active'' and deleted_at is null
  ) then raise exception ''Super Admin approval is required for discounts''; end if;
  perform public.operational_decide_unscheduled_invoice(p_id,p_decision,p_comment);';
begin
  if position(v_old in v_source)=0 then
    raise exception 'Unexpected invoice approval function; reconcile migration before applying';
  end if;
  execute replace(v_source,v_old,v_new);
end $migration$;

create policy "Super Admin decides discounted invoices" on public.invoices
  as restrictive for update to authenticated
  using (discount_percent=0 or exists (
    select 1 from public.profiles where id=auth.uid() and role='super_admin'
      and status='active' and deleted_at is null and public.has_permission('invoices.approve')
  ))
  with check (discount_percent=0 or exists (
    select 1 from public.profiles where id=auth.uid() and role='super_admin'
      and status='active' and deleted_at is null and public.has_permission('invoices.approve')
  ));

create policy "Super Admin decides discount requests" on public.invoice_approvals
  as restrictive for update to authenticated
  using (exists (
    select 1 from public.invoices i where i.id=invoice_id and (i.discount_percent=0 or exists (
      select 1 from public.profiles where id=auth.uid() and role='super_admin'
        and status='active' and deleted_at is null and public.has_permission('invoices.approve')
    ))
  ))
  with check (exists (
    select 1 from public.invoices i where i.id=invoice_id and (i.discount_percent=0 or exists (
      select 1 from public.profiles where id=auth.uid() and role='super_admin'
        and status='active' and deleted_at is null and public.has_permission('invoices.approve')
    ))
  ));

commit;
