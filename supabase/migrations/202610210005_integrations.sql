begin;

create table public.intake_source_settings (
  source_id uuid primary key references public.lead_sources(id) on delete cascade,
  channel text not null check (channel in ('website','chatbot','facebook')),
  owner_id uuid not null references public.profiles(id),
  stage_id uuid references public.lead_stages(id),
  facebook_page_id text,
  created_by uuid not null references public.profiles(id)
);
create unique index intake_facebook_page_unique on public.intake_source_settings(facebook_page_id)
  where channel = 'facebook';
alter table public.intake_source_settings enable row level security;
-- Keys, source settings, OAuth state and tokens are service-only. APIs authorize before service access.
create table public.intake_rate_limits (
  source_id uuid not null references public.lead_sources(id) on delete cascade,
  bucket timestamptz not null,
  attempts integer not null default 1,
  primary key(source_id,bucket)
);
alter table public.intake_rate_limits enable row level security;
alter table public.inbound_events add column external_event_id text;
create unique index inbound_source_event_unique on public.inbound_events(source_id,external_event_id)
  where external_event_id is not null;

create table public.gmail_oauth_states (
  state_hash text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_id text not null,
  encrypted_verifier text not null,
  expires_at timestamptz not null
);
alter table public.gmail_oauth_states enable row level security;
create table public.gmail_connections (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  email text not null,
  encrypted_tokens text not null,
  history_id text,
  sync_state jsonb not null default '{"mode":"bootstrap"}'::jsonb,
  sync_lock_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gmail_connections enable row level security;
create table public.gmail_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  gmail_message_id text not null,
  thread_id text,
  lead_id uuid references public.leads(id),
  from_email text not null default '',
  to_email text not null default '',
  subject text not null default '',
  body text not null default '',
  received_at timestamptz,
  in_inbox boolean not null default true,
  is_deleted boolean not null default false,
  synced_at timestamptz not null default now(),
  unique(user_id,gmail_message_id)
);
alter table public.gmail_messages enable row level security;
create policy "Users read own Gmail inbox" on public.gmail_messages for select to authenticated
using (user_id = auth.uid() and public.has_permission('integrations.view'));
grant select on public.gmail_messages to authenticated;
alter table public.emails add column gmail_message_id text;
alter table public.emails add column from_email text;
alter table public.emails add column direction text not null default 'outbound';
create unique index emails_gmail_message_unique on public.emails(user_id,gmail_message_id);

create function public.integration_commit_gmail(p_user_id uuid,p_lock_at timestamptz,p_messages jsonb,p_state jsonb,p_history_id text)
returns void language plpgsql security invoker set search_path = public as $$
declare v_message jsonb; v_email text;
begin
  select email into v_email from public.gmail_connections where user_id=p_user_id and sync_lock_at=p_lock_at for update;
  if not found then raise exception 'Gmail sync lease was lost'; end if;
  for v_message in select value from jsonb_array_elements(p_messages) loop
    insert into public.gmail_messages(user_id,gmail_message_id,thread_id,lead_id,from_email,to_email,subject,body,received_at,in_inbox,is_deleted,synced_at)
    values(p_user_id,v_message->>'gmail_message_id',v_message->>'thread_id',(v_message->>'lead_id')::uuid,
      coalesce(v_message->>'from_email',''),coalesce(v_message->>'to_email',''),coalesce(v_message->>'subject',''),
      coalesce(v_message->>'body',''),(v_message->>'received_at')::timestamptz,
      (v_message->>'in_inbox')::boolean,(v_message->>'is_deleted')::boolean,now())
    on conflict(user_id,gmail_message_id) do update set
      thread_id=coalesce(excluded.thread_id,gmail_messages.thread_id),lead_id=coalesce(excluded.lead_id,gmail_messages.lead_id),
      from_email=case when excluded.is_deleted then gmail_messages.from_email else excluded.from_email end,
      to_email=case when excluded.is_deleted then gmail_messages.to_email else excluded.to_email end,
      subject=case when excluded.is_deleted then gmail_messages.subject else excluded.subject end,
      body=case when excluded.is_deleted then gmail_messages.body else excluded.body end,
      received_at=coalesce(excluded.received_at,gmail_messages.received_at),in_inbox=excluded.in_inbox,is_deleted=excluded.is_deleted,synced_at=now();
    if v_message->>'lead_id' is not null and coalesce((v_message->>'log_email')::boolean,false) and not (v_message->>'is_deleted')::boolean then
      insert into public.emails(lead_id,user_id,subject,body,to_email,from_email,status,sent_at,gmail_message_id,direction)
      values((v_message->>'lead_id')::uuid,p_user_id,coalesce(v_message->>'subject',''),coalesce(v_message->>'body',''),
        coalesce(v_message->>'to_email',''),coalesce(v_message->>'from_email',''),'received',
        (v_message->>'received_at')::timestamptz,v_email || ':' || (v_message->>'gmail_message_id'),'inbound')
      on conflict(user_id,gmail_message_id) do update set subject=excluded.subject,body=excluded.body;
    end if;
  end loop;
  update public.gmail_connections set sync_state=p_state,history_id=p_history_id,last_synced_at=now(),
    updated_at=now(),last_error=null,sync_lock_at=null where user_id=p_user_id and sync_lock_at=p_lock_at;
