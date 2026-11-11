begin;

drop policy if exists "Note creation requires edit permission" on public.notes;
create policy "Note creation requires edit or import permission" on public.notes as restrictive for insert to authenticated
with check (
  public.has_permission('leads.edit')
  or (public.has_permission('leads.import') and public.has_permission('leads.create'))
);

create or replace function public.import_live_leads(rows_json jsonb)
returns integer language plpgsql security invoker set search_path = public as $$
declare
  row_json jsonb;
  total integer := 0;
  imported_lead_id uuid;
  note_content text;
begin
  if not public.has_permission('leads.import') or not public.has_permission('leads.create') then
    raise exception 'Import permission required';
  end if;
  if jsonb_typeof(rows_json) <> 'array' or jsonb_array_length(rows_json) not between 1 and 1000 then
    raise exception 'Import between 1 and 1000 rows';
  end if;
  for row_json in select value from jsonb_array_elements(rows_json) loop
    note_content := btrim(coalesce(row_json->>'note', ''));
    if length(note_content) > 10000 then
      raise exception 'Note exceeds 10000 characters';
    end if;
    insert into public.leads(name,phone,normalized_phone,country_code,alt_phone,email,normalized_email,country,billing_address,course,
      qualification,speciality,category,source,stage_id,assignee_id,created_by,modified_by,next_followup_at,closure_fee,expected_closure_date,custom_fields)
    values(row_json->>'name',row_json->>'phone',row_json->>'normalized_phone',row_json->>'country_code',
      row_json->>'alt_phone',row_json->>'email',row_json->>'normalized_email',row_json->>'country',coalesce(row_json->>'billing_address',''),row_json->>'course',
      row_json->>'qualification',nullif(btrim(row_json->>'speciality'),''),row_json->>'category',coalesce(row_json->>'source','import'),(row_json->>'stage_id')::uuid,
      coalesce((row_json->>'assignee_id')::uuid,auth.uid()),auth.uid(),auth.uid(),
      (row_json->>'next_followup_at')::timestamptz,coalesce((row_json->>'closure_fee')::numeric,0),
      nullif(row_json->>'expected_closure_date','')::date,coalesce(row_json->'custom_fields','{}'::jsonb))
    returning id into imported_lead_id;
    if note_content <> '' then
      insert into public.notes(lead_id,user_id,content) values(imported_lead_id,auth.uid(),note_content);
    end if;
    total := total + 1;
  end loop;
  return total;
end $$;

revoke all on function public.import_live_leads(jsonb) from public;
grant execute on function public.import_live_leads(jsonb) to authenticated;

commit;
