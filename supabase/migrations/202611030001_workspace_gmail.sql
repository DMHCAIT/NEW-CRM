alter table public.gmail_connections
  add column auth_mode text not null default 'oauth'
    check (auth_mode in ('oauth', 'workspace')),
  alter column encrypted_tokens drop not null;
alter table public.gmail_connections
  add constraint gmail_oauth_tokens_required
    check (auth_mode <> 'oauth' or encrypted_tokens is not null);

create or replace function public.integration_set_gmail(p_user_id uuid,p_action text,p_email text default null,p_encrypted_tokens text default null,p_baseline text default null)
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
    insert into public.gmail_connections(user_id,email,encrypted_tokens,auth_mode,sync_state)
      values(p_user_id,p_email,p_encrypted_tokens,'oauth',jsonb_build_object('mode','bootstrap','baseline',p_baseline))
    on conflict(user_id) do update set email=excluded.email,encrypted_tokens=excluded.encrypted_tokens,auth_mode='oauth',
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
