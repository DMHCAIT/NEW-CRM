begin;

create or replace function public.lead_duplicate_owners(lead_id uuid)
returns table(assignee text, merge_target_id uuid)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare current_lead public.leads; calling_prefix text;
begin
  if not public.is_verified_session() or not public.has_permission('leads.view') then
    raise exception 'Lead view permission required';
  end if;
  select * into current_lead from public.leads l where l.id = lead_id
    and not l.is_archived and l.merged_into_id is null
    and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view'));
  if current_lead.id is null then raise exception 'Lead not found within your accessible scope'; end if;
  calling_prefix := public.lead_country_calling_prefix(current_lead.country_code);
  return query
    select coalesce(p.full_name,'Unassigned'),
      case when public.has_permission('leads.merge')
        and public.lead_merge_in_bucket(current_lead.assignee_id)
        and public.lead_merge_in_bucket(l.assignee_id) then l.id else null end
    from public.leads l left join public.profiles p on p.id = l.assignee_id
    where l.id <> current_lead.id and not l.is_archived and l.merged_into_id is null
      and (
        (current_lead.normalized_phone <> '' and l.normalized_phone <> '' and (
          l.normalized_phone = current_lead.normalized_phone
          or (coalesce(l.country_code,'') = '' and calling_prefix <> ''
            and l.normalized_phone = substring(current_lead.normalized_phone from length(calling_prefix) + 1))
          or (coalesce(current_lead.country_code,'') = ''
            and public.lead_country_calling_prefix(l.country_code) <> ''
            and substring(l.normalized_phone from length(public.lead_country_calling_prefix(l.country_code)) + 1) = current_lead.normalized_phone)
        ))
        or (nullif(current_lead.normalized_email,'') is not null and l.normalized_email = current_lead.normalized_email)
      )
    order by p.full_name nulls last, l.id;
end;
$$;

revoke all on function public.lead_duplicate_owners(uuid) from public, anon;
grant execute on function public.lead_duplicate_owners(uuid) to authenticated;

commit;
