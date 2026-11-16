begin;

alter table public.lead_import_sheets drop constraint lead_import_sheets_status_check;
alter table public.lead_import_sheets add constraint lead_import_sheets_status_check
  check (status in ('importing','completed','deleting','deleted'));
alter table public.lead_import_sheets add column deletion_count integer
  check (deletion_count is null or deletion_count >= 0);

create index leads_active_import_sheet_id
  on public.leads(import_sheet_id, id) where import_sheet_id is not null and not is_archived;

create function public.delete_live_lead_import_batch(sheet_id uuid, batch_size integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare sheet public.lead_import_sheets; archived_rows integer; finished boolean; can_view_all boolean;
begin
  if not public.is_verified_session() or not public.has_permission('leads.import')
    or not public.has_permission('leads.delete')
    or not exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','super_admin'))
  then raise exception 'Administrator and lead delete permission required'; end if;
  if batch_size is null or batch_size not between 1 and 2000 then raise exception 'Invalid deletion batch size'; end if;
  select * into sheet from public.lead_import_sheets s where s.id = sheet_id
    and (s.created_by = auth.uid() or public.has_permission('users.view')) for update;
  if sheet.id is null or (sheet.status = 'deleted' and sheet.deletion_count is null) then
    raise exception 'Import sheet not found';
  end if;
  if sheet.status = 'deleted' then
    return jsonb_build_object('deleted',sheet.deletion_count,'done',true);
  end if;
  can_view_all := public.has_permission('users.view');
  if not can_view_all and exists (select 1 from public.leads l where l.import_sheet_id = sheet.id and not l.is_archived
    and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id)) is not true)
  then raise exception 'Some imported leads are outside your accessible scope'; end if;

  update public.lead_import_sheets s set status = 'deleting',
    deletion_count = coalesce(s.deletion_count, 0) where s.id = sheet.id;
  with selected as materialized (
    select l.id from public.leads l
    where l.import_sheet_id = sheet.id and not l.is_archived
    order by l.id limit batch_size for update
  )
  update public.leads l set is_archived = true, modified_by = auth.uid()
    from selected s where l.id = s.id
      and (can_view_all or l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id)) is true;
  get diagnostics archived_rows = row_count;
  if not can_view_all and exists (select 1 from public.leads l where l.import_sheet_id = sheet.id and not l.is_archived
    and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id)) is not true)
  then raise exception 'Some imported leads are outside your accessible scope'; end if;
  select not exists (select 1 from public.leads l where l.import_sheet_id = sheet.id and not l.is_archived)
    into finished;
  update public.lead_import_sheets s set
    deletion_count = s.deletion_count + archived_rows,
    status = case when finished then 'deleted' else 'deleting' end,
    deleted_at = case when finished then now() else null end
    where s.id = sheet.id returning * into sheet;
  return jsonb_build_object('deleted',sheet.deletion_count,'done',finished);
end $$;

create or replace function public.delete_live_lead_import(sheet_id uuid)
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
  if sheet.status = 'deleting' then raise exception 'Import sheet deletion is in progress'; end if;
  if exists (select 1 from public.leads l where l.import_sheet_id = sheet.id and not l.is_archived
    and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view')) is not true)
  then raise exception 'Some imported leads are outside your accessible scope'; end if;
  update public.leads set is_archived = true, modified_by = auth.uid()
    where import_sheet_id = sheet.id and not is_archived;
  get diagnostics archived_rows = row_count;
  update public.lead_import_sheets set status = 'deleted', deleted_at = now() where id = sheet.id;
  return archived_rows;
end $$;

revoke all on function public.delete_live_lead_import_batch(uuid,integer) from public, anon;
grant execute on function public.delete_live_lead_import_batch(uuid,integer) to authenticated;

commit;
