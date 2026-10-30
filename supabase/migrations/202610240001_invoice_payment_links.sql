alter table public.invoices
  add column payment_type text not null default 'one_shot'
    check (payment_type in ('one_shot', 'emi', 'loan', 'installments')),
  add column discount_percent numeric(5,2) not null default 0
    check (discount_percent >= 0 and discount_percent <= 100),
  add column course_total numeric(12,2),
  add column parent_invoice_id uuid references public.invoices(id),
  add column razorpay_payment_link_id text unique,
  add column razorpay_short_url text,
  add column status_token_hash text unique,
  add column creator_email text,
  add column payment_link_lock_at timestamptz,
  add column receipt_email_message_id text,
  add column receipt_email_lock_at timestamptz,
  add column external_payment_reference text,
  add column external_payment_evidence text,
  add column payment_verified_by uuid references public.profiles(id),
  add column payment_verified_at timestamptz;

update public.invoices
set discount_percent = greatest(0, least(100, case
  when discount_type = 'percentage' then round(discount_value, 2)
  when subtotal > 0 then round(discount_amount / subtotal * 100, 2)
  else 0
end))
where discount_amount > 0;

create index invoices_parent_invoice_id_idx on public.invoices(parent_invoice_id) where parent_invoice_id is not null;

alter table public.payments
  add column payment_link_id text,
  add column external_reference text,
  add column verified_by uuid references public.profiles(id);

create unique index payments_external_reference_key
  on public.payments(external_reference) where external_reference is not null;

drop policy "Users create invoices for accessible leads" on public.invoices;
create policy "Users create invoices for accessible leads" on public.invoices for insert to authenticated
with check (public.has_permission('invoices.create') and created_by = auth.uid()
  and status in ('pending_approval', 'sent') and approved_by is null and approved_at is null and paid_at is null
  and razorpay_qr_id is null and qr_image_url is null and qr_expires_at is null
  and razorpay_payment_link_id is null and razorpay_short_url is null and status_token_hash is null
  and email_message_id is null and sent_at is null and payment_lock_at is null and email_lock_at is null
  and discount_amount >= 0 and discount_amount <= subtotal and total = subtotal + tax_amount - discount_amount
  and exists (select 1 from public.leads l where l.id = lead_id));

create or replace function public.operational_create_invoice(p_input jsonb)
returns uuid language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid := gen_random_uuid();
  v_root uuid;
  v_subtotal numeric(12,2);
  v_course_total numeric(12,2);
  v_discount_percent numeric(5,2) := coalesce((p_input->>'discount_percent')::numeric, 0);
  v_discount numeric(12,2);
  v_tax numeric(12,2) := round(coalesce((p_input->>'tax_amount')::numeric, 0), 2);
  v_total numeric(12,2);
  v_payment_type text := coalesce(p_input->>'payment_type', 'one_shot');
  v_parent uuid := nullif(p_input->>'parent_invoice_id', '')::uuid;
  v_is_discounted boolean;
  v_parent_type text;
  v_parent_status public.invoice_status;
begin
  if not public.has_permission('invoices.create') then raise exception 'Not authorized'; end if;
  if v_payment_type not in ('one_shot','emi','loan','installments') then raise exception 'Invalid payment type'; end if;
  v_subtotal := round((p_input->>'quantity')::numeric * (p_input->>'unit_price')::numeric, 2);
  if v_discount_percent < 0 or v_discount_percent > 100 or v_tax < 0 then raise exception 'Invalid invoice amounts'; end if;
  v_discount := round(v_subtotal * v_discount_percent / 100, 2);
  v_total := v_subtotal - v_discount + v_tax;
  v_course_total := round(coalesce(nullif(p_input->>'course_total','')::numeric, v_total), 2);
  v_is_discounted := v_discount_percent > 0;
  if v_is_discounted and coalesce(trim(p_input->>'discount_reason'), '') = '' then
    raise exception 'Discount reason is required';
  end if;
  if not v_is_discounted and coalesce(trim(p_input->>'discount_reason'), '') <> '' then
    raise exception 'Discount reason requires a discount';
  end if;
  if v_total <= 0 or v_course_total < v_total then raise exception 'Invoice total must be positive and not exceed the course total'; end if;
  if v_payment_type in ('one_shot','installments') and v_total < 1 then
    raise exception 'Razorpay Payment Links require an invoice total of at least one currency unit';
  end if;

  if v_parent is not null then
    select coalesce(parent_invoice_id, id), course_total, payment_type, status
      into v_root, v_course_total, v_parent_type, v_parent_status
      from public.invoices where id = v_parent and lead_id = (p_input->>'lead_id')::uuid;
    if v_root is null or v_course_total is null or v_payment_type <> 'installments'
      or v_parent_type <> 'installments' or v_parent_status not in ('sent','paid') then
      raise exception 'Invalid installment parent';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_root::text));
    select course_total into v_course_total from public.invoices where id = v_root and lead_id = (p_input->>'lead_id')::uuid;
    if v_course_total is null then raise exception 'Invalid installment course'; end if;
    if exists (select 1 from public.invoices where coalesce(parent_invoice_id,id) = v_root and status in ('sent','pending_approval')) then
      raise exception 'An unpaid or pending installment already exists for this course';
    end if;
    if v_total > v_course_total - (select coalesce(sum(total),0) from public.invoices
      where coalesce(parent_invoice_id,id) = v_root and status = 'paid') then
      raise exception 'Installment exceeds the remaining course balance';
    end if;
  elsif v_payment_type = 'installments' then
    v_root := v_id;
    if v_course_total < v_total then raise exception 'Installment exceeds the course total'; end if;
  else
    v_course_total := v_total;
  end if;

  insert into public.invoices(id, invoice_no, lead_id, created_by, status, subtotal, tax_amount,
    discount_type, discount_value, discount_percent, discount_amount, discount_reason, total,
    due_date, notes, payment_type, course_total, parent_invoice_id, creator_email)
  values (v_id, 'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substr(replace(v_id::text, '-', ''),1,12)),
    (p_input->>'lead_id')::uuid, auth.uid(), case when v_is_discounted then 'pending_approval'::public.invoice_status else 'sent'::public.invoice_status end,
    v_subtotal, v_tax, 'percentage', v_discount_percent, v_discount_percent, v_discount,
    nullif(trim(p_input->>'discount_reason'), ''), v_total, (p_input->>'due_date')::date,
    p_input->>'notes', v_payment_type, v_course_total, v_parent, auth.jwt()->>'email');
  insert into public.invoice_items(invoice_id, description, quantity, unit_price, amount)
    values(v_id, p_input->>'description', (p_input->>'quantity')::numeric, (p_input->>'unit_price')::numeric, v_subtotal);
  if v_is_discounted then
    insert into public.invoice_approvals(invoice_id, requested_by) values(v_id, auth.uid());
  end if;
  return v_id;
