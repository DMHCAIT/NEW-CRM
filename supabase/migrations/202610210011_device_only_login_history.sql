begin;

alter table public.login_sessions add column device text not null default 'Unknown device';
alter table public.login_challenges add column device text not null default 'Unknown device';

do $$
declare target text;
begin
  foreach target in array array['login_sessions', 'login_challenges'] loop
    execute format($sql$
      update public.%I set device = case
        when user_agent ~* 'ipad|macintosh.*mobile' then 'iPad'
        when user_agent ~* 'iphone|ipod' then 'iPhone'
        when user_agent ~* 'android' and user_agent ~* 'mobile' then 'Android phone'
        when user_agent ~* 'android' then 'Android tablet'
        when user_agent ~* 'windows' then 'Windows computer'
        when user_agent ~* 'cros' then 'Chromebook'
        when user_agent ~* 'macintosh|mac os x' then 'Mac'
        when user_agent ~* 'linux' then 'Linux computer'
        else 'Unknown device' end
    $sql$, target);
  end loop;
end;
$$;

alter table public.login_sessions drop column ip_address, drop column location, drop column user_agent;
alter table public.login_challenges drop column ip_address, drop column location, drop column user_agent;

-- Remove short-lived rate-limit hashes previously derived from network addresses.
delete from public.login_rate_limits;

commit;
