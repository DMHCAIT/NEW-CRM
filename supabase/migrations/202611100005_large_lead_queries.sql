begin;

create extension if not exists pg_trgm;
set local search_path = public, extensions, pg_temp;

-- Match PostgreSQL's ISO UTC timestamp text without depending on session settings.
create function public.crm_lead_search_timestamp(value timestamptz)
returns text language sql immutable parallel safe set search_path = public, pg_temp as $$
  select case when value in ('infinity'::timestamptz,'-infinity'::timestamptz) then value::text
    else rtrim(rtrim(to_char(value at time zone 'UTC','YYYY-MM-DD HH24:MI:SS.US'),'0'),'.') || '+00' end;
$$;

create function public.crm_lead_search_text(name text,phone text,email text,country_code text,country text,
  course text,qualification text,category text,source text,id uuid,assignee_id uuid,stage_id uuid,
  closure_fee numeric,expected_closure_date date,billing_address text,custom_fields jsonb,
  created_at timestamptz,modified_at timestamptz,next_followup_at timestamptz,last_visit_at timestamptz)
returns text language sql immutable parallel safe set search_path = public, pg_temp as $$
  select lower(coalesce(name,'') || ' ' || coalesce(phone,'') || ' ' || coalesce(email,'') || ' ' ||
    coalesce(country_code,'') || ' ' || coalesce(country,'') || ' ' || coalesce(course,'') || ' ' ||
    coalesce(qualification,'') || ' ' || coalesce(category,'') || ' ' || coalesce(source,'') || ' ' ||
    coalesce(id::text,'') || ' ' || coalesce(assignee_id::text,'') || ' ' || coalesce(stage_id::text,'') || ' ' ||
    coalesce(closure_fee::text,'') || ' ' ||
    coalesce(extract(year from expected_closure_date)::integer::text || '-' ||
      lpad(extract(month from expected_closure_date)::integer::text,2,'0') || '-' ||
      lpad(extract(day from expected_closure_date)::integer::text,2,'0'),'') || ' ' ||
    coalesce(billing_address,'') || ' ' || coalesce(custom_fields::text,'') || ' ' ||
    coalesce(public.crm_lead_search_timestamp(created_at),'') || ' ' ||
    coalesce(public.crm_lead_search_timestamp(modified_at),'') || ' ' ||
    coalesce(public.crm_lead_search_timestamp(next_followup_at),'') || ' ' ||
    coalesce(public.crm_lead_search_timestamp(last_visit_at),''));
$$;

create index leads_active_search_idx on public.leads using gin (
  public.crm_lead_search_text(name,phone,email,country_code,country,course,qualification,category,source,
    id,assignee_id,stage_id,closure_fee,expected_closure_date,billing_address,custom_fields,
    created_at,modified_at,next_followup_at,last_visit_at) gin_trgm_ops
) where not is_archived;
create index leads_active_phone_search_idx on public.leads using gin (
  regexp_replace(phone,'[^0-9]','','g') gin_trgm_ops
) where not is_archived;

-- Only the page RPC can execute this private, quoted candidate-predicate builder.
create function public.crm_lead_search_candidate(search text)
returns text language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare search_clause text := ''; token_clause text; token text; matched_profiles uuid[]; matched_stages uuid[];
  phone_search text;
