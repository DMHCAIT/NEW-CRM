begin;

create table public.lead_import_sheets (
  id uuid primary key default gen_random_uuid(),
  filename text not null check (length(btrim(filename)) between 1 and 255),
  created_by uuid not null references public.profiles(id),
  total_rows integer not null check (total_rows between 1 and 200000),
  imported_rows integer not null default 0 check (imported_rows >= 0),
  duplicate_rows integer not null default 0 check (duplicate_rows >= 0),
  status text not null default 'importing' check (status in ('importing','completed','deleted')),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (imported_rows + duplicate_rows <= total_rows)
);
create index lead_import_sheets_owner_date on public.lead_import_sheets(created_by, created_at desc, id desc);
alter table public.lead_import_sheets enable row level security;
revoke all on public.lead_import_sheets from anon, authenticated;
grant select on public.lead_import_sheets to authenticated;
create policy "View accessible import sheets" on public.lead_import_sheets for select to authenticated
using (public.is_verified_session() and public.has_permission('leads.import')
  and (created_by = auth.uid() or public.has_permission('users.view')));
create policy "Require verified CRM session" on public.lead_import_sheets as restrictive for all to authenticated
using (public.is_verified_session()) with check (public.is_verified_session());

create table public.lead_import_batches (
  sheet_id uuid not null references public.lead_import_sheets(id),
  batch_index integer not null check (batch_index >= 0),
  payload_hash text not null,
  result jsonb not null,
  primary key (sheet_id, batch_index)
);
alter table public.lead_import_batches enable row level security;
revoke all on public.lead_import_batches from public, anon, authenticated;

alter table public.leads add column import_sheet_id uuid references public.lead_import_sheets(id);
create index leads_import_sheet on public.leads(import_sheet_id) where import_sheet_id is not null;

create function public.track_lead_import_sheet()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare sheet_context uuid;
begin
  if tg_op = 'UPDATE' then
    if new.import_sheet_id is distinct from old.import_sheet_id then
      raise exception 'Lead import provenance is immutable';
    end if;
    return new;
  end if;
  sheet_context := nullif(current_setting('crm.lead_import_sheet', true), '')::uuid;
  if new.import_sheet_id is not null or sheet_context is not null then
    if current_user <> (select pg_get_userbyid(relowner) from pg_class where oid = 'public.leads'::regclass)
      or not public.is_verified_session() or not public.has_permission('leads.import')
      or sheet_context is null
      or not exists (select 1 from public.lead_import_sheets
        where id = sheet_context and created_by = auth.uid() and status = 'importing')
    then raise exception 'Use the authorized sheet import operation'; end if;
    if new.import_sheet_id is not null and new.import_sheet_id <> sheet_context then
      raise exception 'Invalid import sheet';
    end if;
    new.import_sheet_id := sheet_context;
  end if;
  return new;
end $$;
create trigger b_track_lead_import_sheet before insert or update on public.leads
for each row execute function public.track_lead_import_sheet();