end $$;

create function public.integration_set_gmail(p_user_id uuid,p_action text,p_email text default null,p_encrypted_tokens text default null,p_baseline text default null)
returns void language plpgsql security invoker set search_path = public as $$
declare v_connection public.gmail_connections;
begin
  perform pg_advisory_xact_lock(hashtextextended('crm.gmail.' || p_user_id::text,0));
  select * into v_connection from public.gmail_connections where user_id=p_user_id for update;
  if v_connection.sync_lock_at > now() - interval '15 minutes' then raise exception 'Gmail synchronization is in progress'; end if;
  if p_action='connect' then
    if coalesce(p_email,'')='' or coalesce(p_encrypted_tokens,'')='' or coalesce(p_baseline,'')=''
      then raise exception 'Mailbox credentials missing'; end if;
    delete from public.gmail_messages where user_id=p_user_id;
    insert into public.gmail_connections(user_id,email,encrypted_tokens,sync_state)
      values(p_user_id,p_email,p_encrypted_tokens,jsonb_build_object('mode','bootstrap','baseline',p_baseline))
    on conflict(user_id) do update set email=excluded.email,encrypted_tokens=excluded.encrypted_tokens,
      sync_state=excluded.sync_state,history_id=null,sync_lock_at=null,last_synced_at=null,last_error=null,updated_at=now();
  elsif p_action='disconnect' then
    delete from public.gmail_connections where user_id=p_user_id;
    delete from public.gmail_messages where user_id=p_user_id;
  elsif p_action='reset' then
    if v_connection.user_id is null then raise exception 'Connect Gmail first'; end if;
    update public.gmail_connections set history_id=null,sync_state='{"mode":"bootstrap"}',sync_lock_at=null,last_error=null where user_id=p_user_id;
    update public.gmail_messages set in_inbox=false where user_id=p_user_id;
  else raise exception 'Invalid Gmail action';
  end if;
end $$;

create function public.integration_intake_rate(p_source_id uuid)
returns boolean language plpgsql security invoker set search_path = public as $$
declare v_attempts integer;
begin
  insert into public.intake_rate_limits(source_id,bucket) values(p_source_id,date_trunc('minute',now()))
  on conflict(source_id,bucket) do update set attempts = intake_rate_limits.attempts + 1
  returning attempts into v_attempts;
  delete from public.intake_rate_limits where source_id=p_source_id and bucket < now() - interval '1 day';
  return v_attempts <= 60;
end $$;

