update public.role_permissions
set allowed = false
where role in ('counselor', 'team_lead') and permission_key = 'meetings.manage';

with duplicates as (
  select ctid, row_number() over (partition by meeting_id, user_id order by ctid) as row_num
  from public.meeting_attendees
  where user_id is not null
)
delete from public.meeting_attendees attendees
using duplicates
where attendees.ctid = duplicates.ctid and duplicates.row_num > 1;

create unique index if not exists meeting_attendees_meeting_user_unique
  on public.meeting_attendees (meeting_id, user_id);
create index if not exists meeting_attendees_user_id_idx
  on public.meeting_attendees (user_id);

alter table public.meetings add column if not exists calendar_sequence integer not null default 0;
alter table public.meetings add column if not exists agenda text;

create or replace function public.is_meeting_attendee(p_meeting_id uuid)
returns boolean
language sql stable security definer
set search_path = public
set row_security = off
as $$
  select exists (
    select 1 from public.meeting_attendees a
    where a.meeting_id = p_meeting_id and a.user_id = auth.uid()
  );
$$;
revoke all on function public.is_meeting_attendee(uuid) from public;
grant execute on function public.is_meeting_attendee(uuid) to authenticated;

drop policy if exists "Users read meetings within scope" on public.meetings;
create policy "Users read internal meetings" on public.meetings for select to authenticated
using (
  public.has_permission('meetings.view') and (
    host_id = auth.uid()
    or public.is_meeting_attendee(id)
    or public.has_permission('users.view')
    or public.user_in_scope(host_id)
  )
);

drop policy if exists "Users read attendees for visible meetings" on public.meeting_attendees;
drop policy if exists "Users manage attendees for hosted meetings" on public.meeting_attendees;
drop policy if exists "Hosts insert attendees for hosted meetings" on public.meeting_attendees;
drop policy if exists "Hosts delete attendees for hosted meetings" on public.meeting_attendees;
create policy "Users read own meeting attendees" on public.meeting_attendees for select to authenticated
using (
  user_id = auth.uid()
  or exists (select 1 from public.meetings m where m.id = meeting_id and m.host_id = auth.uid())
  or public.has_permission('users.view')
);
create policy "Hosts insert attendees for hosted meetings" on public.meeting_attendees for insert to authenticated
with check (
  user_id is not null
  and public.has_permission('meetings.manage')
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager','admin','super_admin') and p.status = 'active' and p.deleted_at is null)
  and exists (select 1 from public.meetings m where m.id = meeting_id and m.host_id = auth.uid())
);
create policy "Hosts delete attendees for hosted meetings" on public.meeting_attendees for delete to authenticated
using (
  public.has_permission('meetings.manage')
  and exists (select 1 from public.meetings m where m.id = meeting_id and m.host_id = auth.uid())
);


drop policy if exists "Hosts update meetings" on public.meetings;
create policy "Hosts and admins update meetings" on public.meetings for update to authenticated
using ((public.has_permission('meetings.manage') and host_id = auth.uid()) or public.has_permission('users.manage') or public.has_permission('access.manage'))
with check ((public.has_permission('meetings.manage') and host_id = auth.uid()) or public.has_permission('users.manage') or public.has_permission('access.manage'));


drop policy if exists "Users create meetings within scope" on public.meetings;
create policy "Authorized staff create meetings" on public.meetings for insert to authenticated
with check (
  public.has_permission('meetings.manage')
  and host_id = auth.uid()
  and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('manager','admin','super_admin') and p.status = 'active')
);