create function public.start_live_lead_import(sheet_filename text, row_count integer, duplicates integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sheet public.lead_import_sheets;
begin
  if not public.is_verified_session() or not public.has_permission('leads.import')
    or not public.has_permission('leads.create') then raise exception 'Import permission required'; end if;
  if sheet_filename is null or length(btrim(sheet_filename)) not between 1 and 255
    or row_count is null or row_count not between 1 and 200000
    or duplicates is null or duplicates < 0 or duplicates > row_count then
    raise exception 'Invalid import sheet details';
  end if;
  insert into public.lead_import_sheets(filename, created_by, total_rows, duplicate_rows, status)
  values(btrim(sheet_filename), auth.uid(), row_count, duplicates,
    case when duplicates = row_count then 'completed' else 'importing' end)
  returning * into sheet;
  return to_jsonb(sheet);
end $$;

create function public.import_live_lead_sheet_batch(sheet_id uuid, batch_index integer, rows_json jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sheet public.lead_import_sheets; result jsonb; previous_context text; batch_rows integer;
begin
  if not public.is_verified_session() or not public.has_permission('leads.import')
    or not public.has_permission('leads.create') then raise exception 'Import permission required'; end if;
  select * into sheet from public.lead_import_sheets s
    where s.id = sheet_id and s.created_by = auth.uid() for update;
  if sheet.id is null or sheet.status = 'deleted' then raise exception 'Import sheet not found'; end if;
  if batch_index is null or batch_index < 0 or jsonb_typeof(rows_json) is distinct from 'array'
    or jsonb_array_length(rows_json) not between 1 and 5000 then raise exception 'Invalid import batch'; end if;
  if exists (select 1 from public.lead_import_batches b
    where b.sheet_id = import_live_lead_sheet_batch.sheet_id
      and b.batch_index = import_live_lead_sheet_batch.batch_index
      and b.payload_hash <> md5(rows_json::text))
  then raise exception 'Cannot reuse an import batch index with different rows'; end if;
  select b.result into result from public.lead_import_batches b
    where b.sheet_id = import_live_lead_sheet_batch.sheet_id
      and b.batch_index = import_live_lead_sheet_batch.batch_index;
  if result is not null then return result; end if;
  batch_rows := jsonb_array_length(rows_json);
  if sheet.status <> 'importing' or sheet.imported_rows + sheet.duplicate_rows + batch_rows > sheet.total_rows then
    raise exception 'Import batch exceeds remaining sheet rows';
  end if;
  previous_context := coalesce(current_setting('crm.lead_import_sheet', true), '');
  perform set_config('crm.lead_import_sheet', sheet.id::text, true);
  result := public.import_live_leads(rows_json);
  perform set_config('crm.lead_import_sheet', previous_context, true);
  insert into public.lead_import_batches values(sheet.id, batch_index, md5(rows_json::text), result);
  update public.lead_import_sheets s set
    imported_rows = s.imported_rows + (result->>'imported')::integer,
    duplicate_rows = s.duplicate_rows + (result->>'skipped')::integer,
    status = case when s.imported_rows + s.duplicate_rows + batch_rows = s.total_rows
      then 'completed' else 'importing' end
    where s.id = sheet.id;
  return result;
end $$;

create function public.delete_live_lead_import(sheet_id uuid)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare sheet public.lead_import_sheets; archived_rows integer;
begin
  if not public.is_verified_session() or not public.has_permission('leads.import')
    or not public.has_permission('leads.delete')
    or not exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','super_admin'))
  then raise exception 'Administrator and lead delete permission required'; end if;
  select * into sheet from public.lead_import_sheets s where s.id = sheet_id
    and (s.created_by = auth.uid() or public.has_permission('users.view')) for update;
  if sheet.id is null or sheet.status = 'deleted' then raise exception 'Import sheet not found'; end if;
  if exists (select 1 from public.leads l where l.import_sheet_id = sheet.id and not l.is_archived
    and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view')) is not true)
  then raise exception 'Some imported leads are outside your accessible scope'; end if;
  -- Match CRM deletion semantics: remove leads from active CRM views while retaining their audit history.
  update public.leads set is_archived = true, modified_by = auth.uid()
    where import_sheet_id = sheet.id and not is_archived;
  get diagnostics archived_rows = row_count;
  update public.lead_import_sheets set status = 'deleted', deleted_at = now() where id = sheet.id;
  return archived_rows;
end $$;

revoke all on function public.start_live_lead_import(text,integer,integer) from public, anon;
revoke all on function public.import_live_lead_sheet_batch(uuid,integer,jsonb) from public, anon;
revoke all on function public.delete_live_lead_import(uuid) from public, anon;
grant execute on function public.start_live_lead_import(text,integer,integer) to authenticated;
grant execute on function public.import_live_lead_sheet_batch(uuid,integer,jsonb) to authenticated;
grant execute on function public.delete_live_lead_import(uuid) to authenticated;

create or replace function public.combined_lead_phone(phone_value text, calling_code text)
returns text language plpgsql immutable set search_path = public, pg_temp as $$
declare digits text; prefix text;
begin
  digits := regexp_replace(coalesce(phone_value, ''), '[^0-9]', '', 'g');
  if digits = '' then return ''; end if;
  if left(trim(coalesce(phone_value, '')), 1) = '+' then return '+' || digits; end if;
  prefix := public.lead_country_calling_prefix(calling_code);
  if prefix <> '' and not (length(digits) > 10 and left(digits, length(prefix)) = prefix) then
    digits := prefix || digits;
  end if;
  return '+' || digits;
end $$;

-- Prefix-only backfill must not reschedule follow-ups or mark old leads as user-edited.
alter table public.leads disable trigger audit_leads;
alter table public.leads disable trigger audit_live_lead_changes;
alter table public.leads disable trigger track_lead_edit;
alter table public.leads disable trigger track_lead_schedule_revision;
alter table public.leads disable trigger handle_overdue_followup_on_edit;
update public.leads set phone = '+' || regexp_replace(phone, '[^0-9]', '', 'g')
where phone not like '+%' and regexp_replace(phone, '[^0-9]', '', 'g') <> '';
alter table public.leads enable trigger audit_leads;
alter table public.leads enable trigger audit_live_lead_changes;
alter table public.leads enable trigger track_lead_edit;
alter table public.leads enable trigger track_lead_schedule_revision;
alter table public.leads enable trigger handle_overdue_followup_on_edit;

commit;
