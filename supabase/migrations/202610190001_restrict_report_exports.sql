begin;

update public.role_permissions
set allowed = false
where role in ('counselor', 'team_lead')
  and permission_key = 'reports.export';

create or replace function public.has_permission(required_permission text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active') then false
    when required_permission = 'reports.export' and not exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.status = 'active'
        and p.role in ('manager', 'admin', 'super_admin')
    ) then false
    when exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin' and p.status = 'active') then true
    else coalesce(
      (select upo.allowed
       from public.user_permission_overrides upo
       where upo.user_id = auth.uid()
         and upo.permission_key = required_permission),
      (select rp.allowed
       from public.profiles p
       join public.role_permissions rp on rp.role = p.role
       where p.id = auth.uid()
         and p.status = 'active'
         and rp.permission_key = required_permission),
      false
    )
  end;
$$;

commit;
