begin;

alter table public.leads add column call_schedule_revision bigint not null default 0;
alter table public.scheduled_calls add column schedule_revision bigint not null default 0;
alter table public.scheduled_calls add column updated_at timestamptz;

create or replace function public.track_lead_edit()
returns trigger language plpgsql set search_path = public as $$
begin
  if (to_jsonb(new) - array['modified_at','modified_by','edited_at','has_been_edited','call_schedule_revision'])
    is distinct from (to_jsonb(old) - array['modified_at','modified_by','edited_at','has_been_edited','call_schedule_revision']) then
    new.has_been_edited := true;
    new.modified_at := clock_timestamp();
    new.edited_at := case when old.edited_at is null then null else old.edited_at || new.modified_at end;
    new.modified_by := coalesce(auth.uid(),new.modified_by);
  end if;
  return new;
end;
$$;

create function public.track_lead_schedule_revision()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (to_jsonb(new) - array['modified_at','modified_by','edited_at','has_been_edited','call_schedule_revision','normalized_phone','normalized_email'])
    is distinct from (to_jsonb(old) - array['modified_at','modified_by','edited_at','has_been_edited','call_schedule_revision','normalized_phone','normalized_email']) then
    new.call_schedule_revision := old.call_schedule_revision + 1;
  elsif new.call_schedule_revision is distinct from old.call_schedule_revision then
    if current_user <> (select pg_get_userbyid(relowner) from pg_class where oid = 'public.leads'::regclass) then
      raise exception 'Call scheduling revision is managed by the CRM';
    end if;
  end if;
  return new;
end;
$$;
create trigger track_lead_schedule_revision before update on public.leads
for each row execute function public.track_lead_schedule_revision();

create or replace function public.audit_live_lead_changes()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare changes jsonb; actor text;
begin
  select full_name into actor from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then
    insert into public.activities(lead_id,user_id,type,description,meta)
      values(new.id,auth.uid(),'created','Lead created',jsonb_build_object('actor_name',actor));
  else
    select coalesce(jsonb_object_agg(n.key,jsonb_build_object('before',o.value,'after',n.value)),'{}'::jsonb)
      into changes
      from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o on n.key = o.key
      where n.value is distinct from o.value
        and n.key not in ('modified_at','modified_by','edited_at','has_been_edited','normalized_phone','normalized_email','call_schedule_revision');
    if changes <> '{}'::jsonb then
      if changes ? 'assignee_id' then
        changes := jsonb_set(changes,'{assignee_id}',changes->'assignee_id' || jsonb_build_object(
          'before_label',coalesce((select full_name from public.profiles where id = old.assignee_id),'Unassigned'),
          'after_label',coalesce((select full_name from public.profiles where id = new.assignee_id),'Unassigned')));
      end if;
      if changes ? 'stage_id' then
        changes := jsonb_set(changes,'{stage_id}',changes->'stage_id' || jsonb_build_object(
          'before_label',coalesce((select name from public.lead_stages where id = old.stage_id),'Not set'),
          'after_label',coalesce((select name from public.lead_stages where id = new.stage_id),'Not set')));
      end if;
      insert into public.activities(lead_id,user_id,type,description,meta)
        values(coalesce(new.merged_into_id,new.id),auth.uid(),'updated',
          case when new.merged_into_id is distinct from old.merged_into_id then 'Lead merged and archived'
            when new.is_archived and not old.is_archived then 'Lead archived'
            when new.assignee_id is distinct from old.assignee_id then 'Lead transferred'
            when new.stage_id is distinct from old.stage_id then 'Lead stage changed'
            else 'Lead details updated' end,
          jsonb_build_object('actor_name',actor,'changes',changes,
            'previous_stage_id',old.stage_id,'stage_id',new.stage_id,
            'previous_assignee_id',old.assignee_id,'assignee_id',new.assignee_id));
    end if;
  end if;
  return new;
end;
$$;