end $$;

create or replace function public.operational_decide_invoice(p_id uuid, p_decision text, p_comment text)
returns void language plpgsql security invoker set search_path = public as $$
declare v_invoice public.invoices;
begin
  if not public.has_permission('invoices.approve') then raise exception 'Not authorized'; end if;
  if p_decision is null or p_decision not in ('approved','rejected') then raise exception 'Invalid decision'; end if;
  select * into v_invoice from public.invoices where id = p_id for update;
  if not found or v_invoice.status <> 'pending_approval' or v_invoice.discount_percent <= 0 then
    raise exception 'Discount request unavailable or already decided';
  end if;
  update public.invoices set status = case when p_decision = 'approved' then 'sent'::public.invoice_status else 'rejected'::public.invoice_status end,
    approved_by = auth.uid(), approved_at = now() where id = p_id;
  update public.invoice_approvals set decision = p_decision, decided_by = auth.uid(), comment = p_comment, decided_at = now()
    where invoice_id = p_id and decision = 'pending';
end $$;

create or replace function public.operational_record_payment_link(
  p_invoice_id uuid, p_link_id text, p_payment_id text, p_amount_paise bigint,
  p_currency text, p_method text, p_payload jsonb
) returns boolean language plpgsql security invoker set search_path = public as $$
declare v_invoice public.invoices;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found or v_invoice.razorpay_payment_link_id is distinct from p_link_id
    or v_invoice.status not in ('sent','paid') or v_invoice.currency <> p_currency
    or round(v_invoice.total * 100)::bigint <> p_amount_paise then
    raise exception 'Payment does not match an approved invoice';
  end if;
  if exists (select 1 from public.payments where razorpay_payment_id = p_payment_id) then return false; end if;
  if v_invoice.status <> 'sent' then raise exception 'Invoice is already paid'; end if;
  insert into public.payments(invoice_id, razorpay_payment_id, payment_link_id, amount, method, status, paid_at, raw_payload)
    values(p_invoice_id, p_payment_id, p_link_id, p_amount_paise::numeric / 100, p_method, 'captured', now(), p_payload);
  update public.invoices set status = 'paid', paid_at = coalesce(paid_at, now()) where id = p_invoice_id;
  return true;
end $$;

create or replace function public.operational_confirm_external_payment(
  p_invoice_id uuid, p_reference text, p_evidence text
) returns void language plpgsql security definer set search_path = public as $$
declare v_invoice public.invoices;
begin
  if auth.uid() is null or not public.has_permission('invoices.approve') then raise exception 'Not authorized'; end if;
  if coalesce(trim(p_reference),'') = '' or length(trim(p_reference)) > 200
    or coalesce(trim(p_evidence),'') = '' or length(trim(p_evidence)) > 2000 then
    raise exception 'Payment reference and evidence are required';
  end if;
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice unavailable'; end if;
  if not exists (
    select 1 from public.leads l where l.id = v_invoice.lead_id
      and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view'))
  ) then raise exception 'Invoice unavailable'; end if;
  if v_invoice.status = 'paid' and v_invoice.payment_type in ('emi','loan')
    and v_invoice.external_payment_reference = p_reference then return; end if;
  if v_invoice.status <> 'sent' or v_invoice.payment_type not in ('emi','loan') then
    raise exception 'Only unpaid EMI or loan invoices can be verified externally';
  end if;
  insert into public.payments(invoice_id, razorpay_payment_id, external_reference, amount, method, status, paid_at, raw_payload, verified_by)
    values(p_invoice_id, 'external:' || p_reference, p_reference, v_invoice.total, v_invoice.payment_type, 'verified_external', now(),
      jsonb_build_object('evidence', p_evidence), auth.uid());
  update public.invoices set status = 'paid', paid_at = now(), external_payment_reference = p_reference,
    external_payment_evidence = p_evidence, payment_verified_by = auth.uid(), payment_verified_at = now()
    where id = p_invoice_id;
end $$;

revoke all on function public.operational_record_payment_link(uuid,text,text,bigint,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.operational_confirm_external_payment(uuid,text,text) from public, anon;
grant execute on function public.operational_record_payment_link(uuid,text,text,bigint,text,text,jsonb) to service_role;
grant execute on function public.operational_confirm_external_payment(uuid,text,text) to authenticated;
