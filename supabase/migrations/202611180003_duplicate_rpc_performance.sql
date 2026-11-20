begin;

create index if not exists leads_normalized_phone_idx on public.leads(normalized_phone);
create index if not exists leads_normalized_email_idx on public.leads(normalized_email) where normalized_email is not null;
create index if not exists leads_assignee_id_idx on public.leads(assignee_id);

create or replace function public.check_live_lead_duplicates(rows_json jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare config jsonb; match_fields text; policy text; duplicate_found boolean;
begin
  if not public.is_verified_session() or not public.has_permission('leads.create') then
    raise exception 'Lead creation permission required';
  end if;
  if jsonb_typeof(rows_json) is distinct from 'array' or jsonb_array_length(rows_json) not between 1 and 1000 then
    raise exception 'Check between 1 and 1000 leads';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm.live-lead-creation', 0));
  select value into config from public.crm_settings where setting_key = 'lead_configuration';
  match_fields := coalesce(config->>'duplicateFields','phone_email');
  policy := coalesce(config->>'creationPolicy','block');
  if policy = 'allow' then return 'clear'; end if;

  with candidates as (
    select
      nullif(regexp_replace(public.combined_lead_phone(
        coalesce(value->>'phone', value->>'normalized_phone'), value->>'country_code'
      ), '[^0-9]', '', 'g'), '') as phone,
      nullif(lower(trim(coalesce(value->>'normalized_email', value->>'email', ''))), '') as email
    from jsonb_array_elements(rows_json)
  )
  select exists (
    select 1
    from public.leads l
    join candidates c on
      (match_fields in ('phone_email','phone') and c.phone is not null and l.normalized_phone = c.phone)
      or (match_fields in ('phone_email','email') and c.email is not null
        and lower(trim(coalesce(nullif(l.normalized_email,''), l.email,''))) = c.email)
    union all
    select 1 from candidates where match_fields in ('phone_email','phone') and phone is not null group by phone having count(*) > 1
    union all
    select 1 from candidates where match_fields in ('phone_email','email') and email is not null group by email having count(*) > 1
  ) into duplicate_found;
  if not duplicate_found then return 'clear'; end if;
  if policy = 'warn' and public.is_crm_admin() then return 'warn'; end if;
  return 'block';
end $$;
revoke all on function public.check_live_lead_duplicates(jsonb) from public, anon;
grant execute on function public.check_live_lead_duplicates(jsonb) to authenticated;

create or replace function public.lead_duplicate_owners(lead_id uuid)
returns table(assignee text, merge_target_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare current_lead public.leads;
begin
  if not public.is_verified_session() or not public.has_permission('leads.view') then
    raise exception 'Lead view permission required';
  end if;
  select * into current_lead from public.leads l where l.id = lead_id
    and not l.is_archived and l.merged_into_id is null
    and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view'));
  if current_lead.id is null then raise exception 'Lead not found within your accessible scope'; end if;
  return query
    select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), ''), 'Unassigned'),
      case when public.has_permission('leads.merge')
        and public.lead_merge_in_bucket(current_lead.assignee_id)
        and public.lead_merge_in_bucket(l.assignee_id) then l.id else null end
    from public.leads l
    left join public.profiles p on p.id = l.assignee_id
    where l.id <> current_lead.id
      and not l.is_archived
      and l.merged_into_id is null
      and (
        (nullif(current_lead.normalized_phone,'') is not null
          and l.normalized_phone = current_lead.normalized_phone)
        or (nullif(current_lead.normalized_email,'') is not null
          and l.normalized_email = current_lead.normalized_email)
      )
    order by p.full_name nulls last, l.id;
end;
$$;
revoke all on function public.lead_duplicate_owners(uuid) from public, anon;
grant execute on function public.lead_duplicate_owners(uuid) to authenticated;

commit;
