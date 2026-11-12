begin;

create table public.telecmi_call_attempts (
  id uuid primary key,
  user_id uuid not null references public.profiles(id),
  lead_id uuid not null references public.leads(id),
  activity_id uuid not null references public.activities(id),
  status text not null default 'requesting' check (status in ('requesting','accepted','rejected','unknown')),
  provider_request_id text,
  created_at timestamptz not null default now()
);
create index telecmi_call_attempts_user_time on public.telecmi_call_attempts(user_id, created_at desc);
alter table public.telecmi_call_attempts enable row level security;
revoke all on public.telecmi_call_attempts from public, anon, authenticated;
grant select, insert, update on public.telecmi_call_attempts to service_role;

create function public.claim_telecmi_call(
  call_id uuid, actor_id uuid, target_lead_id uuid, actor_name text, agent text, destination text
) returns jsonb language plpgsql set search_path = public as $$
declare
  attempt public.telecmi_call_attempts;
  activity uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor_id::text, 0));
  select * into attempt from public.telecmi_call_attempts where id = call_id;
  if found then
    if attempt.user_id <> actor_id or attempt.lead_id <> target_lead_id then
      raise exception 'Call request ID already belongs to another request';
    end if;
    return jsonb_build_object('claimed', false, 'id', attempt.id, 'status', attempt.status, 'provider_request_id', attempt.provider_request_id);
  end if;
  if exists (select 1 from public.telecmi_call_attempts where user_id = actor_id and created_at > now() - interval '60 seconds') then
    return null;
  end if;
  insert into public.activities(lead_id, user_id, type, description, meta)
    values(target_lead_id, actor_id, 'call', 'TeleCMI call requested; provider response pending',
      jsonb_build_object('actor_name', actor_name, 'provider', 'telecmi', 'call_request_id', call_id,
        'agent_id', agent, 'to', destination, 'status', 'requesting'))
    returning id into activity;
  insert into public.telecmi_call_attempts(id, user_id, lead_id, activity_id)
    values(call_id, actor_id, target_lead_id, activity) returning * into attempt;
  return jsonb_build_object('claimed', true, 'id', attempt.id, 'status', attempt.status, 'provider_request_id', null);
end;
$$;

create function public.finish_telecmi_call(call_id uuid, outcome text, provider_id text)
returns boolean language plpgsql set search_path = public as $$
declare
  activity uuid;
begin
  if outcome not in ('accepted','rejected','unknown') then raise exception 'Invalid call outcome'; end if;
  if outcome = 'accepted' and nullif(trim(provider_id), '') is null then raise exception 'Provider request ID is required'; end if;
  update public.telecmi_call_attempts set status = outcome, provider_request_id = provider_id
    where id = call_id and status = 'requesting' returning activity_id into activity;
  if not found then return false; end if;
  update public.activities set
    description = case outcome
      when 'accepted' then 'TeleCMI accepted call request; connection not confirmed'
      when 'rejected' then 'TeleCMI rejected call request'
      else 'TeleCMI call outcome unknown; check provider history before retrying' end,
    meta = meta || jsonb_build_object('status', outcome, 'provider_request_id', provider_id)
    where id = activity;
  if not found then raise exception 'Call activity not found'; end if;
  return true;
end;
$$;
revoke all on function public.claim_telecmi_call(uuid,uuid,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.finish_telecmi_call(uuid,text,text) from public, anon, authenticated;
grant execute on function public.claim_telecmi_call(uuid,uuid,uuid,text,text,text) to service_role;
grant execute on function public.finish_telecmi_call(uuid,text,text) to service_role;

commit;
