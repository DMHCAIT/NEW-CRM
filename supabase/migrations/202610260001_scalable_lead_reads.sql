begin;

create index leads_created_id_idx on public.leads (created_at desc, id desc);
drop index public.leads_created_idx;
create index leads_active_owner_created_id_idx on public.leads (assignee_id, created_at desc, id desc) where not is_archived;
create index leads_active_stage_created_id_idx on public.leads (stage_id, created_at desc, id desc) where not is_archived;
create index leads_active_course_idx on public.leads (lower(trim(coalesce(course,''))), created_at desc, id desc) where not is_archived;
create index leads_active_country_idx on public.leads (lower(trim(coalesce(country,''))), created_at desc, id desc) where not is_archived;
create index leads_active_name_id_idx on public.leads (name, id) where not is_archived;
create index leads_active_followup_name_id_idx on public.leads (next_followup_at, name, id) where not is_archived;
create index profiles_reporting_to_idx on public.profiles (reporting_to) where status = 'active';
create index notes_lead_created_idx on public.notes (lead_id, created_at desc);
create index emails_lead_created_idx on public.emails (lead_id, created_at desc);

-- Evaluate the hierarchy once per statement rather than recursively for every lead.
create function public.crm_scope_ids()
returns uuid[] language sql stable security definer set search_path = public, pg_temp as $$
  with recursive downline(id) as (
    select auth.uid()
    union
    select p.id from public.profiles p join downline d on p.reporting_to = d.id where p.status = 'active'
  ) select array_agg(id) from downline;
$$;
revoke all on function public.crm_scope_ids() from public, anon;
grant execute on function public.crm_scope_ids() to authenticated;

alter policy "Read leads within hierarchy" on public.leads using (
  (select public.has_permission('leads.view')) and
  ((select public.has_permission('users.view')) or assignee_id = any((select public.crm_scope_ids())::uuid[]))
);
alter policy "Update leads within hierarchy" on public.leads using (
  (select public.has_permission('leads.edit')) and
  ((select public.has_permission('users.view')) or assignee_id = any((select public.crm_scope_ids())::uuid[]))
) with check (
  (select public.has_permission('leads.edit')) and
  ((select public.has_permission('users.view')) or assignee_id = any((select public.crm_scope_ids())::uuid[]))
);
alter policy "Archive leads within hierarchy" on public.leads using (
  (select public.has_permission('leads.delete')) and
  ((select public.has_permission('users.view')) or assignee_id = any((select public.crm_scope_ids())::uuid[]))
) with check (
  (select public.has_permission('leads.delete')) and
  ((select public.has_permission('users.view')) or assignee_id = any((select public.crm_scope_ids())::uuid[]))
);
alter policy "Require verified CRM session" on public.leads
using ((select public.is_verified_session())) with check ((select public.is_verified_session()));

-- Only whitelisted expressions/operators and quoted literals enter dynamic SQL.
create function public.crm_lead_predicate(filter_json jsonb, timezone_name text default 'UTC')
returns text language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  c jsonb; field text; op text; expr text; raw_expr text; v text; v2 text; part text;
  parts text[] := '{}'; result text := 'not l.is_archived'; values_sql text; start_sql text; end_sql text;