begin
  search := lower(trim(search));
  if search is null or length(search) not between 1 and 500 then raise exception 'Invalid lead search'; end if;
  -- Tokens are a superset, including phrases crossing nullable fields or reference
  -- labels. The original predicate below remains the final authority on matches.
  if current_setting('TimeZone') in ('UTC','Etc/UTC','GMT','Etc/GMT') and current_setting('DateStyle') like 'ISO,%' then
    for token in select regexp_split_to_table(search,'[[:space:]]+') loop
      select array_agg(p.id) into matched_profiles from public.profiles p
        where (p.id=auth.uid() or public.user_in_scope(p.id) or public.has_permission('users.view'))
          and strpos(lower(p.full_name),token)>0;
      select array_agg(s.id) into matched_stages from public.lead_stages s
        where (s.is_active or public.has_permission('settings.manage')) and strpos(lower(s.name),token)>0;
      token_clause := format(
        'public.crm_lead_search_text(l.name,l.phone,l.email,l.country_code,l.country,l.course,l.qualification,l.category,l.source,
          l.id,l.assignee_id,l.stage_id,l.closure_fee,l.expected_closure_date,l.billing_address,l.custom_fields,
          l.created_at,l.modified_at,l.next_followup_at,l.last_visit_at) like %L',
        '%' || replace(replace(replace(token,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%');
      if matched_profiles is not null then
        token_clause := token_clause || format(' or l.assignee_id = any(%L::uuid[]) or l.modified_by = any(%L::uuid[])',matched_profiles,matched_profiles);
      end if;
      if matched_stages is not null then token_clause := token_clause || format(' or l.stage_id = any(%L::uuid[])',matched_stages); end if;
      search_clause := search_clause || case when search_clause='' then '' else ' and ' end || '(' || token_clause || ')';
    end loop;
  else
    -- Preserve search behavior for callers using another timestamp representation.
    search_clause := 'true';
  end if;
  phone_search := regexp_replace(search,'[^0-9]','','g');
  if length(phone_search)>2 then
    search_clause := '(' || search_clause || ')' || format(' or regexp_replace(l.phone,''[^0-9]'','''',''g'') like %L','%' || phone_search || '%');
  end if;
  return search_clause;
end;
$$;
revoke all on function public.crm_lead_search_candidate(text) from public, anon, authenticated;

-- Resolve reference-table visibility once instead of repeating hierarchy checks per lead.
create or replace function public.crm_lead_page(filter_json jsonb, timezone_name text default 'UTC',
  page_size integer default 50, after_created timestamptz default null, after_id uuid default null,
  count_only boolean default false, owner_filter text default '', stage_filter text default '', sort_key text default 'newest',
  page_offset integer default 0, sort_cursor jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  predicate text;
  refs text := 'with stage_refs as materialized (select id,name,is_active from public.lead_stages
      where is_active or (select public.has_permission(''settings.manage''))),
    profile_refs as materialized (select id,full_name from public.profiles
      where id=auth.uid() or public.user_in_scope(id) or (select public.has_permission(''users.view''))) ';
  joins text := ' from public.leads l left join stage_refs s on s.id=l.stage_id
    left join profile_refs a on a.id=l.assignee_id left join profile_refs m on m.id=l.modified_by ';
  ids jsonb; records jsonb; total bigint; ordering text; search text;
begin
  if not public.is_verified_session() or not public.has_permission('leads.view') then
    raise exception 'Lead access required'; end if;
  if page_size not between 1 and 100 or page_offset not between 0 and 1000000 then raise exception 'Invalid page'; end if;
  if (after_created is null) <> (after_id is null) then raise exception 'Invalid cursor'; end if;
  search := lower(trim(coalesce(filter_json->>'query','')));
  if length(search)>500 then raise exception 'Invalid lead filter'; end if;
  predicate := public.crm_lead_predicate(filter_json,timezone_name) ||
    ' and ((select public.has_permission(''users.view'')) or l.assignee_id = any((select public.crm_scope_ids())::uuid[]))';
  if search <> '' then predicate := predicate || ' and (' || public.crm_lead_search_candidate(search) || ')'; end if;
  if owner_filter = '__unassigned' then predicate := predicate || ' and l.assignee_id is null';
  elsif owner_filter <> '' then predicate := predicate || format(' and l.assignee_id = %L::uuid',owner_filter); end if;
  if stage_filter = '__none' then predicate := predicate || ' and (l.stage_id is null or not coalesce(s.is_active,false))';
  elsif stage_filter <> '' then predicate := predicate || format(' and l.stage_id = %L::uuid',stage_filter); end if;
  if count_only then
    execute refs || 'select count(*)' || joins || ' where ' || predicate into total;
    return jsonb_build_object('total',total,'ids','[]'::jsonb,'hasMore',false);
  end if;
  if after_created is not null then
    if sort_key = 'name' then
      if jsonb_typeof(sort_cursor->'name') is distinct from 'string' then raise exception 'Invalid name cursor'; end if;
      predicate := predicate || format(' and (l.name,l.id) > (%L,%L::uuid)',sort_cursor->>'name',after_id);
    elsif sort_key = 'followUp' then
      if jsonb_typeof(sort_cursor->'name') is distinct from 'string' or not sort_cursor ? 'followUpAt' then raise exception 'Invalid follow-up cursor'; end if;
      if sort_cursor->>'followUpAt' is null then
        predicate := predicate || format(' and l.next_followup_at is null and (l.name,l.id) > (%L,%L::uuid)',sort_cursor->>'name',after_id);
      else
        predicate := predicate || format(' and (l.next_followup_at > %L::timestamptz or l.next_followup_at is null
          or (l.next_followup_at = %L::timestamptz and (l.name,l.id) > (%L,%L::uuid)))',
          sort_cursor->>'followUpAt',sort_cursor->>'followUpAt',sort_cursor->>'name',after_id);
      end if;
    else
      predicate := predicate || format(' and (l.created_at,l.id) < (%L::timestamptz,%L::uuid)',after_created,after_id);
    end if;
  end if;
  ordering := case sort_key when 'newest' then 'l.created_at desc,l.id desc'
    when 'name' then 'l.name,l.id' when 'followUp' then 'l.next_followup_at nulls last,l.name,l.id' else null end;
  if ordering is null then raise exception 'Invalid sort'; end if;
  execute refs || format('select coalesce(jsonb_agg(jsonb_build_object(''id'',id,''createdAt'',created_at,''name'',name,''followUpAt'',next_followup_at)),''[]''::jsonb)
    from (select l.id,l.created_at,l.name,l.next_followup_at %s where %s order by %s limit %s offset %s) page',
    joins,predicate,ordering,page_size+1,page_offset) into records;
  select coalesce(jsonb_agg(value->'id'),'[]'::jsonb) into ids from jsonb_array_elements(records - page_size);
  return jsonb_build_object('ids',ids,'hasMore',jsonb_array_length(records)>page_size,
    'nextCursor',case when jsonb_array_length(records)>page_size then records->(page_size-1) else null end);
end;
$$;

-- Aggregate leads before joining stages; the result remains exact and RLS-scoped.
create or replace function public.crm_dashboard_summary()
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
begin
  if not public.is_verified_session() or not public.has_permission('dashboard.view') then raise exception 'Dashboard access required'; end if;
  return (with scoped as not materialized (
    select l.country,l.course,l.stage_id,l.created_at,l.next_followup_at
    from public.leads l
    where not l.is_archived and (select public.has_permission('dashboard.view'))
      and ((select public.is_crm_admin()) or l.assignee_id = any((select public.crm_dashboard_scope_ids())::uuid[]))
  ), raw_groups as (
    select lower(trim(coalesce(country,''))) country_key, lower(trim(coalesce(course,''))) course_key,
      min(trim(coalesce(country,''))) country, min(trim(coalesce(course,''))) course,stage_id,
      count(*) total,
      count(*) filter(where created_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
        and created_at < (date_trunc('day',now() at time zone 'UTC') + interval '1 day') at time zone 'UTC') new_today,
      count(*) filter(where next_followup_at < date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') overdue,
      count(*) filter(where next_followup_at >= date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'
        and next_followup_at < (date_trunc('day',now() at time zone 'UTC') + interval '1 day') at time zone 'UTC') due_today
    from scoped group by 1,2,stage_id
  ), groups as materialized (
    select r.*,coalesce(s.name,'') stage_name,coalesce(s.is_terminal,false) terminal,
      case when lower(trim(coalesce(s.name,''))) in ('closed won','already enrolled') then r.total else 0 end converted
    from raw_groups r left join public.lead_stages s on s.id=r.stage_id
  )
  select jsonb_build_object(
    'total',coalesce(sum(total),0),'newToday',coalesce(sum(new_today),0),'converted',coalesce(sum(converted),0),
    'overdue',coalesce(sum(overdue) filter(where not terminal),0),'dueToday',coalesce(sum(due_today) filter(where not terminal),0),
    'daily',coalesce((select jsonb_object_agg(day_key,total) from (
      select (created_at at time zone 'UTC')::date day_key,count(*) total from scoped
      where created_at >= (date_trunc('day',now() at time zone 'UTC') - interval '6 days') at time zone 'UTC'
        and created_at < (date_trunc('day',now() at time zone 'UTC') + interval '1 day') at time zone 'UTC'
      group by 1) d),'{}'::jsonb),
    'stages',coalesce((select jsonb_agg(g) from (
      select stage_id,stage_name,sum(total) total from groups group by stage_id,stage_name) g),'[]'::jsonb),
    'country',coalesce((select jsonb_agg(g) from (
      select min(country) name,sum(total) total,sum(converted) converted,jsonb_object_agg(stage_name,stage_total) stages
      from (select country_key,min(country) country,stage_name,sum(total) stage_total,sum(total) total,sum(converted) converted
        from groups group by country_key,stage_name) c
      group by country_key order by sum(total) desc,country_key limit 30) g),'[]'::jsonb),
    'course',coalesce((select jsonb_agg(g) from (
      select min(course) name,sum(total) total,sum(converted) converted,jsonb_object_agg(stage_name,stage_total) stages
      from (select course_key,min(course) course,stage_name,sum(total) stage_total,sum(total) total,sum(converted) converted
        from groups group by course_key,stage_name) c
      group by course_key order by sum(total) desc,course_key limit 30) g),'[]'::jsonb),
    'countryLeaders',coalesce((select jsonb_agg(g) from (
      select min(country) name,sum(total) total,sum(converted) converted,'{}'::jsonb stages
      from groups group by country_key having sum(converted)>0
      order by sum(converted)::numeric/sum(total) desc,sum(converted) desc,country_key limit 8) g),'[]'::jsonb),
    'courseLeaders',coalesce((select jsonb_agg(g) from (
      select min(course) name,sum(total) total,sum(converted) converted,'{}'::jsonb stages
      from groups group by course_key having sum(converted)>0
      order by sum(converted)::numeric/sum(total) desc,sum(converted) desc,course_key limit 8) g),'[]'::jsonb),
    'combinations',coalesce((select jsonb_agg(g) from (
      select min(country) country,min(course) course,sum(total) total,sum(converted) converted,
        sum(converted)::numeric / sum(total) * 100 rate
      from groups group by country_key,course_key
      order by sum(converted)::numeric / sum(total) desc,sum(converted) desc,sum(total) desc,country_key,course_key limit 30) g),'[]'::jsonb)
  ) from groups);
end;
$$;

commit;
