begin;

create index leads_import_local_phone_idx
  on public.leads (substring(normalized_phone from length(public.lead_country_calling_prefix(country_code)) + 1))
  where public.lead_country_calling_prefix(country_code) <> '';

commit;
