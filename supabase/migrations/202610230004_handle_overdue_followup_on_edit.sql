begin;

create function public.handle_overdue_followup_on_edit()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.next_followup_at is not null and old.next_followup_at < clock_timestamp()
    and new.next_followup_at is not distinct from old.next_followup_at
    and not new.is_archived and new.merged_into_id is null
    and (to_jsonb(new) - array[
      'modified_at','modified_by','edited_at','has_been_edited','call_schedule_revision',
      'normalized_phone','normalized_email','is_archived','merged_into_id'])
      is distinct from (to_jsonb(old) - array[
      'modified_at','modified_by','edited_at','has_been_edited','call_schedule_revision',
      'normalized_phone','normalized_email','is_archived','merged_into_id']) then
    new.next_followup_at := null;
  end if;
  return new;
end;
$$;

-- Runs after validation and before edit tracking/auditing.
create trigger handle_overdue_followup_on_edit before update on public.leads
for each row execute function public.handle_overdue_followup_on_edit();

-- Repair only records whose latest detailed edit proves the old follow-up was
-- handled after it fell due. Do not guess from legacy timestamps or replace a
-- deliberately selected follow-up date.
update public.leads l set next_followup_at = null
where not l.is_archived and l.merged_into_id is null
  and l.next_followup_at < clock_timestamp()
  and exists (
    select 1 from (
      select a.created_at,a.meta
      from public.activities a
      where a.lead_id = l.id and a.type = 'updated'
      order by a.created_at desc,a.id desc limit 1
    ) latest
    where latest.created_at > l.next_followup_at
      and jsonb_typeof(latest.meta->'changes') = 'object'
      and latest.meta->'changes' <> '{}'::jsonb
      and not (latest.meta->'changes' ?| array['next_followup_at','is_archived','merged_into_id'])
  );

commit;
