begin;

-- Keep historical profile references when the corresponding login is removed.
alter table public.profiles drop constraint profiles_id_fkey;

create function public.retire_deleted_login()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set status = 'inactive', deleted_at = now(), updated_at = now()
    where id = old.id;
  update public.login_sessions set signed_out_at = coalesce(signed_out_at, now())
    where user_id = old.id;
  delete from public.gmail_oauth_states where user_id = old.id;
  delete from public.gmail_connections where user_id = old.id;
  return old;
end;
$$;
revoke all on function public.retire_deleted_login() from public, anon, authenticated;
create trigger retire_deleted_login before delete on auth.users
  for each row execute function public.retire_deleted_login();

commit;
