begin;

do $migration$
declare
  v_source text := pg_get_functiondef('public.guard_live_lead_changes()'::regprocedure);
  v_old text := 'if new.assignee_id is distinct from old.assignee_id and not public.has_permission(''leads.assign'') then';
  v_new text := 'if new.assignee_id is distinct from old.assignee_id and not public.has_permission(''leads.assign'')
      and not (
        current_user = (select pg_get_userbyid(relowner) from pg_class where oid = ''public.leads''::regclass)
        and pg_trigger_depth() > 1
        and public.is_verified_session()
        and (to_jsonb(new) - ''assignee_id'') = (to_jsonb(old) - ''assignee_id'')
      ) then';
begin
  -- Only a nested table-owner operation may assign on behalf of an editor.
  -- Direct writes cannot acquire that database identity or bypass the guard.
  if position(v_old in v_source)=0 then
    raise exception 'Unexpected lead guard function; reconcile migration before applying';
  end if;
  execute replace(v_source,v_old,v_new);
end $migration$;

commit;
