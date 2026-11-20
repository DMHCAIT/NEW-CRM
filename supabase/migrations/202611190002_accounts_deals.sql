begin;

alter type public.crm_role add value if not exists 'accounts';

create function public.is_accounts_user()
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_verified_session() and exists (
    select 1 from public.profiles where id=auth.uid() and role::text='accounts'
      and status='active' and deleted_at is null
  );
$$;
revoke all on function public.is_accounts_user() from public, anon;
grant execute on function public.is_accounts_user() to authenticated;

create function public.is_deal_stage(p_stage_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.lead_stages
    where id=p_stage_id and lower(name) in ('closed won','already enrolled'));
$$;
revoke all on function public.is_deal_stage(uuid) from public, anon;
grant execute on function public.is_deal_stage(uuid) to authenticated;

create function public.deal_stage_ids()
returns uuid[] language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(id), '{}'::uuid[]) from public.lead_stages
    where lower(name) in ('closed won','already enrolled');
$$;
revoke all on function public.deal_stage_ids() from public, anon;
grant execute on function public.deal_stage_ids() to authenticated;

-- A new enum value cannot be inserted until this migration commits. Seed its
-- configurable defaults when the first Accounts profile is created.
create function public.seed_accounts_permissions()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.role::text='accounts' then
    insert into public.role_permissions(role,permission_key,allowed)
      select new.role, permission_key, true
      from unnest(array['invoices.view','invoices.create','invoices.approve','courses.manage']) permission_key
      on conflict (role,permission_key) do nothing;
    insert into public.role_permissions(role,permission_key,allowed)
      values (new.role,'deals.view',true)
      on conflict (role,permission_key) do update set allowed=true;
  end if;
  return new;
end;
$$;
revoke all on function public.seed_accounts_permissions() from public, anon, authenticated;
create trigger seed_accounts_permissions after insert or update of role on public.profiles
  for each row execute function public.seed_accounts_permissions();

insert into public.role_permissions(role,permission_key,allowed) values
  ('admin','courses.manage',true),('super_admin','courses.manage',true)
on conflict (role,permission_key) do nothing;
insert into public.role_permissions(role,permission_key,allowed) values
  ('admin','deals.view',true),('super_admin','deals.view',true)
on conflict (role,permission_key) do update set allowed=true;

create policy "Accounts read deal leads" on public.leads for select to authenticated
  using ((select public.is_accounts_user()) and (select public.has_permission('deals.view'))
    and not is_archived and merged_into_id is null and stage_id = any((select public.deal_stage_ids())::uuid[]));
create policy "Accounts are limited to deal leads" on public.leads as restrictive for select to authenticated
  using (not (select public.is_accounts_user()) or
    (not is_archived and merged_into_id is null and stage_id = any((select public.deal_stage_ids())::uuid[])));
create policy "Accounts read invoices" on public.invoices for select to authenticated
  using (public.is_accounts_user() and public.has_permission('invoices.view'));
create policy "Accounts manage courses" on public.courses for all to authenticated
  using (public.is_accounts_user() and public.has_permission('courses.manage'))
  with check (public.is_accounts_user() and public.has_permission('courses.manage'));

alter policy "Only administrators decide invoices" on public.invoices
  using (public.is_accounts_user() or exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')))
  with check (public.is_accounts_user() or exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')));
alter policy "Only administrators decide discounts" on public.invoice_approvals
  using (public.is_accounts_user() or exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')))
  with check (public.is_accounts_user() or exists(select 1 from public.profiles where id=auth.uid() and role in ('admin','super_admin')));
alter policy "Super Admin decides discounted invoices" on public.invoices
  using (discount_percent=0 or (public.is_accounts_user() and public.has_permission('invoices.approve')) or exists (
    select 1 from public.profiles where id=auth.uid() and role='super_admin'
      and status='active' and deleted_at is null and public.has_permission('invoices.approve')))
  with check (discount_percent=0 or (public.is_accounts_user() and public.has_permission('invoices.approve')) or exists (
    select 1 from public.profiles where id=auth.uid() and role='super_admin'
      and status='active' and deleted_at is null and public.has_permission('invoices.approve')));
alter policy "Super Admin decides discount requests" on public.invoice_approvals
  using (exists (select 1 from public.invoices i where i.id=invoice_id and
    (i.discount_percent=0 or (public.is_accounts_user() and public.has_permission('invoices.approve')) or exists (
      select 1 from public.profiles where id=auth.uid() and role='super_admin'
        and status='active' and deleted_at is null and public.has_permission('invoices.approve')))))
  with check (exists (select 1 from public.invoices i where i.id=invoice_id and
    (i.discount_percent=0 or (public.is_accounts_user() and public.has_permission('invoices.approve')) or exists (
      select 1 from public.profiles where id=auth.uid() and role='super_admin'
        and status='active' and deleted_at is null and public.has_permission('invoices.approve')))));

do $migration$
declare
  v_function regprocedure;
  v_source text;
  v_old text;
  v_new text;
begin
  foreach v_function in array array[
    'public.operational_create_priced_invoice(jsonb)'::regprocedure,
    'public.operational_create_documentless_installment_plan(jsonb)'::regprocedure
  ] loop
    v_source := pg_get_functiondef(v_function);
    v_old := 'and (assignee_id=auth.uid() or public.user_in_scope(assignee_id) or public.has_permission(''users.view''))';
    v_new := 'and (assignee_id=auth.uid() or public.user_in_scope(assignee_id) or public.has_permission(''users.view'')
      or (public.is_accounts_user() and public.is_deal_stage(stage_id)))';
    if position(v_old in v_source)=0 then raise exception 'Unexpected invoice creation function %', v_function; end if;
    -- Accounts may create invoices only for deals, even if a lead is assigned to them.
    v_new := v_new || ' and (not public.is_accounts_user() or public.is_deal_stage(stage_id))';
    execute replace(v_source,v_old,v_new);
  end loop;

  foreach v_function in array array[
    'public.operational_decide_invoice(uuid,text,text)'::regprocedure,
    'public.operational_decide_unscheduled_invoice(uuid,text,text)'::regprocedure,
    'public.operational_review_invoice_tax(uuid)'::regprocedure,
    'public.operational_confirm_external_payment(uuid,text,text)'::regprocedure
  ] loop
    v_source := pg_get_functiondef(v_function);
    v_old := 'not exists(select 1 from public.profiles where id=auth.uid() and role in (''admin'',''super_admin'')';
    v_new := 'not exists(select 1 from public.profiles where id=auth.uid() and role::text in (''admin'',''super_admin'',''accounts'')';
    if position(v_old in v_source)=0 then raise exception 'Unexpected invoice authorization function %', v_function; end if;
    v_source := replace(v_source,v_old,v_new);
    if v_function='public.operational_decide_invoice(uuid,text,text)'::regprocedure then
      v_old := 'role=''super_admin''';
      if position(v_old in v_source)=0 then raise exception 'Unexpected discount approval function'; end if;
      v_source := replace(v_source,v_old,'role::text in (''super_admin'',''accounts'')');
    end if;
    execute v_source;
  end loop;
end $migration$;

commit;
