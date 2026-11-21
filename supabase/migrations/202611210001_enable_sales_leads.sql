begin;

create table public.lead_enable_operations (
  lead_id uuid primary key,
  stage_id uuid not null,
  actor_id uuid not null,
  transaction_id bigint not null
);
alter table public.lead_enable_operations enable row level security;
revoke all on public.lead_enable_operations from public, anon, authenticated;

-- Only this transaction's authorized enable operation can skip stage assignment.
do $migration$
declare
  v_source text := pg_get_functiondef('public.automatic_stage_lead_assignment()'::regprocedure);
  v_old text := 'if new.is_archived then return new; end if;';
  v_new text := 'if new.is_archived then return new; end if;
    delete from public.lead_enable_operations
      where lead_id = new.id and stage_id = new.stage_id and actor_id = auth.uid()
        and transaction_id = txid_current();
    if found then return new; end if;';
begin
  if position(v_old in v_source) = 0 then
    raise exception 'Unexpected stage assignment function; reconcile migration before applying';
  end if;
  execute replace(v_source, v_old, v_new);
end $migration$;

create or replace function public.find_live_lead_duplicates(check_phone text, check_email text, check_country_code text default '')
returns table(match_field text, lead_id uuid, lead_name text, assignee text, in_bucket boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare match_fields text; p text; e text;
begin
  if not public.is_verified_session() or not public.has_permission('leads.create') then
    raise exception 'Lead creation permission required';
  end if;
  select value->>'duplicateFields' into match_fields
    from public.crm_settings where setting_key = 'lead_configuration';
  match_fields := coalesce(match_fields, 'phone_email');
  p := nullif(regexp_replace(coalesce(check_phone, ''), '[^0-9]', '', 'g'), '');
  e := nullif(lower(trim(coalesce(check_email, ''))), '');
  return query
    select
      case when match_fields in ('phone_email','phone') and p is not null
        and l.normalized_phone = p then 'phone' else 'email' end,
      case when b.ok or (
        not b.ok and not l.is_archived and l.merged_into_id is null
        and lower(btrim(pr.full_name)) = 'dmhca sales'
        and exists (select 1 from public.profiles actor where actor.id = auth.uid()
          and actor.role = 'team_lead' and actor.status = 'active' and actor.deleted_at is null)
        and public.has_permission('leads.view') and public.has_permission('leads.edit')
        and public.has_permission('leads.assign')
      ) then l.id end,
      case when b.ok then l.name end,
      coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(pr.email), ''), 'Unassigned'),
      b.ok
    from public.leads l
    left join public.profiles pr on pr.id = l.assignee_id
    cross join lateral (
      select coalesce(public.has_permission('leads.view') and (
        l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view')
      ), false) as ok
    ) b
    where
      (match_fields in ('phone_email','phone') and p is not null and l.normalized_phone = p)
      or (match_fields in ('phone_email','email') and e is not null
        and lower(trim(coalesce(nullif(l.normalized_email,''), l.email,''))) = e)
    order by b.ok desc, l.created_at desc
    limit 5;
end $$;

create function public.enable_sales_lead(p_lead_id uuid, p_stage_id uuid, p_phone text, p_email text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
  v_match_fields text;
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
begin
  if not public.is_verified_session()
    or not public.has_permission('leads.create') or not public.has_permission('leads.view')
    or not public.has_permission('leads.edit') or not public.has_permission('leads.assign')
    or not exists (select 1 from public.profiles where id = auth.uid()
      and role = 'team_lead' and status = 'active' and deleted_at is null) then
    raise exception 'Active team lead with lead permissions required';
  end if;
  if not exists (select 1 from public.lead_stages where id = p_stage_id and is_active) then
    raise exception 'Choose an active CRM stage';
  end if;
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or v_lead.is_archived or v_lead.merged_into_id is not null
    or not exists (select 1 from public.profiles where id = v_lead.assignee_id and lower(btrim(full_name)) = 'dmhca sales')
    or v_lead.assignee_id = auth.uid() or public.user_in_scope(v_lead.assignee_id)
    or public.has_permission('users.view') then
    raise exception 'Lead is no longer available to enable';
  end if;
  select coalesce(value->>'duplicateFields', 'phone_email') into v_match_fields
    from public.crm_settings where setting_key = 'lead_configuration';
  v_match_fields := coalesce(v_match_fields, 'phone_email');
  if not coalesce(
    (v_match_fields in ('phone_email','phone') and length(v_phone) between 7 and 15 and v_lead.normalized_phone = v_phone)
    or (v_match_fields in ('phone_email','email') and v_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and lower(trim(coalesce(nullif(v_lead.normalized_email,''), v_lead.email,''))) = v_email), false) then
    raise exception 'Lead no longer matches the supplied contact details';
  end if;
  insert into public.lead_enable_operations values (p_lead_id, p_stage_id, auth.uid(), txid_current());
  update public.leads set stage_id = p_stage_id, assignee_id = auth.uid(), modified_by = auth.uid()
    where id = p_lead_id;
  delete from public.lead_enable_operations where lead_id = p_lead_id and transaction_id = txid_current();
  return p_lead_id;
end $$;
revoke all on function public.enable_sales_lead(uuid,uuid,text,text) from public, anon;
grant execute on function public.enable_sales_lead(uuid,uuid,text,text) to authenticated;

commit;
