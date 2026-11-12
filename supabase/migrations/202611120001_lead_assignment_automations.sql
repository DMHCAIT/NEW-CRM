begin;

create table public.lead_assignment_automations (
  rule_key text primary key check (rule_key in ('facebook','website','junk','not_interested','closed_won')),
  enabled boolean not null default false,
  strategy text not null default 'single' check (strategy in ('single','round_robin')),
  owner_ids uuid[] not null default '{}',
  next_owner_index integer not null default 0 check (next_owner_index >= 0),
  updated_at timestamptz not null default now(),
  check (cardinality(owner_ids) <= 100)
);

insert into public.lead_assignment_automations(rule_key)
values ('facebook'), ('website'), ('junk'), ('not_interested'), ('closed_won');

update public.lead_assignment_automations
  set enabled = true,
      owner_ids = array(
        select id from public.profiles
        where lower(btrim(full_name)) = 'aluri srikanth'
          and status = 'active' and deleted_at is null
        order by id
        limit 1
      )
  where rule_key = 'facebook'
    and exists (
      select 1 from public.profiles
      where lower(btrim(full_name)) = 'aluri srikanth'
        and status = 'active' and deleted_at is null
    );

alter table public.lead_assignment_automations enable row level security;
revoke all on public.lead_assignment_automations from public, anon, authenticated;
grant all on public.lead_assignment_automations to service_role;

create function public.apply_lead_assignment_automation(p_lead_id uuid, p_rule_key text, p_notify boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_rule public.lead_assignment_automations;
  v_owners uuid[];
  v_owner uuid;
  v_index integer;
  v_name text;
begin
  select * into v_rule
    from public.lead_assignment_automations
    where rule_key = p_rule_key
    for update;
  if not found or not v_rule.enabled then return null; end if;

  select array_agg(candidate.user_id order by candidate.position)
    into v_owners
    from unnest(v_rule.owner_ids) with ordinality as candidate(user_id, position)
    join public.profiles profile on profile.id = candidate.user_id
    where profile.status = 'active' and profile.deleted_at is null;
  if coalesce(cardinality(v_owners), 0) = 0 then
    raise exception 'Assignment automation % has no active users. Update it in Automations.', p_rule_key;
  end if;

  v_index := case when v_rule.strategy = 'round_robin'
    then (v_rule.next_owner_index % cardinality(v_owners)) + 1 else 1 end;
  v_owner := v_owners[v_index];
  if v_rule.strategy = 'round_robin' then
    update public.lead_assignment_automations
      set next_owner_index = v_index % cardinality(v_owners), updated_at = now()
      where rule_key = p_rule_key;
  end if;

  select name into v_name from public.leads where id = p_lead_id for update;
  if not found then raise exception 'Lead for assignment automation was not found.'; end if;
  update public.leads set assignee_id = v_owner where id = p_lead_id;

  if p_notify then
    insert into public.notifications(user_id, type, payload, lead_id, event_key)
      values (v_owner, 'lead_assigned',
        jsonb_build_object('message', 'New website lead assigned to you: ' || v_name, 'lead_id', p_lead_id, 'lead_name', v_name),
        p_lead_id, 'lead-assignment:' || gen_random_uuid()::text);
  end if;
  return v_owner;
end;
$$;
revoke all on function public.apply_lead_assignment_automation(uuid,text,boolean) from public, anon, authenticated;

create function public.automatic_stage_lead_assignment()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_stage_name text;
  v_rule_key text;
begin
  if tg_op = 'UPDATE' and new.stage_id is not distinct from old.stage_id then return new; end if;
  select lower(name) into v_stage_name from public.lead_stages where id = new.stage_id;
  v_rule_key := case v_stage_name
    when 'junk' then 'junk'
    when 'not interested' then 'not_interested'
    when 'closed won' then 'closed_won'
    else null
  end;
  if v_rule_key is not null then
    perform public.apply_lead_assignment_automation(new.id, v_rule_key);
  end if;
  return new;
end;
$$;
revoke all on function public.automatic_stage_lead_assignment() from public, anon, authenticated;

create trigger automatic_stage_lead_assignment_insert
  after insert on public.leads
  for each row execute function public.automatic_stage_lead_assignment();
create trigger automatic_stage_lead_assignment_update
  after update of stage_id on public.leads
  for each row execute function public.automatic_stage_lead_assignment();

create function public.automatic_intake_lead_assignment()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_channel text;
  v_stage_id uuid;
  v_stage_name text;
  v_stage_rule text;
  v_rule_key text;
  v_assignee_id uuid;
  v_lead_name text;
begin
  if new.status <> 'created' or new.lead_id is null or new.source_id is null then return new; end if;
  select settings.channel, lead.stage_id
    into v_channel, v_stage_id
    from public.intake_source_settings settings
    join public.leads lead on lead.id = new.lead_id
    where settings.source_id = new.source_id;
  if not found then return new; end if;

  select lower(name) into v_stage_name from public.lead_stages where id = v_stage_id;
  v_stage_rule := case v_stage_name
    when 'junk' then 'junk'
    when 'not interested' then 'not_interested'
    when 'closed won' then 'closed_won'
    else null
  end;
  if v_stage_rule is not null and exists (
    select 1 from public.lead_assignment_automations where rule_key = v_stage_rule and enabled
  ) then
    if v_channel in ('website','chatbot') then
      select assignee_id, name into v_assignee_id, v_lead_name from public.leads where id = new.lead_id;
      if v_assignee_id is not null then
        insert into public.notifications(user_id, type, payload, lead_id, event_key)
          values (v_assignee_id, 'lead_assigned',
            jsonb_build_object('message', 'New website lead assigned to you: ' || v_lead_name, 'lead_id', new.lead_id, 'lead_name', v_lead_name),
            new.lead_id, 'lead-assignment:' || gen_random_uuid()::text);
      end if;
    end if;
    return new;
  end if;

  v_rule_key := case v_channel
    when 'facebook' then 'facebook'
    when 'website' then 'website'
    when 'chatbot' then 'website'
    else null
  end;
  if v_rule_key is not null then
    perform public.apply_lead_assignment_automation(new.lead_id, v_rule_key, v_rule_key = 'website');
  end if;
  return new;
end;
$$;
revoke all on function public.automatic_intake_lead_assignment() from public, anon, authenticated;

create trigger automatic_intake_lead_assignment
  after insert on public.inbound_events
  for each row execute function public.automatic_intake_lead_assignment();

create or replace function public.crm_notification_snapshot()
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare result jsonb;
begin
  perform public.release_my_due_call_notifications();
  select jsonb_build_object(
    'notifications',coalesce((select jsonb_agg(n order by n.created_at desc,n.id desc) from (
      select id,type,payload,lead_id,is_read,created_at from public.notifications
      where user_id=auth.uid() and type in ('call_due','lead_assigned') and not is_read
      order by created_at desc,id desc limit 100) n),'[]'::jsonb),
    'unread',(select count(*) from public.notifications
      where user_id=auth.uid() and type in ('call_due','lead_assigned') and not is_read)
  ) into result;
  return result;
end;
$$;

commit;
