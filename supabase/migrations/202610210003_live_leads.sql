begin;

alter table public.leads add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table public.leads add constraint live_lead_custom_fields_object check (jsonb_typeof(custom_fields) = 'object');

create table if not exists public.saved_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  name text not null,
  filter_json jsonb not null,
  columns_json jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.saved_reports enable row level security;
create policy "Own live reports" on public.saved_reports for all to authenticated
using (user_id = auth.uid() and public.has_permission('reports.view'))
with check (user_id = auth.uid() and public.has_permission('reports.view'));
grant select, insert, update, delete on public.saved_reports to authenticated;

drop policy if exists "Users manage own saved filters" on public.saved_filters;
create policy "Users manage own saved filters" on public.saved_filters for all to authenticated
using (owner_id = auth.uid() and public.has_permission('leads.view'))
with check (owner_id = auth.uid() and public.has_permission('leads.view'));

insert into public.role_permissions(role,permission_key,allowed)
values ('admin','leads.import',true),('super_admin','leads.import',true),
  ('admin','leads.delete',true),('super_admin','leads.delete',true)
on conflict (role,permission_key) do nothing;

create policy "Update own email delivery log" on public.emails for update to authenticated
using (user_id = auth.uid() and public.has_permission('leads.edit'))
with check (user_id = auth.uid() and public.has_permission('leads.edit'));

create policy "Note creation requires edit permission" on public.notes as restrictive for insert to authenticated
with check (public.has_permission('leads.edit'));
create policy "Manual activities require edit permission" on public.activities as restrictive for insert to authenticated
with check (public.has_permission('leads.edit'));
create policy "Email creation requires edit permission" on public.emails as restrictive for insert to authenticated
with check (public.has_permission('leads.edit'));

create policy "Archive leads within hierarchy" on public.leads for update to authenticated
using (public.has_permission('leads.delete') and (assignee_id = auth.uid() or public.user_in_scope(assignee_id) or public.has_permission('users.view')))
with check (public.has_permission('leads.delete') and (assignee_id = auth.uid() or public.user_in_scope(assignee_id) or public.has_permission('users.view')));

-- Only disclose the policy decision, never the identity or contents of a matching lead.
create function public.check_live_lead_duplicates(rows_json jsonb)
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
    select regexp_replace(coalesce(value->>'normalized_phone',''), '[^0-9]', '', 'g') as phone,
      nullif(lower(trim(value->>'normalized_email')),'') as email
    from jsonb_array_elements(rows_json)
  )
  select exists (
    select 1 from public.leads l join candidates c on
      (match_fields in ('phone_email','phone') and c.phone <> '' and l.normalized_phone = c.phone)
      or (match_fields in ('phone_email','email') and c.email is not null and l.normalized_email = c.email)
    union all
    select 1 from candidates where match_fields in ('phone_email','phone') and phone <> '' group by phone having count(*) > 1
    union all
    select 1 from candidates where match_fields in ('phone_email','email') and email is not null group by email having count(*) > 1
  ) into duplicate_found;
  if not duplicate_found then return 'clear'; end if;
  if policy = 'warn' and public.is_crm_admin() then return 'warn'; end if;
  return 'block';
end $$;
revoke all on function public.check_live_lead_duplicates(jsonb) from public, anon;
grant execute on function public.check_live_lead_duplicates(jsonb) to authenticated;

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
  if tg_op = 'INSERT' then
    if public.check_live_lead_duplicates(jsonb_build_array(jsonb_build_object(
      'normalized_phone',new.normalized_phone,'normalized_email',new.normalized_email))) = 'block' then
      raise exception 'Duplicate lead blocked by CRM configuration';
    end if;
  end if;
  return new;
end $$;
create trigger guard_live_lead_changes before insert or update on public.leads
for each row execute function public.guard_live_lead_changes();

create or replace function public.audit_live_lead_changes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.activities(lead_id,user_id,type,description,meta)
      values(new.id,auth.uid(),'created','Lead created',
        jsonb_build_object('duplicate_policy',coalesce((select value->>'creationPolicy' from public.crm_settings where setting_key = 'lead_configuration'),'block')));
  elsif new is distinct from old then
    insert into public.activities(lead_id,user_id,type,description,meta)
      values(coalesce(new.merged_into_id,new.id),auth.uid(),'updated',
        case when new.merged_into_id is distinct from old.merged_into_id then 'Lead merged and archived'
             when new.is_archived and not old.is_archived then 'Lead archived'
             when new.assignee_id is distinct from old.assignee_id then 'Lead transferred'
             when new.stage_id is distinct from old.stage_id then 'Lead stage changed'
             else 'Lead details updated' end,
        jsonb_build_object('previous_stage_id',old.stage_id,'stage_id',new.stage_id,
          'previous_assignee_id',old.assignee_id,'assignee_id',new.assignee_id));
  end if;
  return new;
