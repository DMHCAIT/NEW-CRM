begin;

insert into public.crm_settings (setting_key, value)
select 'lead_configuration',
  jsonb_build_object('picklists', jsonb_build_object('course', jsonb_agg(name order by lower(name), name)))
from public.courses
where is_active
having count(*) > 0
on conflict (setting_key) do update set
  value = jsonb_set(
    crm_settings.value,
    '{picklists}',
    coalesce(crm_settings.value->'picklists', '{}'::jsonb) || jsonb_build_object(
      'course',
      public.merge_lead_picklists(
        coalesce(crm_settings.value->'picklists', '{}'::jsonb),
        excluded.value->'picklists'
      )->'course'
    )
  ),
  updated_at = now();

notify pgrst, 'reload schema';
commit;
