drop policy if exists "Users read own Gmail inbox" on public.gmail_messages;
create policy "Users read own Gmail inbox" on public.gmail_messages for select to authenticated
using (
  user_id = auth.uid()
  and (public.has_permission('integrations.view') or public.has_permission('leads.edit'))
);