begin
  if not exists (select 1 from pg_timezone_names where name = timezone_name) then raise exception 'Invalid time zone'; end if;
  if jsonb_typeof(filter_json->'criteria') is distinct from 'array'
    or jsonb_array_length(filter_json->'criteria') > 100
    or filter_json->>'matchMode' not in ('all','any')
    or length(coalesce(filter_json->>'query','')) > 500 then raise exception 'Invalid lead filter'; end if;
  for c in select value from jsonb_array_elements(filter_json->'criteria') loop
    field := c->>'field'; op := c->>'operator'; v := trim(coalesce(c->>'value','')); v2 := c->>'secondValue';
    raw_expr := case field
      when 'name' then 'l.name' when 'phone' then 'l.phone' when 'email' then 'l.email'
      when 'countryCode' then 'l.country_code' when 'country' then 'l.country' when 'course' then 'l.course'
      when 'qualification' then 'l.qualification' when 'category' then 'l.category' when 'source' then 'l.source'
      when 'stage' then 's.name' when 'assignee' then 'a.full_name' when 'modifiedBy' then 'm.full_name'
      when 'createdAt' then 'l.created_at' when 'modifiedAt' then 'l.modified_at'
      when 'followUpAt' then 'l.next_followup_at' when 'lastVisitAt' then 'l.last_visit_at'
      when 'untouched' then 'l.has_been_edited' else null end;
    if raw_expr is null or length(v) > 10000 then raise exception 'Invalid filter field or value'; end if;
    if field = 'untouched' then
      if op in ('is_true','is_false') then
        part := format('l.has_been_edited = %L::boolean', op = 'is_false');
      elsif op in ('is','custom_date','before','after','between') then
        expr := format('(e at time zone %L)::date', timezone_name);
        part := case op
          when 'before' then format('%s < %L::date', expr, v)
          when 'after' then format('%s > %L::date', expr, v)
          else format('%s between %L::date and %L::date', expr, v, case when op = 'between' then v2 else v end) end;
        part := format('((l.created_at at time zone %L)::date %s %L::date and not exists
          (select 1 from unnest(case when cardinality(l.edited_at)>0 then l.edited_at
            when not l.has_been_edited then ''{}''::timestamptz[] else array[l.modified_at] end) e where %s))', timezone_name,
          case when op = 'before' then '<' else '<=' end, v, part);
        if op = 'before' then
          part := part || ' and (coalesce(cardinality(l.edited_at),0)>0 or not l.has_been_edited)';
        elsif op in ('is','custom_date','between') then
          part := part || format(' and (coalesce(cardinality(l.edited_at),0)>0 or not l.has_been_edited or (l.modified_at at time zone %L)::date < %L::date)',timezone_name,v);
        end if;
      else raise exception 'Invalid untouched operator'; end if;
    elsif field in ('createdAt','modifiedAt','followUpAt','lastVisitAt') then
      start_sql := format('(%L::date::timestamp at time zone %L)',v,timezone_name);
      end_sql := format('((%L::date + 1)::timestamp at time zone %L)',case when op in ('between','not_between') then v2 else v end,timezone_name);
      part := case op
        when 'is_empty' then raw_expr || ' is null'
        when 'is_not_empty' then raw_expr || ' is not null'
        when 'is' then format('(%s >= %s and %s < %s)',raw_expr,start_sql,raw_expr,end_sql)
        when 'custom_date' then format('(%s >= %s and %s < %s)',raw_expr,start_sql,raw_expr,end_sql)
        when 'is_not' then format('(%s < %s or %s >= %s)',raw_expr,start_sql,raw_expr,end_sql)
        when 'before' then format('%s < %s',raw_expr,start_sql)
        when 'after' then format('%s >= %s',raw_expr,end_sql)
        when 'on_or_before' then format('%s < %s',raw_expr,end_sql)
        when 'on_or_after' then format('%s >= %s',raw_expr,start_sql)
        when 'between' then format('(%s >= %s and %s < %s)',raw_expr,start_sql,raw_expr,end_sql)
        when 'not_between' then format('(%s < %s or %s >= %s)',raw_expr,start_sql,raw_expr,end_sql)
        else null end;
      if part is null then raise exception 'Invalid date operator'; end if;
      if field = 'lastVisitAt' then
        part := format('(lower(trim(l.source)) in (''website'',''website form'',''web form'',''website lead'',''landing page'') and l.last_visit_at is not null and (%s))',part);
      end if;
    else
      expr := case when field = 'phone' then 'regexp_replace(l.phone,''[^0-9]'','''',''g'')'
        else format('lower(trim(coalesce(%s,'''')))',raw_expr) end;
      if field = 'phone' and op not in ('is_empty','is_not_empty') then v := regexp_replace(v,'[^0-9]','','g');
      else v := lower(v); end if;
      if op in ('in','not_in') then
        select string_agg(quote_literal(lower(trim(x))),',') into values_sql from unnest(string_to_array(c->>'value',E'\n')) x;
        part := format('%s %s (%s)',expr,case when op = 'in' then 'in' else 'not in' end,coalesce(values_sql,quote_literal('')));
      else
        part := case op
          when 'is' then format('%s = %L',expr,v)
          when 'is_not' then format('%s <> %L',expr,v)
          when 'contains' then format('strpos(%s,%L) > 0',expr,v)
          when 'not_contains' then format('strpos(%s,%L) = 0',expr,v)
          when 'begins_with' then format('left(%s,%s) = %L',expr,length(v),v)
          when 'ends_with' then format('right(%s,%s) = %L',expr,length(v),v)
          when 'is_empty' then format('trim(coalesce(%s,'''')) = ''''',raw_expr)
          when 'is_not_empty' then format('trim(coalesce(%s,'''')) <> ''''',raw_expr)
          else null end;
      end if;
      if part is null then raise exception 'Invalid text operator'; end if;
    end if;
    parts := array_append(parts,'(' || part || ')');
  end loop;
  if cardinality(parts) > 0 then
    result := result || ' and (' || array_to_string(parts,case when filter_json->>'matchMode' = 'any' then ' or ' else ' and ' end) || ')';
  end if;
  if filter_json->>'quickView' = 'My Leads' then result := result || ' and l.assignee_id = (select auth.uid())'; end if;
  if coalesce((filter_json->>'dashboard')::boolean,false) then
    result := result || ' and ((select public.is_crm_admin()) or l.assignee_id = any((select public.crm_dashboard_scope_ids())::uuid[]))';
  end if;
  v := lower(trim(coalesce(filter_json->>'query','')));
  if v <> '' then
    result := result || format(' and (strpos(lower(concat_ws('' '',l.name,l.phone,l.email,l.country_code,l.country,l.course,l.qualification,l.category,l.source,s.name,a.full_name,m.full_name,l.id,l.assignee_id,l.stage_id,l.created_at,l.modified_at,l.next_followup_at,l.last_visit_at,l.closure_fee)),%L)>0',v);
    v2 := regexp_replace(v,'[^0-9]','','g');
    if length(v2) > 2 then result := result || format(' or strpos(regexp_replace(l.phone,''[^0-9]'','''',''g''),%L)>0',v2); end if;
    result := result || ')';
  end if;
  return result;
end;
$$;

create function public.crm_dashboard_scope_ids()
returns uuid[] language sql stable security definer set search_path = public, pg_temp as $$
  with recursive downline(id) as (
    select auth.uid()
    union
    select p.id from public.profiles p join downline d on p.reporting_to = d.id
      where p.status = 'active' and p.deleted_at is null
      and exists (select 1 from public.profiles me where me.id = auth.uid() and me.role <> 'counselor')
  ) select array_agg(id) from downline;
$$;

create function public.crm_lead_page(filter_json jsonb, timezone_name text default 'UTC',
  page_size integer default 50, after_created timestamptz default null, after_id uuid default null,
  count_only boolean default false, owner_filter text default '', stage_filter text default '', sort_key text default 'newest',
  page_offset integer default 0, sort_cursor jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare predicate text; joins text := ' from public.leads l left join public.lead_stages s on s.id=l.stage_id
  left join public.profiles a on a.id=l.assignee_id left join public.profiles m on m.id=l.modified_by ';
  ids jsonb; records jsonb; total bigint; ordering text;
begin
  if not public.is_verified_session() or not (public.has_permission('leads.view') or public.has_permission('pipeline.view') or public.has_permission('reports.view')) then
    raise exception 'Lead access required'; end if;
  if page_size not between 1 and 100 or page_offset not between 0 and 1000000 then raise exception 'Invalid page'; end if;
  if (after_created is null) <> (after_id is null) then raise exception 'Invalid cursor'; end if;
  predicate := public.crm_lead_predicate(filter_json,timezone_name);
  if owner_filter = '__unassigned' then predicate := predicate || ' and l.assignee_id is null';
  elsif owner_filter <> '' then predicate := predicate || format(' and l.assignee_id = %L::uuid',owner_filter); end if;
  if stage_filter = '__none' then predicate := predicate || ' and (l.stage_id is null or not coalesce(s.is_active,false))';
  elsif stage_filter <> '' then predicate := predicate || format(' and l.stage_id = %L::uuid',stage_filter); end if;
  if count_only then
    execute 'select count(*)' || joins || ' where ' || predicate into total;
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
  execute format('select coalesce(jsonb_agg(jsonb_build_object(''id'',id,''createdAt'',created_at,''name'',name,''followUpAt'',next_followup_at)),''[]''::jsonb)
    from (select l.id,l.created_at,l.name,l.next_followup_at %s where %s order by %s limit %s offset %s) page',
    joins,predicate,ordering,page_size+1,page_offset) into records;
  select coalesce(jsonb_agg(value->'id'),'[]'::jsonb) into ids from jsonb_array_elements(records - page_size);
  return jsonb_build_object('ids',ids,'hasMore',jsonb_array_length(records)>page_size,
    'nextCursor',case when jsonb_array_length(records)>page_size then records->(page_size-1) else null end);
end;
$$;

create function public.crm_dashboard_summary()
returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
begin
  if not public.is_verified_session() or not public.has_permission('dashboard.view') then raise exception 'Dashboard access required'; end if;
  return (with scoped as materialized (
    select l.country,l.course,l.stage_id,l.created_at,l.next_followup_at, coalesce(s.name,'') stage_name, coalesce(s.is_terminal,false) terminal,
      lower(trim(coalesce(s.name,''))) in ('closed won','already enrolled') converted
    from public.leads l left join public.lead_stages s on s.id=l.stage_id
    where not l.is_archived and (select public.has_permission('dashboard.view'))
      and ((select public.is_crm_admin()) or l.assignee_id = any((select public.crm_dashboard_scope_ids())::uuid[]))
  ), groups as materialized (
    select lower(trim(coalesce(country,''))) country_key, lower(trim(coalesce(course,''))) course_key,
      min(trim(coalesce(country,''))) country, min(trim(coalesce(course,''))) course,
      stage_id, stage_name, count(*) total, count(*) filter(where converted) converted
    from scoped group by 1,2,stage_id,stage_name
  )
  select jsonb_build_object(
    'total',count(*),
    'newToday',count(*) filter(where (created_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date),
    'converted',count(*) filter(where converted),
    'overdue',count(*) filter(where not terminal and next_followup_at < date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'),
    'dueToday',count(*) filter(where not terminal and (next_followup_at at time zone 'UTC')::date = (now() at time zone 'UTC')::date),
    'daily',coalesce((select jsonb_object_agg(day_key,total) from (
      select (created_at at time zone 'UTC')::date day_key,count(*) total from scoped
      where created_at >= (date_trunc('day',now() at time zone 'UTC') - interval '6 days') at time zone 'UTC'
        and created_at < (date_trunc('day',now() at time zone 'UTC') + interval '1 day') at time zone 'UTC'
      group by 1) d),'{}'::jsonb),
    'stages',coalesce((select jsonb_agg(g) from (
      select stage_id,stage_name,sum(total) total from groups group by stage_id,stage_name) g),'[]'::jsonb),
    'country',coalesce((select jsonb_agg(g) from (
      select min(country) name,sum(total) total,sum(converted) converted,
        jsonb_object_agg(stage_name,stage_total) stages
      from (select country_key,min(country) country,stage_name,sum(total) stage_total,
        sum(total) total,sum(converted) converted from groups group by country_key,stage_name) c
      group by country_key order by sum(total) desc,country_key limit 30) g),'[]'::jsonb),
    'course',coalesce((select jsonb_agg(g) from (
      select min(course) name,sum(total) total,sum(converted) converted,
        jsonb_object_agg(stage_name,stage_total) stages
      from (select course_key,min(course) course,stage_name,sum(total) stage_total,
        sum(total) total,sum(converted) converted from groups group by course_key,stage_name) c
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
  ) from scoped);
end;
$$;

revoke all on function public.crm_lead_predicate(jsonb,text), public.crm_dashboard_scope_ids(),
  public.crm_lead_page(jsonb,text,integer,timestamptz,uuid,boolean,text,text,text,integer,jsonb), public.crm_dashboard_summary() from public, anon;
grant execute on function public.crm_lead_predicate(jsonb,text), public.crm_dashboard_scope_ids(),
  public.crm_lead_page(jsonb,text,integer,timestamptz,uuid,boolean,text,text,text,integer,jsonb), public.crm_dashboard_summary() to authenticated;

commit;
