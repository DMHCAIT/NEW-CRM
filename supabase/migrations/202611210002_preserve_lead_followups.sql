begin;

drop trigger handle_overdue_followup_on_edit on public.leads;
drop function public.handle_overdue_followup_on_edit();

commit;
