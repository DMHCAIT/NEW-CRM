begin;

alter table public.intake_source_settings add column facebook_form_id text;
drop index public.intake_facebook_page_unique;
alter table public.intake_source_settings add constraint intake_facebook_route_valid check (
  (channel = 'facebook' and facebook_page_id ~ '^[0-9]{1,40}$'
    and facebook_page_id is not null and (facebook_form_id is null or facebook_form_id ~ '^[0-9]{1,40}$'))
  or (channel <> 'facebook' and facebook_page_id is null and facebook_form_id is null)
);
-- One catch-all per Page, and one exact route per Page/form, even if a source is disabled.
create unique index intake_facebook_page_catchall_unique
  on public.intake_source_settings(facebook_page_id)
  where channel = 'facebook' and facebook_form_id is null;
create unique index intake_facebook_page_form_unique
  on public.intake_source_settings(facebook_page_id,facebook_form_id)
  where channel = 'facebook' and facebook_form_id is not null;

create table public.facebook_page_connections (
  page_id text primary key check (page_id ~ '^[0-9]{1,40}$'),
  page_name text not null,
  encrypted_credentials text not null,
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.facebook_page_connections enable row level security;
revoke all on public.facebook_page_connections from public, anon, authenticated;
grant select, insert, update, delete on public.facebook_page_connections to service_role;
comment on table public.facebook_page_connections is
  'Service-only encrypted Page tokens. Browser APIs return metadata only. Exact form source routes precede Page catch-all routes.';

commit;
