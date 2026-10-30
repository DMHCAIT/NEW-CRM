create extension if not exists pgcrypto;

create type public.crm_role as enum ('counselor', 'team_lead', 'manager', 'admin', 'super_admin');
create type public.invoice_status as enum ('pending_approval', 'sent', 'paid', 'rejected', 'expired', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  role public.crm_role not null default 'counselor',
  reporting_to uuid references public.profiles(id),
  status text not null default 'active' check (status in ('active', 'inactive')),
  ivr_extension text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.role_permissions (
  role public.crm_role not null,
  permission_key text not null,
  allowed boolean not null default false,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  primary key (role, permission_key)
);

create table public.user_permission_overrides (
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_key text not null,
  allowed boolean not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  primary key (user_id, permission_key)
);

create table public.crm_settings (
  setting_key text primary key,
  value jsonb not null,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.lead_stages (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order integer not null,
  is_active boolean not null default true,
  is_terminal boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  normalized_phone text not null,
  alt_phone text,
  email text,
  normalized_email text,
  country text,
  course text,
  qualification text,
  stage_id uuid references public.lead_stages(id),
  source text not null default 'manual',
  assignee_id uuid references public.profiles(id),
  created_by uuid not null references public.profiles(id),
  modified_by uuid references public.profiles(id),
  closure_fee numeric(12,2) not null default 0 check (closure_fee >= 0),
  next_followup_at timestamptz,
  last_visit_at timestamptz,
  merged_into_id uuid references public.leads(id),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  modified_at timestamptz not null default now()
);

create index leads_normalized_phone_idx on public.leads (normalized_phone);
create index leads_normalized_email_idx on public.leads (normalized_email) where normalized_email is not null;
create index leads_assignee_idx on public.leads (assignee_id);
create index leads_stage_idx on public.leads (stage_id);
create index leads_followup_idx on public.leads (next_followup_at);
create index leads_modified_idx on public.leads (modified_at desc);
create index leads_created_idx on public.leads (created_at desc);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  type text not null,
  description text not null,
  meta jsonb not null default '{}'::jsonb,
  user_id uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index activities_lead_timeline_idx on public.activities (lead_id, created_at desc);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  user_id uuid not null references public.profiles(id),
  content text not null,
  created_at timestamptz not null default now()
);

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  user_id uuid not null references public.profiles(id),
  subject text not null,
  body text not null,
  to_email text not null,
  status text not null default 'queued',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.email_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  name text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  user_id uuid not null references public.profiles(id),
  provider_call_id text unique,
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null default 'initiated',
  duration_seconds integer,
  outcome text,
  recording_url text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.scheduled_calls (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  user_id uuid not null references public.profiles(id),
  scheduled_at timestamptz not null,
  status text not null default 'scheduled',
  reminder_sent boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references public.profiles(id),
  filter_json jsonb not null default '{}'::jsonb,
  pinned_to_dashboard boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.user_columns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  view_name text not null,
  columns_json jsonb not null default '[]'::jsonb,
  unique (user_id, view_name)
);

create table public.automations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trigger_config jsonb not null,
  conditions_json jsonb not null default '[]'::jsonb,
  actions_json jsonb not null default '[]'::jsonb,
  priority integer not null default 100,
  is_active boolean not null default false,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.automation_logs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid references public.automations(id),
  lead_id uuid references public.leads(id),
  result text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.merge_logs (
  id uuid primary key default gen_random_uuid(),
  master_lead_id uuid not null references public.leads(id),
  merged_lead_id uuid not null references public.leads(id),
  user_id uuid not null references public.profiles(id),
  field_choices_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.report_downloads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  filter_json jsonb not null default '{}'::jsonb,
  format text not null,
  created_at timestamptz not null default now()
);

create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  type text not null unique,
  config jsonb not null default '{}'::jsonb,
  status text not null default 'not_connected',
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  api_key_hash text not null,
  allowed_origins text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.inbound_events (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.lead_sources(id),
  lead_id uuid references public.leads(id),
  payload jsonb not null,
  status text not null default 'received',
  received_at timestamptz not null default now()
);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  channel text not null,
  transcript jsonb not null default '[]'::jsonb,
  summary text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create table public.assignment_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  priority integer not null default 100,
  conditions_json jsonb not null default '[]'::jsonb,
  strategy text not null,
  pool_user_ids uuid[] not null default '{}',
  fallback_user_id uuid references public.profiles(id),
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.assignment_log (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id),
  rule_id uuid references public.assignment_rules(id),
  assigned_to uuid references public.profiles(id),
  reason text not null,
  created_at timestamptz not null default now()
);