end $$;
create trigger audit_live_lead_changes after insert or update on public.leads
for each row execute function public.audit_live_lead_changes();

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
    insert into public.leads(name,phone,normalized_phone,alt_phone,email,normalized_email,country,course,
      qualification,source,stage_id,assignee_id,created_by,modified_by,next_followup_at,closure_fee,custom_fields)
    values(row_json->>'name',row_json->>'phone',row_json->>'normalized_phone',row_json->>'alt_phone',
      row_json->>'email',row_json->>'normalized_email',row_json->>'country',row_json->>'course',
      row_json->>'qualification',coalesce(row_json->>'source','import'),(row_json->>'stage_id')::uuid,
      coalesce((row_json->>'assignee_id')::uuid,auth.uid()),auth.uid(),auth.uid(),
      (row_json->>'next_followup_at')::timestamptz,coalesce((row_json->>'closure_fee')::numeric,0),coalesce(row_json->'custom_fields','{}'::jsonb));
    total := total + 1;
  end loop;
  return total;
end $$;
revoke all on function public.import_live_leads(jsonb) from public;
grant execute on function public.import_live_leads(jsonb) to authenticated;

create function public.merge_live_leads(source_id uuid, target_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare source_row public.leads; target_row public.leads; relation record;
  moved jsonb := '{}'::jsonb; affected integer;
begin
  if not public.is_verified_session() or not public.has_permission('leads.merge') or not public.has_permission('leads.view') then
    raise exception 'Lead merge permission required';
  end if;
  if source_id is null or target_id is null or source_id = target_id then raise exception 'Choose two different leads'; end if;
  -- Stable locking order prevents opposing simultaneous merges from deadlocking.
  perform id from public.leads where id in (source_id,target_id) order by id for update;
  select * into source_row from public.leads where id = source_id;
  select * into target_row from public.leads where id = target_id;
  if source_row.id is null or target_row.id is null
    or source_row.is_archived or target_row.is_archived
    or source_row.merged_into_id is not null or target_row.merged_into_id is not null
    or (source_row.assignee_id = auth.uid() or public.user_in_scope(source_row.assignee_id) or public.has_permission('users.view')) is not true
    or (target_row.assignee_id = auth.uid() or public.user_in_scope(target_row.assignee_id) or public.has_permission('users.view')) is not true
  then raise exception 'Both leads must be active and within your accessible scope'; end if;

  -- Include every single-column lead_id FK, including later integration tables.
  -- Child rows referencing meetings/invoices/calls retain their original parent IDs.
  for relation in
    select distinct ns.nspname as schema_name, tbl.relname as table_name, att.attname as column_name
    from pg_constraint fk
    join pg_class tbl on tbl.oid = fk.conrelid
    join pg_namespace ns on ns.oid = tbl.relnamespace
    join pg_attribute att on att.attrelid = tbl.oid and att.attnum = fk.conkey[1]
    where fk.contype = 'f' and fk.confrelid = 'public.leads'::regclass
      and cardinality(fk.conkey) = 1 and ns.nspname = 'public' and att.attname = 'lead_id'
    order by ns.nspname,tbl.relname
  loop
    execute format('update %I.%I set %I = $1 where %I = $2',
      relation.schema_name,relation.table_name,relation.column_name,relation.column_name)
      using target_id,source_id;
    get diagnostics affected = row_count;
    moved := moved || jsonb_build_object(relation.table_name,affected);
  end loop;
  update public.leads set merged_into_id = target_id,is_archived = true,modified_by = auth.uid() where id = source_id;
  insert into public.merge_logs(master_lead_id,merged_lead_id,user_id,field_choices_json)
    values(target_id,source_id,auth.uid(),jsonb_build_object(
      'strategy','keep_target_fields','source_snapshot',to_jsonb(source_row),
      'target_snapshot',to_jsonb(target_row),'moved_records',moved));
  insert into public.activities(lead_id,user_id,type,description,meta)
    values(target_id,auth.uid(),'merged','Lead merged into this record',
      jsonb_build_object('source_lead_id',source_id,'moved_records',moved));
  return jsonb_build_object('id',target_id,'mergedId',source_id,'movedRecords',moved);
end $$;
revoke all on function public.merge_live_leads(uuid,uuid) from public, anon;
grant execute on function public.merge_live_leads(uuid,uuid) to authenticated;
commit;
