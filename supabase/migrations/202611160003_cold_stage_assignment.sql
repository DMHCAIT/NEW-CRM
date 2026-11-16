begin;

alter table public.lead_assignment_automations
  drop constraint lead_assignment_automations_rule_key_check,
  add constraint lead_assignment_automations_rule_key_check
    check (rule_key in ('facebook','website','junk','not_interested','closed_won','cold'));

insert into public.lead_assignment_automations(rule_key) values ('cold');

do $migration$
declare
  v_function regprocedure;
  v_source text;
  v_old text := 'when ''closed won'' then ''closed_won''';
  v_new text := 'when ''closed won'' then ''closed_won''
    when ''cold'' then ''cold''';
begin
  foreach v_function in array array[
    'public.automatic_stage_lead_assignment()'::regprocedure,
    'public.automatic_intake_lead_assignment()'::regprocedure
  ] loop
    v_source := pg_get_functiondef(v_function);
    if position(v_old in v_source) = 0 then
      raise exception 'Unexpected assignment function %; reconcile migration before applying', v_function;
    end if;
    execute replace(v_source, v_old, v_new);
  end loop;
end $migration$;

commit;
