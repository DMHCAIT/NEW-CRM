begin;

-- Restrictive policies also cover direct REST requests with a password-only Supabase token.
do $$
declare target record;
begin
  for target in select tablename from pg_tables
    where schemaname = 'public' and rowsecurity
      and tablename not in ('login_challenges','login_rate_limits','password_setup_tokens')
  loop
    execute format('create policy "Require verified CRM session" on public.%I as restrictive for all to authenticated using (public.is_verified_session()) with check (public.is_verified_session())',target.tablename);
  end loop;
end; $$;

commit;
