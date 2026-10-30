drop policy if exists "Users read internal meetings" on public.meetings;
create policy "Users read internal meetings" on public.meetings for select to authenticated
using (
  lead_id is null
  and public.has_permission('meetings.view')
  and (
    host_id = auth.uid()
    or public.is_meeting_attendee(id)
    or public.has_permission('users.view')
    or public.user_in_scope(host_id)
  )
);

drop policy if exists "Authorized staff create meetings" on public.meetings;
create policy "Authorized staff create meetings" on public.meetings for insert to authenticated
with check (
  lead_id is null
  and public.has_permission('meetings.manage')
  and host_id = auth.uid()
  and exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role in ('manager', 'admin', 'super_admin')
      and p.status = 'active'
      and p.deleted_at is null
  )
);