create function public.guard_scheduled_call_workflow()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare lead_row public.leads; last_revision bigint; actor text;
begin
  if auth.uid() is null then return new; end if;
  if not public.has_permission('leads.edit') then raise exception 'Lead edit permission required'; end if;
  select * into lead_row from public.leads where id = new.lead_id for update;
  if lead_row.id is null or lead_row.is_archived
    or (lead_row.assignee_id = auth.uid() or public.user_in_scope(lead_row.assignee_id) or public.has_permission('users.view')) is not true
    then raise exception 'Lead not found within your accessible scope'; end if;
  if tg_op = 'INSERT' then
    select schedule_revision into last_revision from public.scheduled_calls
      where lead_id = new.lead_id order by created_at desc,id desc limit 1;
    if last_revision is not null and last_revision >= lead_row.call_schedule_revision then
      raise exception 'Update this lead or reschedule, complete, or cancel an existing call before scheduling another';
    end if;
    if new.user_id <> auth.uid() or new.status <> 'scheduled' or new.scheduled_at <= clock_timestamp() then
      raise exception 'Choose a future call date and schedule it for yourself';
    end if;
    new.schedule_revision := lead_row.call_schedule_revision;
    new.created_at := clock_timestamp();
  elsif new.scheduled_at is distinct from old.scheduled_at or new.status is distinct from old.status then
    if old.status <> 'scheduled' or new.status not in ('scheduled','completed','cancelled') then
      raise exception 'Only scheduled calls can be rescheduled, completed or cancelled';
    end if;
    if new.status = 'scheduled' and new.scheduled_at <= clock_timestamp() then raise exception 'Choose a future call date'; end if;
    new.updated_at := clock_timestamp();
    update public.leads set call_schedule_revision = call_schedule_revision + 1 where id = new.lead_id;
  end if;
  return new;
end;
$$;
create trigger guard_scheduled_call_workflow before insert or update of scheduled_at,status on public.scheduled_calls
for each row execute function public.guard_scheduled_call_workflow();

create function public.protect_scheduled_call_metadata()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null
    and current_user <> (select pg_get_userbyid(relowner) from pg_class where oid = 'public.scheduled_calls'::regclass)
    and (new.lead_id,new.user_id,new.created_at,new.schedule_revision) is distinct from (old.lead_id,old.user_id,old.created_at,old.schedule_revision)
    then raise exception 'Call ownership and scheduling metadata are managed by the CRM'; end if;
  return new;
end;
$$;
create trigger protect_scheduled_call_metadata before update on public.scheduled_calls
for each row execute function public.protect_scheduled_call_metadata();

create function public.audit_scheduled_call_workflow()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare actor text;
begin
  select full_name into actor from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then
    insert into public.activities(lead_id,user_id,type,description,meta)
      values(new.lead_id,auth.uid(),'call','Call scheduled',jsonb_build_object('actor_name',actor,'changes',
        jsonb_build_object('scheduled_at',jsonb_build_object('before',null,'after',new.scheduled_at))));
  elsif new.lead_id = old.lead_id and (new.scheduled_at is distinct from old.scheduled_at or new.status is distinct from old.status) then
    insert into public.activities(lead_id,user_id,type,description,meta)
      values(new.lead_id,auth.uid(),'call',
        case new.status when 'completed' then 'Call marked completed' when 'cancelled' then 'Call cancelled' else 'Call rescheduled' end,
        jsonb_build_object('actor_name',actor,'changes',jsonb_build_object(
          'scheduled_at',jsonb_build_object('before',old.scheduled_at,'after',new.scheduled_at),
          'status',jsonb_build_object('before',old.status,'after',new.status))));
  end if;
  return new;
end;
$$;
create trigger audit_scheduled_call_workflow after insert or update on public.scheduled_calls
for each row execute function public.audit_scheduled_call_workflow();

create function public.update_lead_scheduled_call(lead_id uuid, call_id uuid, new_status text, new_time timestamptz default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.has_permission('leads.edit') then raise exception 'Lead edit permission required'; end if;
  perform id from public.leads where id = lead_id for update;
  update public.scheduled_calls set status = new_status, scheduled_at = coalesce(new_time,scheduled_at)
    where id = call_id and scheduled_calls.lead_id = update_lead_scheduled_call.lead_id and status = 'scheduled';
  if not found then raise exception 'Scheduled call not found or already closed'; end if;
end;
$$;
revoke all on function public.update_lead_scheduled_call(uuid,uuid,text,timestamptz) from public, anon;
grant execute on function public.update_lead_scheduled_call(uuid,uuid,text,timestamptz) to authenticated;

commit;
