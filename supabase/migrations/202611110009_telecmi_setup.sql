begin;

alter table public.integration_credentials drop constraint integration_credentials_provider_check;
alter table public.integration_credentials add constraint integration_credentials_provider_check
  check (provider in ('zoom','razorpay','stripe','smtp','gmail','intake','facebook','telecmi'));

create table public.telecmi_agent_mappings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  agent_id text not null unique check (agent_id ~ '^[A-Za-z0-9][A-Za-z0-9_.@-]{0,99}$'),
  revision uuid not null default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

alter table public.telecmi_agent_mappings enable row level security;
revoke all on public.telecmi_agent_mappings from public, anon, authenticated;
grant select, insert, update, delete on public.telecmi_agent_mappings to service_role;

commit;
