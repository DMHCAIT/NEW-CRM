begin;

create function public.guard_profile_hierarchy()
returns trigger language plpgsql security definer set search_path = public as $$
declare auth_email text;
begin
  perform pg_advisory_xact_lock(hashtextextended('crm.profile-hierarchy',0));
  select email into auth_email from auth.users where id = new.id;
  if new.email is null then new.email := auth_email; end if;
  if lower(new.email) is distinct from lower(auth_email) then raise exception 'Profile email must match the Auth account'; end if;
  if new.reporting_to is not null and exists (
    with recursive ancestors as (
      select id,reporting_to from public.profiles where id = new.reporting_to
      union
      select p.id,p.reporting_to from public.profiles p join ancestors a on a.reporting_to = p.id
    ) select 1 from ancestors where id = new.id
  ) then raise exception 'Reporting hierarchy cannot contain a cycle'; end if;
  if new.reporting_to = new.id then raise exception 'A user cannot report to themselves'; end if;
  if tg_op = 'UPDATE' and old.role = 'super_admin' and old.status = 'active' and old.deleted_at is null
    and (new.role <> 'super_admin' or new.status <> 'active' or new.deleted_at is not null)
    and not exists (select 1 from public.profiles where id <> new.id and role = 'super_admin' and status = 'active' and deleted_at is null)
    then raise exception 'The last active Super Admin cannot be deactivated or demoted'; end if;
  return new;
end; $$;
create trigger guard_profile_hierarchy before insert or update on public.profiles
for each row execute function public.guard_profile_hierarchy();

create function public.admin_user_last_activity()
returns table(user_id uuid,signed_in_at timestamptz,last_seen_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select s.user_id,max(s.signed_in_at),max(s.last_seen_at)
  from public.login_sessions s where public.is_crm_admin() group by s.user_id;
$$;
revoke all on function public.admin_user_last_activity() from public, anon;
grant execute on function public.admin_user_last_activity() to authenticated;

create table public.password_setup_tokens (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '30 minutes'
);
alter table public.password_setup_tokens enable row level security;
revoke all on public.password_setup_tokens from anon, authenticated;
create function public.consume_password_setup(token_hash text)
returns uuid language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('crm.password-setup',0));
  delete from public.password_setup_tokens where expires_at < now();
  delete from public.password_setup_tokens where id = token_hash and expires_at > now() returning user_id into target;
  if target is not null then delete from public.password_setup_tokens where user_id = target; end if;
  return target;
end; $$;
revoke all on function public.consume_password_setup(text) from public, anon, authenticated;
grant execute on function public.consume_password_setup(text) to service_role;

create function public.save_access_configuration(target_role public.crm_role, target_user uuid, grants jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare entry record; target_user_role public.crm_role;
begin
  if not public.has_permission('access.manage') then raise exception 'Access denied' using errcode = '42501'; end if;
  if (target_role is null) = (target_user is null) then raise exception 'Choose a role or user'; end if;
  if jsonb_typeof(grants) <> 'object' then raise exception 'Invalid permission grants'; end if;
  if target_user is not null then
    select role into target_user_role from public.profiles where id = target_user and deleted_at is null;
    if not found then raise exception 'User not found'; end if;
    if target_user_role = 'super_admin' then raise exception 'Super Admin grants cannot be changed'; end if;
  else
    target_user_role := target_role;
    if target_role = 'super_admin' then raise exception 'Super Admin grants cannot be changed'; end if;
  end if;
  for entry in select key, value from jsonb_each(grants) loop
    if jsonb_typeof(entry.value) <> 'boolean' or not exists (
      select 1 from public.role_permissions where permission_key = entry.key
    ) then raise exception 'Invalid permission'; end if;
    if entry.key = 'users.manage' and entry.value = 'true'::jsonb then raise exception 'Only Super Admin can manage users'; end if;
    if entry.key = 'reports.export' and entry.value = 'true'::jsonb and target_user_role not in ('manager','admin','super_admin')
      then raise exception 'This role cannot export reports'; end if;
  end loop;
  if target_user is not null then
    delete from public.user_permission_overrides where user_id = target_user;
    insert into public.user_permission_overrides(user_id,permission_key,allowed,updated_by)
    select target_user,key,(value::text)::boolean,auth.uid() from jsonb_each(grants);
  else
    insert into public.role_permissions(role,permission_key,allowed,updated_by)
    select target_role,key,(value::text)::boolean,auth.uid() from jsonb_each(grants)
    on conflict (role,permission_key) do update set allowed = excluded.allowed, updated_by = auth.uid(), updated_at = now();
  end if;
  insert into public.audit_logs(actor_id,action,entity_type,entity_id,changes)
    values(auth.uid(),'access.updated',case when target_user is null then 'role' else 'user' end,
      coalesce(target_user::text,target_role::text),grants);
end; $$;
revoke all on function public.save_access_configuration(public.crm_role,uuid,jsonb) from public, anon;
grant execute on function public.save_access_configuration(public.crm_role,uuid,jsonb) to authenticated;

create function public.save_crm_configuration(stage_rows jsonb, settings_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare row_value jsonb; keep_ids uuid[] := '{}'; stage_id uuid; position integer := 0;
begin
  if not public.has_permission('settings.manage') then raise exception 'Access denied' using errcode = '42501'; end if;
  if jsonb_typeof(stage_rows) <> 'array' or jsonb_array_length(stage_rows) = 0 then raise exception 'At least one stage is required'; end if;
  if jsonb_typeof(settings_value) <> 'object' then raise exception 'Invalid settings'; end if;
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

commit;
