begin;

create function public.crm_request_context(touch_session boolean default false)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare verified boolean; actor public.profiles; granted jsonb;
begin
  if touch_session then verified := public.touch_login_session();
  else verified := public.is_verified_session(); end if;
  if not verified then return null; end if;
  select * into actor from public.profiles where id=auth.uid() and status='active' and deleted_at is null;
  if not found then return null; end if;
  select coalesce(jsonb_agg(permission order by permission),'[]'::jsonb) into granted
    from public.my_permissions() permission;
  return jsonb_build_object('id',actor.id,'email',coalesce(actor.email,''),
    'profile',jsonb_build_object('id',actor.id,'fullName',actor.full_name,'email',coalesce(actor.email,''),
      'phone',coalesce(actor.phone,''),'role',actor.role,'reportingTo',actor.reporting_to,
      'status',actor.status,'ivrExtension',coalesce(actor.ivr_extension,''),'deletedAt',actor.deleted_at),
    'permissions',granted);
end;
$$;
revoke all on function public.crm_request_context(boolean) from public, anon;
grant execute on function public.crm_request_context(boolean) to authenticated;

create function public.crm_notification_snapshot()
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare result jsonb;
begin
  perform public.release_my_due_call_notifications();
  select jsonb_build_object(
    'notifications',coalesce((select jsonb_agg(n order by n.created_at desc,n.id desc) from (
      select id,type,payload,lead_id,is_read,created_at from public.notifications
      where user_id=auth.uid() order by created_at desc,id desc limit 100) n),'[]'::jsonb),
    'unread',(select count(*) from public.notifications where user_id=auth.uid() and not is_read)
  ) into result;
  return result;
end;
$$;
revoke all on function public.crm_notification_snapshot() from public, anon;
grant execute on function public.crm_notification_snapshot() to authenticated;

commit;
