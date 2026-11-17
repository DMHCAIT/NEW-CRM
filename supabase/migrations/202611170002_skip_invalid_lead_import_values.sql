begin;

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

  perform set_config('crm.lead_bulk_import_user', auth.uid()::text, true);

  with candidates as materialized (
    select (source.ordinality - 1)::integer as row_index,
      gen_random_uuid() as id,
      source.value || jsonb_build_object(
        'country_code', case
          when coalesce(source.value->>'country_code', '') = '' or row_data.country_prefix <> ''
            then nullif(source.value->>'country_code', '')
          else null
        end,
        'note', case when length(row_data.note) <= 20000 then row_data.note else '' end
      ) as row_json,
      regexp_replace(row_data.phone, '[^0-9]', '', 'g') as phone,
      row_data.email,
      case when length(row_data.note) <= 20000 then row_data.note else '' end as note,
      row_data.assignee_id
    from jsonb_array_elements(rows_json) with ordinality as source(value, ordinality)
    cross join lateral (
      select
        public.combined_lead_phone(source.value->>'phone', source.value->>'country_code') as phone,
        lower(btrim(coalesce(source.value->>'email', ''))) as email,
        btrim(coalesce(source.value->>'note', '')) as note,
        case
          when source.value->>'assignee_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then (source.value->>'assignee_id')::uuid
          else null
        end as assignee_id,
        public.lead_country_calling_prefix(source.value->>'country_code') as country_prefix
    ) row_data
    where btrim(coalesce(source.value->>'name', '')) <> ''
      and regexp_replace(row_data.phone, '[^0-9]', '', 'g') ~ '^[0-9]{7,15}$'
      and row_data.phone ~ '^\+?[0-9\s().-]+$'
      and row_data.email <> ''
      and position('@' in row_data.email) > 0
      and length(row_data.email) <= 254
      and row_data.assignee_id is not null
      and exists (
        select 1 from public.profiles p
        where p.id = row_data.assignee_id and p.status = 'active' and p.deleted_at is null
      )
      and (row_data.assignee_id = auth.uid() or (
        public.has_permission('leads.assign')
        and (public.user_in_scope(row_data.assignee_id) or public.has_permission('users.view'))
      ))
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

revoke all on function public.import_live_leads(jsonb) from public;
grant execute on function public.import_live_leads(jsonb) to authenticated;

commit;
