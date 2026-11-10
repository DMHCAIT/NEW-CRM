begin;

drop trigger notify_lead_activity on public.activities;
drop trigger notify_lead_note on public.notes;
drop trigger notify_lead_email on public.emails;
drop trigger notify_lead_call on public.calls;
drop function public.notify_lead_activity();
drop function public.notify_lead_related_change();

create index notifications_open_call_lead_idx on public.notifications(lead_id)
  where type='call_due' and not is_read;

create function public.dismiss_modified_lead_call_notifications()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare previous_lead uuid; current_lead uuid;
begin
  if tg_table_name = 'leads' then
    if (to_jsonb(new) - array['modified_at','modified_by','edited_at','has_been_edited','call_schedule_revision','normalized_phone','normalized_email'])
      is not distinct from
      (to_jsonb(old) - array['modified_at','modified_by','edited_at','has_been_edited','call_schedule_revision','normalized_phone','normalized_email'])
      then return new; end if;
    previous_lead := old.id;
    current_lead := new.id;
  else
    if tg_op = 'UPDATE' and to_jsonb(new) is not distinct from to_jsonb(old) then return new; end if;
    if tg_op <> 'INSERT' then previous_lead := old.lead_id; end if;
    if tg_op <> 'DELETE' then current_lead := new.lead_id; end if;
  end if;
  update public.notifications set is_read=true
    where lead_id in (previous_lead,current_lead) and type='call_due' and not is_read;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.dismiss_modified_lead_call_notifications() from public, anon, authenticated;

create trigger dismiss_lead_call_notifications after update on public.leads
  for each row execute function public.dismiss_modified_lead_call_notifications();
create trigger dismiss_activity_call_notifications after insert or update or delete on public.activities
  for each row execute function public.dismiss_modified_lead_call_notifications();
create trigger dismiss_note_call_notifications after insert or update or delete on public.notes
  for each row execute function public.dismiss_modified_lead_call_notifications();
create trigger dismiss_email_call_notifications after insert or update or delete on public.emails
  for each row execute function public.dismiss_modified_lead_call_notifications();
create trigger dismiss_call_notifications after insert or update or delete on public.calls
  for each row execute function public.dismiss_modified_lead_call_notifications();
create trigger dismiss_schedule_call_notifications after insert or update or delete on public.scheduled_calls
  for each row execute function public.dismiss_modified_lead_call_notifications();
create trigger dismiss_invoice_call_notifications after insert or update or delete on public.invoices
  for each row execute function public.dismiss_modified_lead_call_notifications();

-- Keep event keys after dismissal so overdue calls cannot recreate the same alert.
update public.notifications n set is_read=true
where n.type='call_due' and not n.is_read and not exists (
  select 1 from public.scheduled_calls c join public.leads l on l.id=c.lead_id
  where c.lead_id=n.lead_id and c.status='scheduled' and not l.is_archived
    and l.assignee_id=n.user_id
    and n.event_key='call-due:' || c.id || ':' || extract(epoch from c.scheduled_at)::text
);
delete from public.notification_email_queue q using public.notifications n
  where q.notification_id=n.id and n.type<>'call_due' and q.status in ('pending','failed');

create or replace function public.crm_notification_snapshot()
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare result jsonb;
begin
  perform public.release_my_due_call_notifications();
  select jsonb_build_object(
    'notifications',coalesce((select jsonb_agg(n order by n.created_at desc,n.id desc) from (
      select id,type,payload,lead_id,is_read,created_at from public.notifications
      where user_id=auth.uid() and type='call_due' and not is_read
      order by created_at desc,id desc limit 100) n),'[]'::jsonb),
    'unread',(select count(*) from public.notifications where user_id=auth.uid() and type='call_due' and not is_read)
  ) into result;
  return result;
end;
$$;

commit;
