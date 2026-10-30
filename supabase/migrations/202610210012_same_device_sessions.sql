begin;

alter table public.login_challenges add column device_id text;
alter table public.login_sessions add column device_id text;

create unique index login_sessions_one_per_device
  on public.login_sessions(user_id, device_id)
  where signed_out_at is null and device_id is not null;

create function public.replace_same_device_session()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.device_id is null then return new; end if;
  -- Serialize verified logins for this account before replacing a device session.
  perform 1 from public.profiles where id = new.user_id for update;
  update public.login_sessions set signed_out_at = now()
    where user_id = new.user_id and device_id = new.device_id
      and signed_out_at is null;
  return new;
end;
$$;
revoke all on function public.replace_same_device_session() from public, anon, authenticated;

create trigger replace_same_device_session
before insert on public.login_sessions
for each row execute function public.replace_same_device_session();

commit;
