-- Operational RPCs are security-invoker: verified-session and hierarchy RLS still apply.
alter table public.invoices add column payment_lock_at timestamptz;
alter table public.invoices add column email_message_id text;
alter table public.invoices add column email_lock_at timestamptz;

drop policy "Users create invoices for accessible leads" on public.invoices;
create policy "Users create invoices for accessible leads" on public.invoices for insert to authenticated
with check (public.has_permission('invoices.create') and created_by = auth.uid()
  and status = 'pending_approval' and approved_by is null and approved_at is null and paid_at is null
  and razorpay_qr_id is null and qr_image_url is null and qr_expires_at is null
  and email_message_id is null and sent_at is null and payment_lock_at is null and email_lock_at is null
  and discount_amount >= 0 and discount_amount <= subtotal and total = subtotal + tax_amount - discount_amount
  and exists (select 1 from public.leads l where l.id = lead_id));
drop policy "Admins update invoices" on public.invoices;
create policy "Admins update invoices" on public.invoices for update to authenticated
using (public.has_permission('invoices.approve') and status = 'pending_approval')
with check (public.has_permission('invoices.approve') and status in ('sent','rejected')
  and approved_by = auth.uid() and approved_at is not null and paid_at is null
  and razorpay_qr_id is null and qr_image_url is null and qr_expires_at is null
  and email_message_id is null and sent_at is null and payment_lock_at is null and email_lock_at is null
  and discount_amount >= 0 and discount_amount <= subtotal and total = subtotal + tax_amount - discount_amount);
drop policy "Users request invoice approval" on public.invoice_approvals;
create policy "Users request invoice approval" on public.invoice_approvals for insert to authenticated
with check (requested_by = auth.uid() and exists (
  select 1 from public.invoices i where i.id = invoice_id and i.created_by = auth.uid() and i.status = 'pending_approval'));

create policy "Hosts update meetings" on public.meetings for update to authenticated
using (public.has_permission('meetings.manage') and host_id = auth.uid())
with check (public.has_permission('meetings.manage') and host_id = auth.uid());
create policy "Authorized users read automation logs" on public.automation_logs for select to authenticated
using (public.has_permission('automations.view') and (lead_id is null or exists (select 1 from public.leads l where l.id = lead_id)));
create policy "Authorized users create automation logs" on public.automation_logs for insert to authenticated
with check (public.has_permission('automations.manage') and exists (select 1 from public.leads l where l.id = lead_id));

create function public.operational_create_invoice(p_input jsonb)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid := gen_random_uuid();
  v_subtotal numeric(12,2);
  v_discount numeric(12,2) := round((p_input->>'discount_amount')::numeric, 2);
  v_tax numeric(12,2) := round((p_input->>'tax_amount')::numeric, 2);
begin
  if not public.has_permission('invoices.create') then raise exception 'Not authorized'; end if;
  v_subtotal := round((p_input->>'quantity')::numeric * (p_input->>'unit_price')::numeric, 2);
  if v_discount < 0 or v_discount > v_subtotal or v_tax < 0 or
    (v_discount > 0 and coalesce(trim(p_input->>'discount_reason'), '') = '') then raise exception 'Invalid invoice amounts or discount reason'; end if;
  insert into public.invoices(id, invoice_no, lead_id, created_by, status, subtotal, tax_amount,
    discount_type, discount_value, discount_amount, discount_reason, total, due_date, notes)
  values (v_id, 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''),1,12)),
    (p_input->>'lead_id')::uuid, auth.uid(), 'pending_approval', v_subtotal, v_tax, 'amount',
    v_discount, v_discount, p_input->>'discount_reason', v_subtotal - v_discount + v_tax,
    (p_input->>'due_date')::date, p_input->>'notes');
  insert into public.invoice_items(invoice_id, description, quantity, unit_price, amount)
    values(v_id, p_input->>'description', (p_input->>'quantity')::numeric, (p_input->>'unit_price')::numeric, v_subtotal);
  insert into public.invoice_approvals(invoice_id, requested_by) values(v_id, auth.uid());
  return v_id;
end $$;

create function public.operational_decide_invoice(p_id uuid, p_decision text, p_comment text)
returns void language plpgsql security invoker set search_path = public as $$
declare v_invoice public.invoices;
begin
  if not public.has_permission('invoices.approve') then raise exception 'Not authorized'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  select * into v_invoice from public.invoices where id = p_id for update;
  if not found or v_invoice.status <> 'pending_approval' then raise exception 'Invoice unavailable or already decided'; end if;
  update public.invoices set status = case when p_decision = 'approved' then 'sent'::public.invoice_status else 'rejected'::public.invoice_status end,
    approved_by = auth.uid(), approved_at = now() where id = p_id;
  update public.invoice_approvals set decision = p_decision, decided_by = auth.uid(), comment = p_comment, decided_at = now()
    where invoice_id = p_id and decision = 'pending';
