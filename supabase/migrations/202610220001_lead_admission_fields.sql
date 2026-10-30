begin;

alter table public.leads
  add column country_code text,
  add column category text;

create or replace function public.save_crm_configuration(stage_rows jsonb, settings_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  row_value jsonb;
  keep_ids uuid[] := '{}';
  stage_id uuid;
  position integer := 0;
  actor_role public.crm_role;
  current_settings jsonb;
  current_stages jsonb;
begin
  if not public.has_permission('settings.manage') then raise exception 'Access denied' using errcode = '42501'; end if;
  select role into actor_role from public.profiles where id = auth.uid() and deleted_at is null;
  select value into current_settings from public.crm_settings where setting_key = 'lead_configuration';
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'is_terminal',is_terminal) order by sort_order),'[]'::jsonb)
    into current_stages from public.lead_stages where is_active;
  if actor_role not in ('admin','super_admin') then
    if stage_rows is distinct from current_stages then raise exception 'Only Admins and Super Admins can change dropdown values'; end if;
    if current_settings->'picklists' is null then
      settings_value := settings_value - 'picklists';
    else
      settings_value := settings_value || jsonb_build_object('picklists',current_settings->'picklists');
    end if;
  end if;
  if jsonb_typeof(stage_rows) <> 'array' or jsonb_array_length(stage_rows) = 0 then raise exception 'At least one stage is required'; end if;
  if jsonb_typeof(settings_value) <> 'object' then raise exception 'Invalid settings'; end if;
  if not exists (select 1 from jsonb_array_elements(stage_rows) as stages(value)
    where lower(trim(stages.value->>'name')) = 'fresh' and coalesce((stages.value->>'is_terminal')::boolean,false) = false) then
    raise exception 'The Fresh stage is required and cannot be terminal';
  end if;
  for row_value in select value from jsonb_array_elements(stage_rows) loop
    position := position + 1;
    if length(trim(row_value->>'name')) not between 1 and 100 then raise exception 'Invalid stage name'; end if;
    stage_id := coalesce(nullif(row_value->>'id','')::uuid,gen_random_uuid());
    if row_value->>'id' is not null and not exists (select 1 from public.lead_stages where id = stage_id)
      then raise exception 'Stage not found'; end if;
    insert into public.lead_stages(id,name,sort_order,is_active,is_terminal)
    values(stage_id,trim(row_value->>'name'),position,true,coalesce((row_value->>'is_terminal')::boolean,false))
    on conflict(id) do update set name = excluded.name,sort_order = excluded.sort_order,is_active = true,is_terminal = excluded.is_terminal;
    keep_ids := array_append(keep_ids,stage_id);
  end loop;
  update public.lead_stages set is_active = false where not(id = any(keep_ids));
  insert into public.crm_settings(setting_key,value,updated_by) values('lead_configuration',settings_value,auth.uid())
    on conflict(setting_key) do update set value = excluded.value,updated_by = auth.uid(),updated_at = now();
  insert into public.audit_logs(actor_id,action,entity_type,changes)
    values(auth.uid(),'settings.updated','crm_settings',jsonb_build_object('stages',stage_rows,'settings',settings_value));
end; $$;
revoke all on function public.save_crm_configuration(jsonb,jsonb) from public, anon;
grant execute on function public.save_crm_configuration(jsonb,jsonb) to authenticated;

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
    insert into public.leads(name,phone,normalized_phone,country_code,alt_phone,email,normalized_email,country,course,
      qualification,category,source,stage_id,assignee_id,created_by,modified_by,next_followup_at,closure_fee,custom_fields)
    values(row_json->>'name',row_json->>'phone',row_json->>'normalized_phone',row_json->>'country_code',
      row_json->>'alt_phone',row_json->>'email',row_json->>'normalized_email',row_json->>'country',row_json->>'course',
      row_json->>'qualification',row_json->>'category',coalesce(row_json->>'source','import'),(row_json->>'stage_id')::uuid,
      coalesce((row_json->>'assignee_id')::uuid,auth.uid()),auth.uid(),auth.uid(),
      (row_json->>'next_followup_at')::timestamptz,coalesce((row_json->>'closure_fee')::numeric,0),coalesce(row_json->'custom_fields','{}'::jsonb));
    total := total + 1;
  end loop;
  return total;
end $$;
revoke all on function public.import_live_leads(jsonb) from public;
grant execute on function public.import_live_leads(jsonb) to authenticated;

commit;
