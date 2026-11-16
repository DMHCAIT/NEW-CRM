begin;

create table public.pending_lead_stage_assignments (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  token uuid not null,
  stage_id uuid not null references public.lead_stages(id) on delete cascade,
  assignee_id uuid references public.profiles(id),
  requested_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);
alter table public.pending_lead_stage_assignments enable row level security;
revoke all on public.pending_lead_stage_assignments from public, anon, authenticated;
grant select on public.pending_lead_stage_assignments to authenticated;
grant all on public.pending_lead_stage_assignments to service_role;
create policy "Read own accessible pending assignments" on public.pending_lead_stage_assignments
  for select to authenticated using (
    public.is_verified_session() and public.has_permission('leads.edit')
    and requested_by = auth.uid()
    and exists (select 1 from public.leads where id = lead_id and not is_archived)
  );

create or replace function public.automatic_stage_lead_assignment()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_stage_name text;
  v_rule_key text;
  v_token text;
begin
  if tg_op = 'UPDATE' then
    if new.is_archived or new.assignee_id is distinct from old.assignee_id
      or new.stage_id is distinct from old.stage_id then
      delete from public.pending_lead_stage_assignments where lead_id = new.id;
    end if;
    if new.is_archived then return new; end if;
    if new.stage_id is not distinct from old.stage_id then
      if current_setting('crm.finalize_stage_assignment_lead', true) is distinct from new.id::text then return new; end if;
      delete from public.pending_lead_stage_assignments
        where lead_id = new.id
          and token::text = current_setting('crm.finalize_stage_assignment_token', true)
          and requested_by = auth.uid() and stage_id = new.stage_id
          and assignee_id is not distinct from new.assignee_id;
      if not found then return new; end if;
    end if;
  end if;
  select lower(name) into v_stage_name from public.lead_stages where id = new.stage_id;
  v_rule_key := case v_stage_name
    when 'junk' then 'junk'
    when 'not interested' then 'not_interested'
    when 'closed won' then 'closed_won'
    when 'cold' then 'cold'
    else null
  end;
  if v_rule_key is null then return new; end if;
  if tg_op = 'UPDATE' and new.stage_id is distinct from old.stage_id
    and v_rule_key in ('cold','junk','not_interested')
    and current_setting('crm.defer_stage_assignment_lead', true) = new.id::text
    and public.is_verified_session()
  then
    if exists (select 1 from public.lead_assignment_automations where rule_key = v_rule_key and enabled) then
      v_token := nullif(current_setting('crm.defer_stage_assignment_token', true), '');
      if v_token is null then raise exception 'Missing deferred assignment token'; end if;
      insert into public.pending_lead_stage_assignments(lead_id,token,stage_id,assignee_id,requested_by)
        values(new.id,v_token::uuid,new.stage_id,new.assignee_id,auth.uid());
    end if;
    return new;
  end if;
  perform public.apply_lead_assignment_automation(new.id, v_rule_key);
  return new;
end;
$$;

drop trigger automatic_stage_lead_assignment_update on public.leads;
create trigger automatic_stage_lead_assignment_update
  after update of stage_id, assignee_id, is_archived on public.leads
  for each row execute function public.automatic_stage_lead_assignment();

create function public.save_lead_with_deferred_assignment(p_lead_id uuid, p_changes jsonb, p_token uuid)
returns table(lead jsonb, assignment_pending_id uuid)
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_columns text;
  v_lead public.leads;
begin
  if not public.is_verified_session() or not public.has_permission('leads.edit') then
    raise exception 'Lead edit permission required';
  end if;
  if p_token is null or jsonb_typeof(p_changes) is distinct from 'object' or not p_changes ? 'stage_id'
    or exists (
      select 1 from jsonb_object_keys(p_changes) key
      where key <> all(array['name','phone','normalized_phone','country_code','alt_phone','email','normalized_email',
        'country','billing_address','course','qualification','speciality','category','source','stage_id','assignee_id',
        'next_followup_at','closure_fee','expected_closure_date','custom_fields','modified_by'])
    ) then raise exception 'Invalid deferred lead update'; end if;
  p_changes := p_changes || jsonb_build_object('modified_by', auth.uid());
  select string_agg(format('%I',key),',' order by key) into v_columns from jsonb_object_keys(p_changes) key;
  perform set_config('crm.defer_stage_assignment_lead', p_lead_id::text, true);
  perform set_config('crm.defer_stage_assignment_token', p_token::text, true);
  execute format(
    'update public.leads set (%1$s) = (select %1$s from jsonb_populate_record(null::public.leads,$1))
     where id=$2 and not is_archived returning *', v_columns)
    into v_lead using p_changes, p_lead_id;
  perform set_config('crm.defer_stage_assignment_lead', '', true);
  perform set_config('crm.defer_stage_assignment_token', '', true);
  if v_lead.id is null then raise exception 'Lead update was not permitted'; end if;
  return query select to_jsonb(v_lead),
    (select pending.token from public.pending_lead_stage_assignments pending where pending.lead_id = p_lead_id);
end;
$$;

create function public.finish_lead_stage_assignment(p_lead_id uuid, p_token uuid)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if not public.is_verified_session() or not public.has_permission('leads.edit') then
    raise exception 'Lead edit permission required';
  end if;
  if p_token is null then raise exception 'Missing deferred assignment token'; end if;
  if not exists (select 1 from public.pending_lead_stage_assignments where lead_id = p_lead_id and token = p_token) then
    return false;
  end if;
  perform set_config('crm.finalize_stage_assignment_lead', p_lead_id::text, true);
  perform set_config('crm.finalize_stage_assignment_token', p_token::text, true);
  -- The no-op stage write preserves RLS and runs assignment inside the trusted trigger.
  update public.leads set stage_id = stage_id where id = p_lead_id and not is_archived;
  perform set_config('crm.finalize_stage_assignment_lead', '', true);
  perform set_config('crm.finalize_stage_assignment_token', '', true);
  return true;
end;
$$;

revoke all on function public.save_lead_with_deferred_assignment(uuid,jsonb,uuid),
  public.finish_lead_stage_assignment(uuid,uuid) from public, anon;
grant execute on function public.save_lead_with_deferred_assignment(uuid,jsonb,uuid),
  public.finish_lead_stage_assignment(uuid,uuid) to authenticated;

commit;
