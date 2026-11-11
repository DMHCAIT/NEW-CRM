begin;

create or replace function public.guard_live_lead_changes()
returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and new.merged_into_id is distinct from old.merged_into_id then
    if current_user = (select pg_get_userbyid(relowner) from pg_class where oid = 'public.leads'::regclass)
      and public.is_verified_session() and public.has_permission('leads.merge')
      and old.merged_into_id is null and not old.is_archived and new.is_archived and new.merged_into_id <> old.id
      and (to_jsonb(new) - array['merged_into_id','is_archived','modified_by']) =
          (to_jsonb(old) - array['merged_into_id','is_archived','modified_by'])
    then return new; end if;
    raise exception 'Use the authorized lead merge operation';
  end if;
  if tg_op = 'INSERT' and new.merged_into_id is not null then raise exception 'Cannot create an already merged lead'; end if;
  new.normalized_phone := regexp_replace(new.phone, '[^0-9]', '', 'g');
  new.normalized_email := nullif(lower(trim(new.email)), '');
  if tg_op = 'UPDATE' then
    if not public.has_permission('leads.edit') and not (
      public.has_permission('leads.delete') and new.is_archived and
      (to_jsonb(new) - array['is_archived','modified_by']) = (to_jsonb(old) - array['is_archived','modified_by'])
    ) then raise exception 'Lead edit permission required'; end if;
    if new.assignee_id is distinct from old.assignee_id and not public.has_permission('leads.assign') then
      raise exception 'Assignment permission required';
    end if;
    if new.is_archived is distinct from old.is_archived and not public.has_permission('leads.delete') then
      raise exception 'Delete permission required';
    end if;
    if new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'Lead creation metadata is immutable';
    end if;
  elsif new.assignee_id is distinct from auth.uid() and not public.has_permission('leads.assign') then
    raise exception 'Assignment permission required';
  end if;
  if (tg_op = 'INSERT' or new.assignee_id is distinct from old.assignee_id) and new.assignee_id is not null and not exists (
    select 1 from public.profiles where id = new.assignee_id and status = 'active' and deleted_at is null
  ) then raise exception 'Assignee must be an active accessible user'; end if;
  if (tg_op = 'INSERT' or new.stage_id is distinct from old.stage_id) and new.stage_id is not null and not exists (
    select 1 from public.lead_stages where id = new.stage_id and is_active
  ) then raise exception 'Stage must be active'; end if;
  if tg_op = 'INSERT' and not (
    coalesce(current_setting('crm.lead_bulk_import_user', true), '') = auth.uid()::text
    and public.is_verified_session()
    and public.has_permission('leads.import')
  ) then
    if public.check_live_lead_duplicates(jsonb_build_array(jsonb_build_object(
      'normalized_phone',new.normalized_phone,'normalized_email',new.normalized_email))) = 'block' then
      raise exception 'Duplicate lead blocked by CRM configuration';
    end if;
  end if;
  return new;
end $$;

