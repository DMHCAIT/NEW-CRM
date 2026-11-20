begin;

alter table public.lead_assignment_automations
  drop constraint lead_assignment_automations_rule_key_check,
  add constraint lead_assignment_automations_rule_key_check
    check (rule_key in ('facebook','website','junk','not_interested','closed_won','cold')
      or rule_key ~ '^stage:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

create function public.assignment_rule_for_stage(p_stage_id uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select case lower(name)
    when 'junk' then 'junk'
    when 'not interested' then 'not_interested'
    when 'closed won' then 'closed_won'
    when 'cold' then 'cold'
    else 'stage:' || id::text
  end
  from public.lead_stages where id = p_stage_id;
$$;
revoke all on function public.assignment_rule_for_stage(uuid) from public, anon, authenticated;

do $migration$
declare
  v_function regprocedure;
  v_source text;
  v_old text := 'case v_stage_name
    when ''junk'' then ''junk''
    when ''not interested'' then ''not_interested''
    when ''closed won'' then ''closed_won''
    when ''cold'' then ''cold''
    else null
  end';
  v_stage_id text;
begin
  foreach v_function in array array[
    'public.automatic_stage_lead_assignment()'::regprocedure,
    'public.automatic_intake_lead_assignment()'::regprocedure
  ] loop
    v_source := pg_get_functiondef(v_function);
    if position(v_old in v_source) = 0 then
      raise exception 'Unexpected assignment function %; reconcile migration before applying', v_function;
    end if;
    v_stage_id := case when v_function = 'public.automatic_stage_lead_assignment()'::regprocedure
      then 'new.stage_id' else 'v_stage_id' end;
    v_source := replace(v_source, v_old, 'public.assignment_rule_for_stage(' || v_stage_id || ')');
    if v_stage_id = 'new.stage_id' then
      if position('v_rule_key in (''cold'',''junk'',''not_interested'')' in v_source) = 0 then
        raise exception 'Unexpected deferred assignment condition; reconcile migration before applying';
      end if;
      v_source := replace(v_source, 'v_rule_key in (''cold'',''junk'',''not_interested'')',
        '(v_rule_key in (''cold'',''junk'',''not_interested'') or v_rule_key like ''stage:%'')');
    end if;
    execute v_source;
  end loop;
end $migration$;

commit;
