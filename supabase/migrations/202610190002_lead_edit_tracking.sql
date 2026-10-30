begin;

alter table public.leads add column has_been_edited boolean not null default false;
-- Every edit time; null means earlier edits are unknown, so date-based untouched filters stay conservative.
alter table public.leads add column edited_at timestamptz[] default '{}';

update public.leads
set has_been_edited = modified_at <> created_at,
    edited_at = case when modified_at <> created_at then null else '{}'::timestamptz[] end;

create or replace function public.track_lead_edit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new is distinct from old then
    new.has_been_edited := true;
    new.modified_at := clock_timestamp();
    new.edited_at := case when old.edited_at is null then null else old.edited_at || new.modified_at end;
    new.modified_by := coalesce(auth.uid(), new.modified_by);
  end if;
  return new;
end;
$$;

create trigger track_lead_edit before update on public.leads
for each row execute function public.track_lead_edit();

commit;