end $$;

create function public.operational_run_automation(p_id uuid, p_lead_id uuid default null)
returns integer language plpgsql security invoker set search_path = public as $$
declare
  v_rule public.automations;
  v_lead public.leads;
  v_action text;
  v_trigger text;
  v_count integer := 0;
  v_days integer;
begin
  if not public.has_permission('automations.manage') then raise exception 'Not authorized'; end if;
  -- Serializes repeated runs of this rule; log insertion and action are one transaction.
  select * into v_rule from public.automations where id = p_id for update;
  if not found or not v_rule.is_active then raise exception 'Rule is missing or paused'; end if;
  v_trigger := v_rule.trigger_config->>'type';
  v_action := v_rule.actions_json->0->>'type';
  v_days := (v_rule.actions_json->0->>'days')::integer;
  if v_trigger is null or v_trigger not in ('manual','followup_overdue')
    or v_action is null or v_action not in ('notify_me','set_followup')
    or v_days is null or v_days < 1 or v_days > 365 then raise exception 'Unsupported rule configuration'; end if;
  if v_trigger = 'manual' and p_lead_id is null then raise exception 'Choose an accessible lead'; end if;
  if v_action = 'set_followup' and not public.has_permission('leads.edit') then raise exception 'Lead editing permission required'; end if;
  for v_lead in select * from public.leads l
    where not l.is_archived and l.merged_into_id is null and
      ((v_trigger = 'manual' and l.id = p_lead_id) or (v_trigger = 'followup_overdue' and l.next_followup_at < now()))
      and not exists (select 1 from public.automation_logs al where al.automation_id = p_id and al.lead_id = l.id
        and al.result = 'success' and al.created_at >= date_trunc('day', now())
        and al.details->>'actor_id' = auth.uid()::text)
    order by l.next_followup_at nulls last limit 100
  loop
    if v_action = 'notify_me' then
      insert into public.notifications(user_id, type, payload) values(auth.uid(), 'automation',
        jsonb_build_object('lead_id', v_lead.id, 'message', v_rule.name, 'lead_name', v_lead.name));
    else
      update public.leads set next_followup_at = now() + make_interval(days => v_days), modified_by = auth.uid() where id = v_lead.id;
      if not found then raise exception 'Lead update denied'; end if;
    end if;
    insert into public.automation_logs(automation_id, lead_id, result, details) values(p_id, v_lead.id, 'success',
      jsonb_build_object('action', v_action, 'actor_id', auth.uid()));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Only the authenticated, signed Razorpay webhook handler may call this using the service role.
create function public.operational_record_payment(p_invoice_id uuid, p_qr_id text, p_payment_id text, p_amount_paise bigint, p_method text, p_payload jsonb)
returns boolean language plpgsql security invoker set search_path = public as $$
declare v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found or v_invoice.razorpay_qr_id is distinct from p_qr_id
    or v_invoice.status not in ('sent','paid') or round(v_invoice.total * 100)::bigint <> p_amount_paise then
    raise exception 'Payment does not match an approved invoice';
  end if;
  if exists (select 1 from public.payments where razorpay_payment_id = p_payment_id) then return false; end if;
  insert into public.payments(invoice_id, razorpay_payment_id, amount, method, status, paid_at, raw_payload)
    values(p_invoice_id, p_payment_id, p_amount_paise::numeric / 100, p_method, 'captured', now(), p_payload);
  update public.invoices set status = 'paid', paid_at = coalesce(paid_at, now()) where id = p_invoice_id;
  return true;
end $$;

revoke all on function public.operational_create_invoice(jsonb) from public, anon;
revoke all on function public.operational_decide_invoice(uuid,text,text) from public, anon;
revoke all on function public.operational_run_automation(uuid,uuid) from public, anon;
revoke all on function public.operational_record_payment(uuid,text,text,bigint,text,jsonb) from public, anon, authenticated;
grant execute on function public.operational_create_invoice(jsonb) to authenticated;
grant execute on function public.operational_decide_invoice(uuid,text,text) to authenticated;
grant execute on function public.operational_run_automation(uuid,uuid) to authenticated;
grant execute on function public.operational_record_payment(uuid,text,text,bigint,text,jsonb) to service_role;
