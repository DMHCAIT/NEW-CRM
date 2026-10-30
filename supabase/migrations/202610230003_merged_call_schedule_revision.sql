begin;

create function public.sync_merged_call_schedule_revision()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.lead_id is distinct from old.lead_id then
    update public.leads
      set call_schedule_revision = greatest(call_schedule_revision,new.schedule_revision) + 1
      where id = new.lead_id;
  end if;
  return new;
end;
$$;
create trigger sync_merged_call_schedule_revision after update of lead_id on public.scheduled_calls
for each row execute function public.sync_merged_call_schedule_revision();

commit;
