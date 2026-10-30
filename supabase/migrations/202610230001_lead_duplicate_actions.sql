begin;

insert into public.role_permissions(role,permission_key,allowed)
values('counselor','leads.merge',true)
on conflict(role,permission_key) do nothing;

create function public.lead_merge_in_bucket(owner_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select public.is_verified_session() and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.status = 'active' and p.deleted_at is null
      and (
        p.role in ('admin','super_admin')
        or (p.role in ('team_lead','manager') and public.user_in_scope(owner_id))
        or (p.role = 'counselor' and owner_id = p.id)
      )
  );
$$;
revoke all on function public.lead_merge_in_bucket(uuid) from public, anon;
grant execute on function public.lead_merge_in_bucket(uuid) to authenticated;

-- Cross-bucket discovery exposes only owner names, never hidden lead identifiers.
create function public.lead_duplicate_owners(lead_id uuid)
returns table(assignee text, merge_target_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare current_lead public.leads;
begin
  if not public.is_verified_session() or not public.has_permission('leads.view') then
    raise exception 'Lead view permission required';
  end if;
  select * into current_lead from public.leads l where l.id = lead_id
    and not l.is_archived and l.merged_into_id is null
    and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view'));
  if current_lead.id is null then raise exception 'Lead not found within your accessible scope'; end if;
  return query
    select coalesce(p.full_name,'Unassigned'),
      case when public.has_permission('leads.merge')
        and public.lead_merge_in_bucket(current_lead.assignee_id)
        and public.lead_merge_in_bucket(l.assignee_id) then l.id else null end
    from public.leads l left join public.profiles p on p.id = l.assignee_id
    where l.id <> current_lead.id and not l.is_archived and l.merged_into_id is null
      and (
        (nullif(current_lead.normalized_phone,'') is not null and l.normalized_phone = current_lead.normalized_phone)
        or (nullif(current_lead.normalized_email,'') is not null and l.normalized_email = current_lead.normalized_email)
      )
    order by p.full_name nulls last, l.id;
end;
$$;
revoke all on function public.lead_duplicate_owners(uuid) from public, anon;
grant execute on function public.lead_duplicate_owners(uuid) to authenticated;

create or replace function public.merge_live_leads(source_id uuid, target_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare source_row public.leads; target_row public.leads; relation record;
  moved jsonb := '{}'::jsonb; affected integer;
begin
  if not public.is_verified_session() or not public.has_permission('leads.merge') or not public.has_permission('leads.view') then
    raise exception 'Lead merge permission required';
  end if;
  if source_id is null or target_id is null or source_id = target_id then raise exception 'Choose two different leads'; end if;
  perform id from public.leads where id in (source_id,target_id) order by id for update;
  select * into source_row from public.leads where id = source_id;
  select * into target_row from public.leads where id = target_id;
  if source_row.id is null or target_row.id is null
    or source_row.is_archived or target_row.is_archived
    or source_row.merged_into_id is not null or target_row.merged_into_id is not null
    or not public.lead_merge_in_bucket(source_row.assignee_id)
    or not public.lead_merge_in_bucket(target_row.assignee_id)
    or (source_row.assignee_id = auth.uid() or public.user_in_scope(source_row.assignee_id) or public.has_permission('users.view')) is not true
    or (target_row.assignee_id = auth.uid() or public.user_in_scope(target_row.assignee_id) or public.has_permission('users.view')) is not true
  then raise exception 'Both leads must be active and within your accessible scope and merge bucket'; end if;
  if (
    (nullif(source_row.normalized_phone,'') is not null and source_row.normalized_phone = target_row.normalized_phone)
    or (nullif(source_row.normalized_email,'') is not null and source_row.normalized_email = target_row.normalized_email)
  ) is not true then raise exception 'Only leads with a matching phone number or email can be merged'; end if;

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
end;
$$;

commit;
