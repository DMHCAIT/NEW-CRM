alter table public.profiles add column email_signature_html text not null default ''
  check (length(email_signature_html) <= 20000);
alter table public.emails add column body_html text;
