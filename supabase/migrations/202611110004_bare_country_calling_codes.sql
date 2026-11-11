begin;

create or replace function public.lead_country_calling_prefix(country_code_value text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select coalesce(
    substring(coalesce(country_code_value, '') from '\(\+([0-9]{1,3})\)'),
    substring(trim(coalesce(country_code_value, '')) from '^\+?([0-9]{1,3})$'),
    ''
  )
$$;

create or replace function public.combined_lead_phone(phone_value text, calling_code text)
returns text language plpgsql immutable set search_path = public, pg_temp as $$
declare digits text; prefix text;
begin
  digits := regexp_replace(coalesce(phone_value, ''), '[^0-9]', '', 'g');
  if left(trim(coalesce(phone_value, '')), 1) = '+' then return '+' || digits; end if;
  prefix := public.lead_country_calling_prefix(calling_code);
  if prefix = '' then
    if coalesce(calling_code, '') = '' and digits ~ '^91[0-9]{10}$' then return '+' || digits; end if;
    return digits;
  end if;
  if not (length(digits) > 10 and left(digits, length(prefix)) = prefix) then
    digits := prefix || digits;
  end if;
  return '+' || digits;
end $$;

create or replace function public.lead_phones_match(phone_a text, country_code_a text, phone_b text, country_code_b text)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  with numbers as (
    select
      regexp_replace(public.combined_lead_phone(phone_a, country_code_a), '[^0-9]', '', 'g') as a,
      regexp_replace(public.combined_lead_phone(phone_b, country_code_b), '[^0-9]', '', 'g') as b,
      public.lead_country_calling_prefix(country_code_a) as prefix_a,
      public.lead_country_calling_prefix(country_code_b) as prefix_b
  )
  select a <> '' and b <> '' and (
    a = b
    or (coalesce(country_code_a, '') = '' and prefix_b <> '' and a = substring(b from length(prefix_b) + 1))
    or (coalesce(country_code_b, '') = '' and prefix_a <> '' and b = substring(a from length(prefix_a) + 1))
  )
  from numbers
$$;

create or replace function public.import_live_leads(rows_json jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  row_json jsonb;
  total integer := 0;
  skipped integer := 0;
  imported_lead_id uuid;
  note_content text;
  normalized_phone_value text;
  normalized_email_value text;
  calling_prefix text;
  assigned_user_id uuid;
begin
  if not public.is_verified_session() or not public.has_permission('leads.import') or not public.has_permission('leads.create') then
    raise exception 'Import permission required';
  end if;
  if jsonb_typeof(rows_json) <> 'array' or jsonb_array_length(rows_json) not between 1 and 1000 then
    raise exception 'Import between 1 and 1000 rows';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm.live-lead-creation', 0));
  for row_json in select value from jsonb_array_elements(rows_json) loop
    normalized_phone_value := regexp_replace(public.combined_lead_phone(row_json->>'phone', row_json->>'country_code'), '[^0-9]', '', 'g');
    calling_prefix := public.lead_country_calling_prefix(row_json->>'country_code');
    normalized_email_value := lower(btrim(coalesce(row_json->>'email', '')));
    assigned_user_id := nullif(row_json->>'assignee_id', '')::uuid;
    note_content := btrim(coalesce(row_json->>'note', ''));
    if normalized_phone_value = '' or normalized_email_value = ''
      or (coalesce(row_json->>'country_code', '') <> '' and calling_prefix = '') then
      raise exception 'Email and phone are required, and country code must be valid when provided';
    end if;
    if length(normalized_phone_value) not between 7 and 15 or row_json->>'phone' !~ '^\+?[0-9\s().-]+$' then
      raise exception 'A valid phone number is required';
    end if;
    if normalized_email_value !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      raise exception 'A valid email is required';
    end if;
    if length(note_content) > 10000 then
      raise exception 'Note exceeds 10000 characters';
    end if;
    if assigned_user_id is null or not exists (
      select 1 from public.profiles p where p.id = assigned_user_id and p.status = 'active' and p.deleted_at is null
    ) then
      raise exception 'Choose an accessible active assignee for every imported lead';
    end if;
    if assigned_user_id <> auth.uid() and (
      not public.has_permission('leads.assign')
      or (not public.user_in_scope(assigned_user_id) and not public.has_permission('users.view'))
    ) then
      raise exception 'Assignment permission is required for the selected assignee';
    end if;
    if exists (
      select 1 from public.leads l
      where public.lead_phones_match(l.phone,l.country_code,row_json->>'phone',row_json->>'country_code')
         or lower(btrim(coalesce(nullif(l.normalized_email,''), l.email, ''))) = normalized_email_value
    ) then
      skipped := skipped + 1;
      continue;
    end if;
    insert into public.leads(name,phone,normalized_phone,country_code,alt_phone,email,normalized_email,country,billing_address,course,
      qualification,speciality,category,source,stage_id,assignee_id,created_by,modified_by,next_followup_at,closure_fee,expected_closure_date,custom_fields)
    values(row_json->>'name',row_json->>'phone',normalized_phone_value,row_json->>'country_code',
      row_json->>'alt_phone',row_json->>'email',normalized_email_value,row_json->>'country',coalesce(row_json->>'billing_address',''),row_json->>'course',
      row_json->>'qualification',nullif(btrim(row_json->>'speciality'),''),row_json->>'category',coalesce(row_json->>'source','import'),(row_json->>'stage_id')::uuid,
      assigned_user_id,auth.uid(),auth.uid(),
      (row_json->>'next_followup_at')::timestamptz,coalesce((row_json->>'closure_fee')::numeric,0),
      nullif(row_json->>'expected_closure_date','')::date,coalesce(row_json->'custom_fields','{}'::jsonb))
    returning id into imported_lead_id;
    if note_content <> '' then
      insert into public.notes(lead_id,user_id,content) values(imported_lead_id,auth.uid(),note_content);
    end if;
    total := total + 1;
  end loop;
  return jsonb_build_object('imported', total, 'skipped', skipped);
end $$;

revoke all on function public.import_live_leads(jsonb) from public;
grant execute on function public.import_live_leads(jsonb) to authenticated;

revoke all on function public.lead_country_calling_prefix(text) from public, anon;
grant execute on function public.lead_country_calling_prefix(text) to authenticated;
grant execute on function public.lead_country_calling_prefix(text) to service_role;

commit;
