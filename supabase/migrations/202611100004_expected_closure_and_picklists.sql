begin;

alter table public.leads add column expected_closure_date date;

create function public.merge_lead_picklists(existing jsonb, incoming jsonb)
returns jsonb language plpgsql immutable set search_path = public, pg_temp as $$
declare
  field text; choice text; options jsonb; result jsonb := '{}'::jsonb;
begin
  foreach field in array array['countryCode','country','qualification','category','course','source'] loop
    options := coalesce(existing->field,'[]'::jsonb);
    for choice in select btrim(value) from jsonb_array_elements_text(coalesce(incoming->field,'[]'::jsonb)) loop
      if length(choice) between 1 and 200 and not exists (
        select 1 from jsonb_array_elements_text(options) v where lower(btrim(v)) = lower(choice)
      ) then options := options || jsonb_build_array(choice); end if;
    end loop;
    result := jsonb_set(result,array[field],options);
  end loop;
  return result;
end;
$$;
revoke all on function public.merge_lead_picklists(jsonb,jsonb) from public, anon, authenticated;

create function public.record_lead_picklists()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare incoming jsonb; existing jsonb;
begin
  if tg_table_name = 'lead_sources' then
    incoming := jsonb_build_object('source',jsonb_build_array(new.name));
  else
    incoming := jsonb_build_object(
      'countryCode',jsonb_build_array(new.country_code),'country',jsonb_build_array(new.country),
      'qualification',jsonb_build_array(new.qualification),'category',jsonb_build_array(new.category),
      'course',jsonb_build_array(new.course),'source',jsonb_build_array(new.source));
  end if;
  select value into existing from public.crm_settings where setting_key = 'lead_observed_picklists';
  incoming := public.merge_lead_picklists(existing,incoming);
  if incoming is not distinct from existing then return new; end if;
  insert into public.crm_settings(setting_key,value) values ('lead_observed_picklists',incoming)
    on conflict(setting_key) do update
      set value = public.merge_lead_picklists(crm_settings.value,excluded.value),updated_at = now()
      where crm_settings.value is distinct from public.merge_lead_picklists(crm_settings.value,excluded.value);
  return new;
end;
$$;
revoke all on function public.record_lead_picklists() from public, anon, authenticated;

create trigger record_lead_picklists after insert or update of country_code,country,qualification,category,course,source on public.leads
for each row execute function public.record_lead_picklists();
create trigger record_source_picklists after insert or update of name on public.lead_sources
for each row execute function public.record_lead_picklists();

with choices as (
  select entry.key, btrim(entry.value) as value
  from public.leads l cross join lateral (values
    ('countryCode',l.country_code),('country',l.country),('qualification',l.qualification),
    ('category',l.category),('course',l.course),('source',l.source)
  ) entry(key,value)
  union all select 'source',btrim(name) from public.lead_sources
), grouped as (
  select key,jsonb_agg(value order by value) as options from (
    select distinct on (key,lower(value)) key,value from choices
    where length(value) between 1 and 200 order by key,lower(value),value
  ) unique_choices group by key
)
insert into public.crm_settings(setting_key,value)
select 'lead_observed_picklists',coalesce(jsonb_object_agg(key,options),'{}'::jsonb) from grouped
on conflict(setting_key) do update set value = public.merge_lead_picklists(crm_settings.value,excluded.value),updated_at = now();

create or replace function public.import_live_leads(rows_json jsonb)
returns integer language plpgsql security invoker set search_path = public as $$
declare row_json jsonb; total integer := 0;
begin
  if not public.has_permission('leads.import') or not public.has_permission('leads.create') then
    raise exception 'Import permission required';
  end if;
  if jsonb_typeof(rows_json) <> 'array' or jsonb_array_length(rows_json) not between 1 and 1000 then
    raise exception 'Import between 1 and 1000 rows';
  end if;
  for row_json in select value from jsonb_array_elements(rows_json) loop
    insert into public.leads(name,phone,normalized_phone,country_code,alt_phone,email,normalized_email,country,billing_address,course,
      qualification,category,source,stage_id,assignee_id,created_by,modified_by,next_followup_at,closure_fee,expected_closure_date,custom_fields)
    values(row_json->>'name',row_json->>'phone',row_json->>'normalized_phone',row_json->>'country_code',
      row_json->>'alt_phone',row_json->>'email',row_json->>'normalized_email',row_json->>'country',coalesce(row_json->>'billing_address',''),row_json->>'course',
      row_json->>'qualification',row_json->>'category',coalesce(row_json->>'source','import'),(row_json->>'stage_id')::uuid,
      coalesce((row_json->>'assignee_id')::uuid,auth.uid()),auth.uid(),auth.uid(),
      (row_json->>'next_followup_at')::timestamptz,coalesce((row_json->>'closure_fee')::numeric,0),
      nullif(row_json->>'expected_closure_date','')::date,coalesce(row_json->'custom_fields','{}'::jsonb));
    total := total + 1;
  end loop;
  return total;
end $$;

