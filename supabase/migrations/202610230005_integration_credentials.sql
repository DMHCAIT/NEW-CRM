begin;

create table public.integration_credentials (
  provider text primary key check (provider in ('zoom','razorpay','smtp','gmail','intake','facebook')),
  encrypted_values text not null,
  revision uuid not null default gen_random_uuid(),
  updated_by uuid not null references public.profiles(id),
  updated_at timestamptz not null default now(),
  tested_at timestamptz,
  test_status text check (test_status in ('passed','failed')),
  test_message text
);
alter table public.integration_credentials enable row level security;
revoke all on public.integration_credentials from public, anon, authenticated;
grant select, insert, update, delete on public.integration_credentials to service_role;

commit;