create function public.integration_intake(p_source_id uuid,p_event_id text,p_lead jsonb,p_transcript jsonb default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_settings public.intake_source_settings;
  v_source public.lead_sources;
  v_existing public.inbound_events;
  v_config jsonb;
  v_policy text;
  v_fields text;
  v_lead_id uuid;
  v_status text := 'created';
  v_phone text := regexp_replace(p_lead->>'phone','[^0-9]','','g');
  v_email text := nullif(lower(trim(p_lead->>'email')),'');
begin
  -- The same lock as interactive lead creation keeps duplicate resolution atomic.
  perform pg_advisory_xact_lock(hashtextextended('crm.live-lead-creation',0));
  select * into v_source from public.lead_sources where id=p_source_id and is_active;
  if not found then raise exception 'Intake source unavailable'; end if;
  select * into v_settings from public.intake_source_settings where source_id=p_source_id;
  if not found or not exists(select 1 from public.profiles where id=v_settings.owner_id and status='active' and deleted_at is null)
    then raise exception 'Intake source needs an active owner'; end if;
  if v_settings.stage_id is not null and not exists(select 1 from public.lead_stages where id=v_settings.stage_id and is_active)
    then raise exception 'Intake stage is inactive'; end if;
  if p_event_id is null or length(p_event_id) not between 1 and 200 or length(trim(coalesce(p_lead->>'name',''))) not between 1 and 200
    or length(v_phone) not between 7 and 15 then raise exception 'Invalid intake payload'; end if;
  select * into v_existing from public.inbound_events where source_id=p_source_id and external_event_id=p_event_id;
  if found then return jsonb_build_object('status','replayed','lead_id',v_existing.lead_id); end if;
  select value into v_config from public.crm_settings where setting_key='lead_configuration';
  v_fields := coalesce(v_config->>'duplicateFields','phone_email');
  v_policy := coalesce(v_config->>'creationPolicy','block');
  if v_fields not in ('phone_email','phone','email') or v_policy not in ('allow','warn','block')
    then raise exception 'Unsupported lead duplicate configuration'; end if;
  select coalesce(merged_into_id,id) into v_lead_id from public.leads where
    ((v_fields in ('phone_email','phone') and normalized_phone=v_phone) or
     (v_fields in ('phone_email','email') and v_email is not null and normalized_email=v_email))
    order by created_at,id limit 1;
  -- Unattended intake cannot acknowledge a warning: warn and block both attach to the existing lead.
  if v_lead_id is not null and v_policy <> 'allow' then
    v_status := 'matched_existing';
  else
    insert into public.leads(name,phone,normalized_phone,email,normalized_email,country,course,qualification,
      source,assignee_id,created_by,stage_id)
    values(trim(p_lead->>'name'),p_lead->>'phone',v_phone,v_email,v_email,p_lead->>'country',
      p_lead->>'course',p_lead->>'qualification',v_source.name,v_settings.owner_id,v_settings.created_by,v_settings.stage_id)
    returning id into v_lead_id;
  end if;
  insert into public.inbound_events(source_id,lead_id,payload,status,external_event_id)
    values(p_source_id,v_lead_id,p_lead,v_status,p_event_id);
  insert into public.activities(lead_id,user_id,type,description,meta)
    values(v_lead_id,null,'inbound',v_source.name || ': ' || v_status,
      jsonb_build_object('source_id',p_source_id,'external_event_id',p_event_id));
  if v_settings.channel='chatbot' and p_transcript is not null then
    insert into public.chat_sessions(lead_id,channel,transcript,ended_at) values(v_lead_id,'website_chatbot',p_transcript,now());
  end if;
  return jsonb_build_object('status',v_status,'lead_id',v_lead_id);
end $$;

revoke all on public.intake_source_settings,public.intake_rate_limits,public.gmail_oauth_states,public.gmail_connections from anon,authenticated;
grant all on public.intake_source_settings,public.intake_rate_limits,public.gmail_oauth_states,public.gmail_connections,public.gmail_messages to service_role;
revoke all on function public.integration_intake_rate(uuid) from public,anon,authenticated;
revoke all on function public.integration_intake(uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.integration_intake_rate(uuid) to service_role;
grant execute on function public.integration_intake(uuid,text,jsonb,jsonb) to service_role;
revoke all on function public.integration_commit_gmail(uuid,timestamptz,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.integration_commit_gmail(uuid,timestamptz,jsonb,jsonb,text) to service_role;
revoke all on function public.integration_set_gmail(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.integration_set_gmail(uuid,text,text,text,text) to service_role;

commit;