create table public.user_availability (
  user_id uuid primary key references public.profiles(id),
  is_available boolean not null default true,
  working_hours_json jsonb not null default '{}'::jsonb,
  max_open_leads integer,
  updated_at timestamptz not null default now()
);

create table public.ivr_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references public.calls(id),
  provider_event text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id),
  title text not null,
  host_id uuid not null references public.profiles(id),
  zoom_meeting_id text unique,
  join_url text,
  start_url text,
  passcode text,
  start_at timestamptz not null,
  duration_min integer not null default 30,
  status text not null default 'scheduled',
  recording_url text,
  created_at timestamptz not null default now()
);

create table public.meeting_attendees (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id uuid references public.profiles(id),
  lead_email text,
  response_status text not null default 'pending'
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  invoice_no text not null unique,
  lead_id uuid not null references public.leads(id),
  created_by uuid not null references public.profiles(id),
  status public.invoice_status not null default 'sent',
  subtotal numeric(12,2) not null check (subtotal >= 0),
  tax_amount numeric(12,2) not null default 0 check (tax_amount >= 0),
  discount_type text check (discount_type in ('amount', 'percentage')),
  discount_value numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  discount_reason text,
  total numeric(12,2) not null check (total >= 0),
  currency text not null default 'INR',
  due_date date,
  pdf_url text,
  razorpay_qr_id text,
  qr_image_url text,
  qr_expires_at timestamptz,
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  sent_at timestamptz,
  paid_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  description text not null,
  quantity numeric(10,2) not null check (quantity > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  amount numeric(12,2) not null check (amount >= 0)
);

create table public.invoice_approvals (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  requested_by uuid not null references public.profiles(id),
  decided_by uuid references public.profiles(id),
  decision text not null default 'pending',
  comment text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  razorpay_payment_id text not null unique,
  amount numeric(12,2) not null check (amount >= 0),
  method text,
  status text not null,
  paid_at timestamptz,
  raw_payload jsonb not null default '{}'::jsonb
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  changes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.user_in_scope(target_user_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  with recursive downline(id) as (
    select auth.uid()
    union
    select p.id
    from public.profiles p
    join downline d on p.reporting_to = d.id
    where p.status = 'active'
  )
  select exists (select 1 from downline where id = target_user_id);
$$;

create or replace function public.has_permission(required_permission text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select case
    when not exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active') then false
    when exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'super_admin' and p.status = 'active') then true
    else coalesce(
      (select upo.allowed
       from public.user_permission_overrides upo
       where upo.user_id = auth.uid()
         and upo.permission_key = required_permission),
      (select rp.allowed
       from public.profiles p
       join public.role_permissions rp on rp.role = p.role
       where p.id = auth.uid()
         and p.status = 'active'
         and rp.permission_key = required_permission),
      false
    )
  end;
$$;

insert into public.lead_stages (name, sort_order, is_terminal) values
  ('Fresh', 1, false), ('Fresh Not Answered', 2, false), ('Follow-Up', 3, false),
  ('Follow-Up Not Answered', 4, false), ('Not Answering', 5, false), ('Warm', 6, false),
  ('Hot', 7, false), ('Prospect', 8, false), ('Closed Won', 9, true), ('Closed Lost', 10, true),
  ('Future Prospect', 11, false), ('DND', 12, false), ('General Enquiry', 13, false),
  ('Reactivated', 14, false), ('Junk', 15, false), ('Not Interested', 16, false),
  ('Already Enrolled', 17, false), ('Cold', 18, false), ('Cold Not Answered', 19, false),
  ('Interested – No Course', 20, false), ('Interested – No Centre', 21, false),
  ('Not Eligible', 22, false), ('Test Lead', 23, false)
on conflict (name) do nothing;

insert into public.role_permissions (role, permission_key, allowed) values
  ('counselor','dashboard.view',true), ('counselor','leads.view',true), ('counselor','leads.create',true), ('counselor','leads.edit',true), ('counselor','pipeline.view',true), ('counselor','meetings.view',true), ('counselor','meetings.manage',true), ('counselor','invoices.view',true), ('counselor','invoices.create',true), ('counselor','reports.view',true),
  ('team_lead','dashboard.view',true), ('team_lead','leads.view',true), ('team_lead','leads.create',true), ('team_lead','leads.edit',true), ('team_lead','leads.assign',true), ('team_lead','leads.merge',true), ('team_lead','pipeline.view',true), ('team_lead','meetings.view',true), ('team_lead','meetings.manage',true), ('team_lead','invoices.view',true), ('team_lead','invoices.create',true), ('team_lead','reports.view',true), ('team_lead','reports.export',true),
  ('manager','dashboard.view',true), ('manager','leads.view',true), ('manager','leads.create',true), ('manager','leads.edit',true), ('manager','leads.assign',true), ('manager','leads.merge',true), ('manager','pipeline.view',true), ('manager','automations.view',true), ('manager','automations.manage',true), ('manager','meetings.view',true), ('manager','meetings.manage',true), ('manager','invoices.view',true), ('manager','invoices.create',true), ('manager','reports.view',true), ('manager','reports.export',true),
  ('admin','dashboard.view',true), ('admin','leads.view',true), ('admin','leads.create',true), ('admin','leads.edit',true), ('admin','leads.assign',true), ('admin','leads.merge',true), ('admin','pipeline.view',true), ('admin','automations.view',true), ('admin','automations.manage',true), ('admin','integrations.view',true), ('admin','integrations.manage',true), ('admin','meetings.view',true), ('admin','meetings.manage',true), ('admin','invoices.view',true), ('admin','invoices.create',true), ('admin','invoices.approve',true), ('admin','reports.view',true), ('admin','reports.export',true), ('admin','users.view',true), ('admin','access.manage',true), ('admin','settings.manage',true),
  ('super_admin','dashboard.view',true), ('super_admin','leads.view',true), ('super_admin','leads.create',true), ('super_admin','leads.edit',true), ('super_admin','leads.assign',true), ('super_admin','leads.merge',true), ('super_admin','pipeline.view',true), ('super_admin','automations.view',true), ('super_admin','automations.manage',true), ('super_admin','integrations.view',true), ('super_admin','integrations.manage',true), ('super_admin','meetings.view',true), ('super_admin','meetings.manage',true), ('super_admin','invoices.view',true), ('super_admin','invoices.create',true), ('super_admin','invoices.approve',true), ('super_admin','reports.view',true), ('super_admin','reports.export',true), ('super_admin','users.view',true), ('super_admin','users.manage',true), ('super_admin','access.manage',true), ('super_admin','settings.manage',true)
on conflict (role, permission_key) do nothing;

alter table public.profiles enable row level security;
alter table public.role_permissions enable row level security;
alter table public.user_permission_overrides enable row level security;
alter table public.crm_settings enable row level security;
alter table public.lead_stages enable row level security;
alter table public.leads enable row level security;
alter table public.activities enable row level security;
alter table public.notes enable row level security;
alter table public.emails enable row level security;
alter table public.email_templates enable row level security;
alter table public.calls enable row level security;
alter table public.scheduled_calls enable row level security;
alter table public.saved_filters enable row level security;
alter table public.user_columns enable row level security;
alter table public.automations enable row level security;
alter table public.automation_logs enable row level security;
alter table public.notifications enable row level security;
alter table public.merge_logs enable row level security;
alter table public.report_downloads enable row level security;
alter table public.integrations enable row level security;
alter table public.lead_sources enable row level security;
alter table public.inbound_events enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.assignment_rules enable row level security;
alter table public.assignment_log enable row level security;
alter table public.user_availability enable row level security;
alter table public.ivr_events enable row level security;
alter table public.meetings enable row level security;
alter table public.meeting_attendees enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_items enable row level security;
alter table public.invoice_approvals enable row level security;
alter table public.payments enable row level security;
alter table public.audit_logs enable row level security;

create policy "Profiles are visible in hierarchy" on public.profiles for select to authenticated
using (id = auth.uid() or public.user_in_scope(id) or public.has_permission('users.view'));
create policy "Profile updates require user management" on public.profiles for update to authenticated
using (public.has_permission('users.manage')) with check (public.has_permission('users.manage'));

create policy "Users read role permissions" on public.role_permissions for select to authenticated using (true);
create policy "Admins manage role permissions" on public.role_permissions for all to authenticated
using (public.has_permission('access.manage')) with check (public.has_permission('access.manage'));
create policy "Users read own permission exceptions" on public.user_permission_overrides for select to authenticated
using (user_id = auth.uid() or public.has_permission('access.manage'));
create policy "Admins manage user permission exceptions" on public.user_permission_overrides for all to authenticated
using (public.has_permission('access.manage')) with check (public.has_permission('access.manage'));

create policy "Users read CRM settings" on public.crm_settings for select to authenticated using (true);
create policy "Admins manage CRM settings" on public.crm_settings for all to authenticated
using (public.has_permission('settings.manage')) with check (public.has_permission('settings.manage'));
create policy "Authenticated users read active lead stages" on public.lead_stages for select to authenticated using (is_active or public.has_permission('settings.manage'));
create policy "Admins manage lead stages" on public.lead_stages for all to authenticated
using (public.has_permission('settings.manage')) with check (public.has_permission('settings.manage'));

create policy "Read leads within hierarchy" on public.leads for select to authenticated
using (public.has_permission('leads.view') and (assignee_id = auth.uid() or public.user_in_scope(assignee_id) or public.has_permission('users.view')));
create policy "Create leads with permission" on public.leads for insert to authenticated
with check (public.has_permission('leads.create') and created_by = auth.uid());
create policy "Update leads within hierarchy" on public.leads for update to authenticated
using (public.has_permission('leads.edit') and (assignee_id = auth.uid() or public.user_in_scope(assignee_id) or public.has_permission('users.view')))
with check (public.has_permission('leads.edit') and (assignee_id = auth.uid() or public.user_in_scope(assignee_id) or public.has_permission('users.view')));

create policy "Read activities of accessible leads" on public.activities for select to authenticated
using (exists (select 1 from public.leads l where l.id = lead_id));
create policy "Create activities for accessible leads" on public.activities for insert to authenticated
with check (user_id = auth.uid() and exists (select 1 from public.leads l where l.id = lead_id));
create policy "Read notes of accessible leads" on public.notes for select to authenticated
using (exists (select 1 from public.leads l where l.id = lead_id));
create policy "Create notes for accessible leads" on public.notes for insert to authenticated
with check (user_id = auth.uid() and exists (select 1 from public.leads l where l.id = lead_id));

create policy "Users manage own saved filters" on public.saved_filters for all to authenticated
using (owner_id = auth.uid() or public.user_in_scope(owner_id))
with check (owner_id = auth.uid());
create policy "Users manage own columns" on public.user_columns for all to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Users read own notifications" on public.notifications for all to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Users read own report downloads" on public.report_downloads for select to authenticated
using (user_id = auth.uid() or public.has_permission('users.view'));
create policy "Users create own report download logs" on public.report_downloads for insert to authenticated
with check (user_id = auth.uid() and public.has_permission('reports.export'));

create policy "Authorized users read automations" on public.automations for select to authenticated
using (public.has_permission('automations.view'));
create policy "Authorized users manage automations" on public.automations for all to authenticated
using (public.has_permission('automations.manage')) with check (public.has_permission('automations.manage'));
create policy "Authorized users read integration status" on public.integrations for select to authenticated
using (public.has_permission('integrations.view'));
create policy "Admins manage integrations" on public.integrations for all to authenticated
using (public.has_permission('integrations.manage')) with check (public.has_permission('integrations.manage'));

create policy "Users read own calls" on public.calls for select to authenticated using (user_id = auth.uid());
create policy "Users create own calls" on public.calls for insert to authenticated with check (user_id = auth.uid());
create policy "Users read calls for accessible leads" on public.calls for select to authenticated
using (exists (select 1 from public.leads l where l.id = lead_id));
create policy "Users manage own scheduled calls" on public.scheduled_calls for all to authenticated
using (user_id = auth.uid() or exists (select 1 from public.leads l where l.id = lead_id))
with check (user_id = auth.uid());
create policy "Users manage own email templates" on public.email_templates for all to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Users read emails for accessible leads" on public.emails for select to authenticated
using (exists (select 1 from public.leads l where l.id = lead_id));
create policy "Users create emails for accessible leads" on public.emails for insert to authenticated
with check (user_id = auth.uid() and exists (select 1 from public.leads l where l.id = lead_id));
create policy "Users read meetings within scope" on public.meetings for select to authenticated
using (public.has_permission('meetings.view') and (host_id = auth.uid() or public.user_in_scope(host_id) or public.has_permission('users.view') or exists (select 1 from public.leads l where l.id = lead_id)));
create policy "Users create meetings within scope" on public.meetings for insert to authenticated
with check (public.has_permission('meetings.manage') and host_id = auth.uid());
create policy "Users read attendees for visible meetings" on public.meeting_attendees for select to authenticated
using (exists (select 1 from public.meetings m where m.id = meeting_id));
create policy "Users manage attendees for hosted meetings" on public.meeting_attendees for all to authenticated
using (exists (select 1 from public.meetings m where m.id = meeting_id and m.host_id = auth.uid()))
with check (exists (select 1 from public.meetings m where m.id = meeting_id and m.host_id = auth.uid()));

create policy "Users read invoices for accessible leads" on public.invoices for select to authenticated
using (public.has_permission('invoices.view') and exists (select 1 from public.leads l where l.id = lead_id));
create policy "Users create invoices for accessible leads" on public.invoices for insert to authenticated
with check (public.has_permission('invoices.create') and created_by = auth.uid() and exists (select 1 from public.leads l where l.id = lead_id));
create policy "Admins update invoices" on public.invoices for update to authenticated
using (public.has_permission('invoices.approve')) with check (public.has_permission('invoices.approve'));
create policy "Users read invoice items for visible invoices" on public.invoice_items for select to authenticated
using (exists (select 1 from public.invoices i where i.id = invoice_id));
create policy "Users add items to own draft invoices" on public.invoice_items for insert to authenticated
with check (exists (select 1 from public.invoices i where i.id = invoice_id and i.created_by = auth.uid() and i.status in ('pending_approval','sent')));
create policy "Users read invoice approvals" on public.invoice_approvals for select to authenticated
using (exists (select 1 from public.invoices i where i.id = invoice_id));
create policy "Users request invoice approval" on public.invoice_approvals for insert to authenticated
with check (requested_by = auth.uid());
create policy "Authorized users decide invoice approvals" on public.invoice_approvals for update to authenticated
using (public.has_permission('invoices.approve')) with check (public.has_permission('invoices.approve'));
create policy "Users read payments for visible invoices" on public.payments for select to authenticated
using (exists (select 1 from public.invoices i where i.id = invoice_id));

create policy "Users read merge logs for visible leads" on public.merge_logs for select to authenticated
using (exists (select 1 from public.leads l where l.id = master_lead_id));
create policy "Authorized users read assignment rules" on public.assignment_rules for select to authenticated
using (public.has_permission('automations.view'));
create policy "Authorized users manage assignment rules" on public.assignment_rules for all to authenticated
using (public.has_permission('automations.manage')) with check (public.has_permission('automations.manage'));
create policy "Users read assignment logs for visible leads" on public.assignment_log for select to authenticated
using (exists (select 1 from public.leads l where l.id = lead_id));
create policy "Users read availability in hierarchy" on public.user_availability for select to authenticated
using (user_id = auth.uid() or public.user_in_scope(user_id) or public.has_permission('users.view'));
create policy "Users update own availability" on public.user_availability for all to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Users read chat sessions for accessible leads" on public.chat_sessions for select to authenticated
using (exists (select 1 from public.leads l where l.id = lead_id));
create policy "Users read inbound events for accessible leads" on public.inbound_events for select to authenticated
using (lead_id is not null and exists (select 1 from public.leads l where l.id = lead_id));
create policy "Users read IVR events for accessible calls" on public.ivr_events for select to authenticated
using (exists (select 1 from public.calls c where c.id = call_id));
create policy "Admins read audit log" on public.audit_logs for select to authenticated
using (public.has_permission('users.view'));

create or replace function public.write_audit_log()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  before_row jsonb;
  after_row jsonb;
  row_id text;
begin
  if tg_op = 'INSERT' then
    after_row := to_jsonb(new);
    row_id := coalesce(after_row ->> 'id', after_row ->> 'user_id', after_row ->> 'setting_key');
  elsif tg_op = 'UPDATE' then
    before_row := to_jsonb(old);
    after_row := to_jsonb(new);
    row_id := coalesce(after_row ->> 'id', after_row ->> 'user_id', after_row ->> 'setting_key');
  else
    before_row := to_jsonb(old);
    row_id := coalesce(before_row ->> 'id', before_row ->> 'user_id', before_row ->> 'setting_key');
  end if;

  insert into public.audit_logs (actor_id, action, entity_type, entity_id, changes)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    row_id,
    jsonb_build_object('old', before_row, 'new', after_row)
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger audit_profiles after insert or update or delete on public.profiles
for each row execute function public.write_audit_log();
create trigger audit_role_permissions after insert or update or delete on public.role_permissions
for each row execute function public.write_audit_log();
create trigger audit_user_permission_overrides after insert or update or delete on public.user_permission_overrides
for each row execute function public.write_audit_log();
create trigger audit_crm_settings after insert or update or delete on public.crm_settings
for each row execute function public.write_audit_log();
create trigger audit_leads after insert or update or delete on public.leads
for each row execute function public.write_audit_log();
create trigger audit_invoices after insert or update or delete on public.invoices
for each row execute function public.write_audit_log();
