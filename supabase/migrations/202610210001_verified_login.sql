begin;

alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists deleted_at timestamptz;
alter table public.lead_stages add column if not exists color text;
update public.profiles p set email = u.email from auth.users u where u.id = p.id and p.email is null;

create table public.login_rate_limits (
  key text primary key,
  started_at timestamptz not null default now(),
  attempts integer not null default 1
);
create table public.login_challenges (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_hash text not null,
  encrypted_session text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null default now() + interval '10 minutes',
  ip_address text,
  location text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index on public.login_challenges (expires_at);
create table public.login_sessions (
  session_id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  email text not null,
  ip_address text,
  location text,
  user_agent text,
  signed_in_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 hours',
  signed_out_at timestamptz
);
create index on public.login_sessions (user_id, signed_in_at desc);
alter table public.login_rate_limits enable row level security;
alter table public.login_challenges enable row level security;
alter table public.login_sessions enable row level security;
revoke all on public.login_rate_limits, public.login_challenges from anon, authenticated;
revoke insert, update, delete on public.login_sessions from anon, authenticated;

create function public.allow_login_attempt(rate_key text, max_attempts integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare count_now integer;
begin
  insert into public.login_rate_limits as limits (key) values (rate_key)
  on conflict (key) do update set
    attempts = case when limits.started_at < now() - interval '15 minutes' then 1 else limits.attempts + 1 end,
    started_at = case when limits.started_at < now() - interval '15 minutes' then now() else limits.started_at end
  returning attempts into count_now;
  delete from public.login_rate_limits where started_at < now() - interval '1 day';
  delete from public.login_challenges where expires_at < now();
  return count_now <= max_attempts;
end; $$;
revoke all on function public.allow_login_attempt(text, integer) from public, anon, authenticated;
grant execute on function public.allow_login_attempt(text, integer) to service_role;

create function public.consume_login_challenge(challenge_id text, supplied_hash text)
returns setof public.login_challenges language plpgsql security definer set search_path = public as $$
declare challenge public.login_challenges;
begin
  select * into challenge from public.login_challenges where id = challenge_id for update;
  if not found then return; end if;
  if challenge.expires_at <= now() or challenge.attempts >= 5 then
    delete from public.login_challenges where id = challenge_id;
    return;
  end if;
  if challenge.code_hash <> supplied_hash then
    update public.login_challenges set attempts = attempts + 1 where id = challenge_id;
    return;
  end if;
  delete from public.login_challenges where id = challenge_id;
  return next challenge;
end; $$;
revoke all on function public.consume_login_challenge(text, text) from public, anon, authenticated;
grant execute on function public.consume_login_challenge(text, text) to service_role;

create function public.is_verified_session()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.login_sessions s join public.profiles p on p.id = s.user_id
    where s.user_id = auth.uid() and s.session_id::text = auth.jwt()->>'session_id'
      and s.signed_out_at is null and s.expires_at > now()
      and p.status = 'active' and p.deleted_at is null
  );
$$;
revoke all on function public.is_verified_session() from public, anon;
grant execute on function public.is_verified_session() to authenticated;

create function public.touch_login_session()
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public.is_verified_session() then return false; end if;
  update public.login_sessions set last_seen_at = now()
    where session_id::text = auth.jwt()->>'session_id' and user_id = auth.uid()
      and last_seen_at < now() - interval '1 minute';
  return true;
end; $$;
create function public.end_login_session()
returns void language sql security definer set search_path = public as $$
  update public.login_sessions set signed_out_at = now(), last_seen_at = now()
    where session_id::text = auth.jwt()->>'session_id' and user_id = auth.uid() and signed_out_at is null;
$$;
revoke all on function public.touch_login_session(), public.end_login_session() from public, anon;
grant execute on function public.touch_login_session(), public.end_login_session() to authenticated;

create function public.is_crm_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_verified_session() and exists (
    select 1 from public.profiles where id = auth.uid() and role in ('admin', 'super_admin')
      and status = 'active' and deleted_at is null
  );
$$;
revoke all on function public.is_crm_admin() from public, anon;
grant execute on function public.is_crm_admin() to authenticated;
create policy "Admins read login activity" on public.login_sessions for select to authenticated
using (public.is_crm_admin());

create or replace function public.has_permission(required_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_verified_session() and exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.deleted_at is null
    and (required_permission <> 'users.manage' or p.role = 'super_admin')
    and (required_permission <> 'reports.export' or p.role in ('manager', 'admin', 'super_admin'))
    and (p.role = 'super_admin' or coalesce(
      (select allowed from public.user_permission_overrides where user_id = p.id and permission_key = required_permission),
      (select allowed from public.role_permissions where role = p.role and permission_key = required_permission), false))
  );
$$;
create function public.my_permissions()
returns setof text language sql stable security definer set search_path = public as $$
  select distinct permission_key from (
    select permission_key from public.role_permissions
    union select permission_key from public.user_permission_overrides
  ) keys where public.has_permission(permission_key);
$$;
revoke all on function public.my_permissions() from public, anon;
grant execute on function public.my_permissions() to authenticated;

commit;
