begin;

alter table public.notifications add column lead_id uuid references public.leads(id);
alter table public.notifications add column event_key text;
create unique index notifications_event_key_idx on public.notifications(event_key) where event_key is not null;
create index notifications_unread_idx on public.notifications(user_id,created_at desc) where not is_read;
create index scheduled_calls_due_idx on public.scheduled_calls(scheduled_at,id) where status = 'scheduled';
revoke insert,update,delete on public.notifications from authenticated;
grant update(is_read) on public.notifications to authenticated;
grant insert(user_id,type,payload) on public.notifications to authenticated;

create table public.notification_email_queue (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null unique references public.notifications(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed')),
  attempts integer not null default 0,
  claimed_at timestamptz,
  claim_token uuid,
  retry_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text
);
alter table public.notification_email_queue enable row level security;
revoke all on public.notification_email_queue from anon, authenticated;
grant all on public.notification_email_queue to service_role;

create function public.queue_lead_notification(p_lead uuid, p_type text, p_message text, p_key text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare recipient uuid; notification uuid;
begin
  select l.assignee_id into recipient from public.leads l
    join public.profiles p on p.id = l.assignee_id
    where l.id = p_lead and not l.is_archived and p.status = 'active' and p.deleted_at is null;
  if recipient is null then return; end if;
  insert into public.notifications(user_id,type,payload,lead_id,event_key)
    values(recipient,p_type,jsonb_build_object('message',p_message,'lead_id',p_lead),p_lead,p_key)
    on conflict (event_key) where event_key is not null do nothing returning id into notification;
  if notification is not null then
    insert into public.notification_email_queue(notification_id) values(notification);
  end if;
end;
$$;
revoke all on function public.queue_lead_notification(uuid,text,text,text) from public, anon, authenticated;

create function public.notify_lead_activity()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare lead_name text; actor text;
begin
  if new.type = 'created' or (new.type = 'call' and new.description = 'Call scheduled') then return new; end if;
  select name into lead_name from public.leads where id = new.lead_id;
  select full_name into actor from public.profiles where id = new.user_id;
  perform public.queue_lead_notification(new.lead_id,new.type,
    coalesce(actor,'System') || ': ' || new.description || ' — ' || lead_name,
    'activity:' || new.id);
  return new;
end;
$$;
create trigger notify_lead_activity after insert on public.activities for each row execute function public.notify_lead_activity();

create function public.notify_lead_related_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare lead_name text; actor text; message text;
begin
  if tg_table_name = 'emails' then
    if new.direction <> 'inbound' and new.status <> 'sent' then return new; end if;
    if tg_op = 'UPDATE' then
      if old.status = new.status then return new; end if;
    end if;
    message := case when new.direction = 'inbound' then 'Email received' else 'Email sent' end;
  elsif tg_table_name = 'notes' then message := 'Note added';
  else message := 'Call activity recorded';
  end if;
  select name into lead_name from public.leads where id = new.lead_id;
  select full_name into actor from public.profiles where id = new.user_id;
  perform public.queue_lead_notification(new.lead_id,tg_table_name,
    coalesce(actor,'System') || ': ' || message || ' — ' || lead_name,
    tg_table_name || ':' || new.id);
  return new;
end;
$$;
create trigger notify_lead_note after insert on public.notes for each row execute function public.notify_lead_related_change();
create trigger notify_lead_email after insert or update of status on public.emails for each row execute function public.notify_lead_related_change();
create trigger notify_lead_call after insert on public.calls for each row execute function public.notify_lead_related_change();

create function public.release_due_call_notifications(p_owner uuid default null)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare call_row record; released integer := 0;
begin
  for call_row in
    select c.id,c.lead_id,c.scheduled_at,l.name from public.scheduled_calls c
    join public.leads l on l.id = c.lead_id
    join public.profiles p on p.id = l.assignee_id
    where c.status = 'scheduled' and c.scheduled_at <= now() and not l.is_archived
      and p.status = 'active' and p.deleted_at is null and (p_owner is null or l.assignee_id = p_owner)
      and not exists(select 1 from public.notifications n where n.event_key = 'call-due:' || c.id || ':' || extract(epoch from c.scheduled_at)::text)
    order by c.scheduled_at,c.id limit 100 for update of c skip locked
  loop
    perform public.queue_lead_notification(call_row.lead_id,'call_due','Scheduled call is due — ' || call_row.name,
      'call-due:' || call_row.id || ':' || extract(epoch from call_row.scheduled_at)::text);
    released := released + 1;
  end loop;
  return released;
end;
$$;
revoke all on function public.release_due_call_notifications(uuid) from public, anon, authenticated;
grant execute on function public.release_due_call_notifications(uuid) to service_role;

create function public.release_my_due_call_notifications()
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_verified_session() then raise exception 'Verified CRM session required'; end if;
  return public.release_due_call_notifications(auth.uid());
end;
$$;
revoke all on function public.release_my_due_call_notifications() from public, anon;
grant execute on function public.release_my_due_call_notifications() to authenticated;

create function public.claim_notification_emails()
returns table(id uuid, claim_token uuid, recipient text, message text, lead_id uuid)
language sql security definer set search_path = public, pg_temp as $$
  with candidates as (
    select q.id from public.notification_email_queue q
    where q.attempts < 5 and (
      (q.status in ('pending','failed') and q.retry_at <= now())
      or (q.status = 'sending' and q.claimed_at < now() - interval '5 minutes'))
    order by q.retry_at,q.id limit 25 for update skip locked
  ), claimed as (
    update public.notification_email_queue q set status='sending',attempts=q.attempts+1,
      claimed_at=now(),claim_token=gen_random_uuid()
    from candidates c where q.id=c.id returning q.*
  )
  select c.id,c.claim_token,case when p.status='active' and p.deleted_at is null then p.email end,
    n.payload->>'message',n.lead_id
  from claimed c join public.notifications n on n.id=c.notification_id
    join public.profiles p on p.id=n.user_id;
$$;
revoke all on function public.claim_notification_emails() from public, anon, authenticated;
grant execute on function public.claim_notification_emails() to service_role;

commit;
