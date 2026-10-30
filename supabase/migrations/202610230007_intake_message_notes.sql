begin;

alter table public.notes alter column user_id drop not null;

create or replace function public.integration_intake(p_source_id uuid,p_event_id text,p_lead jsonb,p_transcript jsonb default null)
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
  v_message text := nullif(btrim(coalesce(p_lead->>'message',''), E' \t\n\r'),'');
begin
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
  if p_lead ? 'message' and (jsonb_typeof(p_lead->'message') <> 'string' or length(coalesce(v_message,'')) > 10000)
    then raise exception 'Invalid intake message'; end if;
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
  if v_message is not null then
    insert into public.notes(lead_id,user_id,content)
      values(v_lead_id,null,'Enquiry from ' || v_source.name || E'\n\n' || v_message);
  end if;
  insert into public.activities(lead_id,user_id,type,description,meta)
    values(v_lead_id,null,'inbound',v_source.name || ': ' || v_status,
      jsonb_build_object('source_id',p_source_id,'external_event_id',p_event_id,'note_created',v_message is not null));
  if v_settings.channel='chatbot' and p_transcript is not null then
    insert into public.chat_sessions(lead_id,channel,transcript,ended_at) values(v_lead_id,'website_chatbot',p_transcript,now());
  end if;
  return jsonb_build_object('status',v_status,'lead_id',v_lead_id);
end $$;

commit;
