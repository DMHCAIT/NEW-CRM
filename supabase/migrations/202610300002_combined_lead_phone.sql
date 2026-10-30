begin;

create function public.combined_lead_phone(phone_value text, calling_code text)
returns text language plpgsql immutable set search_path = public, pg_temp as $$
declare digits text; prefix text;
begin
  digits := regexp_replace(coalesce(phone_value, ''), '[^0-9]', '', 'g');
  if left(trim(phone_value), 1) = '+' then return '+' || digits; end if;
  prefix := substring(calling_code from '\(\+([0-9]+)');
  if prefix is null then return digits; end if;
  if not (length(digits) > 10 and left(digits, length(prefix)) = prefix) then
    digits := prefix || digits;
  end if;
  return '+' || digits;
end $$;

create function public.combine_lead_phone_on_write()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.phone := public.combined_lead_phone(new.phone, new.country_code);
  new.normalized_phone := regexp_replace(new.phone, '[^0-9]', '', 'g');
  return new;
end $$;

-- Run before the duplicate guard, including for imports and service-role writes.
create trigger a_combine_lead_phone before insert or update of phone, country_code on public.leads
for each row execute function public.combine_lead_phone_on_write();

-- Formatting existing data must not count as a user edit or change call/follow-up state.
alter table public.leads disable trigger audit_leads;
alter table public.leads disable trigger audit_live_lead_changes;
alter table public.leads disable trigger track_lead_edit;
alter table public.leads disable trigger track_lead_schedule_revision;
alter table public.leads disable trigger handle_overdue_followup_on_edit;

update public.leads
set phone = public.combined_lead_phone(phone, country_code),
    normalized_phone = regexp_replace(public.combined_lead_phone(phone, country_code), '[^0-9]', '', 'g')
where phone is distinct from public.combined_lead_phone(phone, country_code)
   or normalized_phone is distinct from regexp_replace(public.combined_lead_phone(phone, country_code), '[^0-9]', '', 'g');

alter table public.leads enable trigger audit_leads;
alter table public.leads enable trigger audit_live_lead_changes;
alter table public.leads enable trigger track_lead_edit;
alter table public.leads enable trigger track_lead_schedule_revision;
alter table public.leads enable trigger handle_overdue_followup_on_edit;

-- Replace legacy visible columns without invalidating existing saved reports.
update public.saved_reports r set columns_json = (
  select jsonb_agg(key order by position) from (
    select case when value = 'countryCode' then 'phone' else value end as key, min(ord) as position
    from jsonb_array_elements_text(r.columns_json) with ordinality as c(value, ord)
    group by case when value = 'countryCode' then 'phone' else value end
  ) columns
) where columns_json ? 'countryCode';

update public.user_columns u set columns_json = (
  select jsonb_agg(key order by position) from (
    select case when value = 'countryCode' then 'phone' else value end as key, min(ord) as position
    from jsonb_array_elements_text(u.columns_json) with ordinality as c(value, ord)
    group by case when value = 'countryCode' then 'phone' else value end
  ) columns
) where columns_json ? 'countryCode';

commit;