create or replace function public.find_live_lead_import_duplicates(rows_json jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare duplicates jsonb;
begin
  if not public.is_verified_session() or not public.has_permission('leads.import') or not public.has_permission('leads.create') then
    raise exception 'Import permission required';
  end if;
  if jsonb_typeof(rows_json) is distinct from 'array' or jsonb_array_length(rows_json) not between 1 and 200000 then
    raise exception 'Check between 1 and 200000 leads';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm.live-lead-creation', 0));
  with candidates as materialized (
    select (source.ordinality - 1)::integer as row_index,
      regexp_replace(public.combined_lead_phone(source.value->>'phone', source.value->>'country_code'), '[^0-9]', '', 'g') as phone,
      lower(btrim(coalesce(source.value->>'email', ''))) as email,
      source.value->>'country_code' as country_code
    from jsonb_array_elements(rows_json) with ordinality as source(value, ordinality)
  ), repeated as (
    select row_index
    from (
      select row_index,
        row_number() over (partition by phone order by row_index) as phone_rank,
        row_number() over (partition by email order by row_index) as email_rank
      from candidates
    ) ranked
    where phone_rank > 1 or email_rank > 1
  ), matched as (
    select c.row_index
    from candidates c
    where exists (
      select 1 from public.leads l
      where l.normalized_phone = c.phone
        or l.normalized_email = c.email
        or (coalesce(l.country_code,'') = ''
          and public.lead_country_calling_prefix(c.country_code) <> ''
          and l.normalized_phone = substring(c.phone from length(public.lead_country_calling_prefix(c.country_code)) + 1))
        or (coalesce(c.country_code,'') = ''
          and public.lead_country_calling_prefix(l.country_code) <> ''
          and c.phone = substring(l.normalized_phone from length(public.lead_country_calling_prefix(l.country_code)) + 1))
    )
  )
  select coalesce(jsonb_agg(row_index order by row_index), '[]'::jsonb)
    into duplicates
  from (select row_index from repeated union select row_index from matched) duplicate_rows;
  return duplicates;
end $$;

create or replace function public.import_live_leads(rows_json jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare total_rows integer; imported_rows integer; previous_import_context text;
begin
  if not public.is_verified_session() or not public.has_permission('leads.import') or not public.has_permission('leads.create') then
    raise exception 'Import permission required';
  end if;
  if jsonb_typeof(rows_json) is distinct from 'array' or jsonb_array_length(rows_json) not between 1 and 200000 then
    raise exception 'Import between 1 and 200000 rows';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm.live-lead-creation', 0));
  total_rows := jsonb_array_length(rows_json);
  previous_import_context := coalesce(current_setting('crm.lead_bulk_import_user', true), '');

  if exists (
    select 1
    from jsonb_array_elements(rows_json) as source(value)
    cross join lateral (
      select
        public.combined_lead_phone(source.value->>'phone', source.value->>'country_code') as phone,
        regexp_replace(public.combined_lead_phone(source.value->>'phone', source.value->>'country_code'), '[^0-9]', '', 'g') as normalized_phone,
        lower(btrim(coalesce(source.value->>'email', ''))) as email,
        nullif(source.value->>'assignee_id', '')::uuid as assignee_id,
        btrim(coalesce(source.value->>'note', '')) as note,
        public.lead_country_calling_prefix(source.value->>'country_code') as country_prefix
    ) row_data
    where btrim(coalesce(source.value->>'name', '')) = ''
      or row_data.normalized_phone !~ '^[0-9]{7,15}$'
      or row_data.phone !~ '^\+?[0-9\s().-]+$'
      or row_data.email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or length(row_data.email) > 254
      or (coalesce(source.value->>'country_code', '') <> '' and row_data.country_prefix = '')
      or length(row_data.note) > 10000
      or row_data.assignee_id is null
      or not exists (
        select 1 from public.profiles p
        where p.id = row_data.assignee_id and p.status = 'active' and p.deleted_at is null
      )
      or (row_data.assignee_id <> auth.uid() and (
        not public.has_permission('leads.assign')
        or (not public.user_in_scope(row_data.assignee_id) and not public.has_permission('users.view'))
      ))
  ) then
    raise exception 'Import contains invalid lead fields or an inaccessible assignee';
  end if;

  perform set_config('crm.lead_bulk_import_user', auth.uid()::text, true);

  with candidates as materialized (
    select (source.ordinality - 1)::integer as row_index,
      gen_random_uuid() as id,
      source.value as row_json,
      regexp_replace(public.combined_lead_phone(source.value->>'phone', source.value->>'country_code'), '[^0-9]', '', 'g') as phone,
      lower(btrim(coalesce(source.value->>'email', ''))) as email,
      btrim(coalesce(source.value->>'note', '')) as note,
      nullif(source.value->>'assignee_id', '')::uuid as assignee_id
    from jsonb_array_elements(rows_json) with ordinality as source(value, ordinality)
  ), ranked as materialized (
    select candidates.*,
      row_number() over (partition by phone order by row_index) as phone_rank,
      row_number() over (partition by email order by row_index) as email_rank
    from candidates
  ), eligible as materialized (
    select ranked.*
    from ranked
    where phone_rank = 1 and email_rank = 1
      and not exists (
        select 1 from public.leads l
        where l.normalized_phone = ranked.phone
          or l.normalized_email = ranked.email
          or (coalesce(l.country_code,'') = ''
            and public.lead_country_calling_prefix(ranked.row_json->>'country_code') <> ''
            and l.normalized_phone = substring(ranked.phone from length(public.lead_country_calling_prefix(ranked.row_json->>'country_code')) + 1))
          or (coalesce(ranked.row_json->>'country_code','') = ''
            and public.lead_country_calling_prefix(l.country_code) <> ''
            and ranked.phone = substring(l.normalized_phone from length(public.lead_country_calling_prefix(l.country_code)) + 1))
      )
  ), inserted as (
    insert into public.leads(
      id,name,phone,normalized_phone,country_code,alt_phone,email,normalized_email,country,billing_address,course,
      qualification,speciality,category,source,stage_id,assignee_id,created_by,modified_by,next_followup_at,
      closure_fee,expected_closure_date,custom_fields
    )
    select e.id,e.row_json->>'name',e.row_json->>'phone',e.phone,e.row_json->>'country_code',
      e.row_json->>'alt_phone',e.row_json->>'email',e.email,e.row_json->>'country',
      coalesce(e.row_json->>'billing_address',''),e.row_json->>'course',e.row_json->>'qualification',
      nullif(btrim(e.row_json->>'speciality'),''),e.row_json->>'category',coalesce(e.row_json->>'source','import'),
      nullif(e.row_json->>'stage_id','')::uuid,e.assignee_id,auth.uid(),auth.uid(),
      nullif(e.row_json->>'next_followup_at','')::timestamptz,coalesce(nullif(e.row_json->>'closure_fee','')::numeric,0),
      nullif(e.row_json->>'expected_closure_date','')::date,coalesce(e.row_json->'custom_fields','{}'::jsonb)
    from eligible e
    order by e.row_index
    returning id
  ), inserted_notes as (
    insert into public.notes(lead_id,user_id,content)
    select e.id,auth.uid(),e.note
    from eligible e join inserted i on i.id = e.id
    where e.note <> ''
    returning lead_id
  )
  select count(*) into imported_rows from inserted;

  perform set_config('crm.lead_bulk_import_user', previous_import_context, true);
  return jsonb_build_object('imported', imported_rows, 'skipped', total_rows - imported_rows);
end $$;

revoke all on function public.find_live_lead_import_duplicates(jsonb) from public, anon;
grant execute on function public.find_live_lead_import_duplicates(jsonb) to authenticated;
revoke all on function public.import_live_leads(jsonb) from public;
grant execute on function public.import_live_leads(jsonb) to authenticated;

commit;
