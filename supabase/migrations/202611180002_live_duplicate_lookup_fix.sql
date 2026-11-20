begin;

create or replace function public.find_live_lead_duplicates(check_phone text, check_email text, check_country_code text default '')
returns table(match_field text, lead_id uuid, lead_name text, assignee text, in_bucket boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare match_fields text; p text; e text;
begin
  if not public.is_verified_session() or not public.has_permission('leads.create') then
    raise exception 'Lead creation permission required';
  end if;
  select value->>'duplicateFields' into match_fields
    from public.crm_settings where setting_key = 'lead_configuration';
  match_fields := coalesce(match_fields, 'phone_email');
  p := nullif(regexp_replace(coalesce(check_phone, ''), '[^0-9]', '', 'g'), '');
  e := nullif(lower(trim(coalesce(check_email, ''))), '');
  return query
    select
      case
        when match_fields in ('phone_email','phone') and p is not null
          and l.normalized_phone = p then 'phone'
        else 'email'
      end,
      case when b.ok then l.id end,
      case when b.ok then l.name end,
      coalesce(nullif(btrim(pr.full_name), ''), nullif(btrim(pr.email), ''), 'Unassigned'),
      b.ok
    from public.leads l
    left join public.profiles pr on pr.id = l.assignee_id
    cross join lateral (
      select coalesce(public.has_permission('leads.view') and (
        l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view')
      ), false) as ok
    ) b
    where
      (match_fields in ('phone_email','phone') and p is not null and l.normalized_phone = p)
      or (match_fields in ('phone_email','email') and e is not null
        and lower(trim(coalesce(nullif(l.normalized_email,''), l.email,''))) = e)
    order by b.ok desc, l.created_at desc
    limit 5;
end $$;
revoke all on function public.find_live_lead_duplicates(text,text,text) from public, anon;
grant execute on function public.find_live_lead_duplicates(text,text,text) to authenticated;

commit;