create or replace function public.crm_lead_predicate(filter_json jsonb, timezone_name text default 'UTC')
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
      when 'expectedClosureDate' then 'l.expected_closure_date'
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
    elsif field in ('createdAt','modifiedAt','followUpAt','lastVisitAt','expectedClosureDate') then
      if field = 'expectedClosureDate' then
        start_sql := format('%L::date',v);
        end_sql := format('(%L::date + 1)',case when op in ('between','not_between') then v2 else v end);
      else
        start_sql := format('(%L::date::timestamp at time zone %L)',v,timezone_name);
        end_sql := format('((%L::date + 1)::timestamp at time zone %L)',case when op in ('between','not_between') then v2 else v end,timezone_name);
      end if;
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
        part := format('(lower(trim(l.source)) in (''website'',''dmhca-chatbot'',''dmhca-contact form'',''website-ibmp'') and l.last_visit_at is not null and (%s))',part);
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
    result := result || format(' and (strpos(lower(concat_ws('' '',l.name,l.phone,l.email,l.country_code,l.country,l.course,l.qualification,l.category,l.source,s.name,a.full_name,m.full_name,l.id,l.assignee_id,l.stage_id,l.created_at,l.modified_at,l.next_followup_at,l.last_visit_at,l.closure_fee,l.expected_closure_date,l.billing_address,l.custom_fields)),%L)>0',v);
    v2 := regexp_replace(v,'[^0-9]','','g');
    if length(v2) > 2 then result := result || format(' or strpos(regexp_replace(l.phone,''[^0-9]'','''',''g''),%L)>0',v2); end if;
    result := result || ')';
  end if;
  return result;
end;
$$;

create or replace function public.integration_intake(p_source_id uuid,p_event_id text,p_lead jsonb,p_transcript jsonb default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_settings public.intake_source_settings;
  v_source public.lead_sources;
  v_existing public.inbound_events;
  v_config jsonb;
  v_policy text;
  v_fields text;
  v_lead_id uuid;
  v_status text := 'created';
  v_phone text := regexp_replace(p_lead->>'phone','[^0-9]','','g');
  v_email text := nullif(lower(trim(p_lead->>'email')),'');
  v_message text := nullif(btrim(coalesce(p_lead->>'message',''), E' \t\n\r'),'');
begin
  perform pg_advisory_xact_lock(hashtextextended('crm.live-lead-creation',0));
  select * into v_source from public.lead_sources where id=p_source_id and is_active;
  if not found then raise exception 'Intake source unavailable'; end if;
  select * into v_settings from public.intake_source_settings where source_id=p_source_id;
  if not found or not exists(select 1 from public.profiles where id=v_settings.owner_id and status='active' and deleted_at is null)
    then raise exception 'Intake source needs an active owner'; end if;
  if v_settings.stage_id is not null and not exists(select 1 from public.lead_stages where id=v_settings.stage_id and is_active)
    then raise exception 'Intake stage is inactive'; end if;
  if p_event_id is null or length(p_event_id) not between 1 and 200 or length(trim(coalesce(p_lead->>'name',''))) not between 1 and 200
    or length(v_phone) not between 7 and 15 then raise exception 'Invalid intake payload'; end if;
  if p_lead ? 'message' and (jsonb_typeof(p_lead->'message') <> 'string' or length(coalesce(v_message,'')) > 10000)
    then raise exception 'Invalid intake message'; end if;
  select * into v_existing from public.inbound_events where source_id=p_source_id and external_event_id=p_event_id;
  if found then return jsonb_build_object('status','replayed','lead_id',v_existing.lead_id); end if;
  select value into v_config from public.crm_settings where setting_key='lead_configuration';
  v_fields := coalesce(v_config->>'duplicateFields','phone_email');
  v_policy := coalesce(v_config->>'creationPolicy','block');
  if v_fields not in ('phone_email','phone','email') or v_policy not in ('allow','warn','block')
    then raise exception 'Unsupported lead duplicate configuration'; end if;
  select coalesce(merged_into_id,id) into v_lead_id from public.leads where
    ((v_fields in ('phone_email','phone') and normalized_phone=v_phone) or
     (v_fields in ('phone_email','email') and v_email is not null and normalized_email=v_email))
    order by created_at,id limit 1;
  if v_lead_id is not null and v_policy <> 'allow' then
    v_status := 'matched_existing';
  else
    insert into public.leads(name,phone,normalized_phone,email,normalized_email,country,course,qualification,category,
      source,assignee_id,created_by,stage_id)
    values(trim(p_lead->>'name'),p_lead->>'phone',v_phone,v_email,v_email,p_lead->>'country',
      p_lead->>'course',p_lead->>'qualification',p_lead->>'category',v_source.name,v_settings.owner_id,v_settings.created_by,v_settings.stage_id)
    returning id into v_lead_id;
  end if;
  insert into public.inbound_events(source_id,lead_id,payload,status,external_event_id)
    values(p_source_id,v_lead_id,p_lead,v_status,p_event_id);
  if v_message is not null then
    insert into public.notes(lead_id,user_id,content)
      values(v_lead_id,null,'Enquiry from ' || v_source.name || E'\n\n' || v_message);
  end if;
  insert into public.activities(lead_id,user_id,type,description,meta)
    values(v_lead_id,null,'inbound',v_source.name || ': ' || v_status,
      jsonb_build_object('source_id',p_source_id,'external_event_id',p_event_id,'note_created',v_message is not null));
  if v_settings.channel='chatbot' and p_transcript is not null then
    insert into public.chat_sessions(lead_id,channel,transcript,ended_at) values(v_lead_id,'website_chatbot',p_transcript,now());
  end if;
  return jsonb_build_object('status',v_status,'lead_id',v_lead_id);
end $$;

commit;
