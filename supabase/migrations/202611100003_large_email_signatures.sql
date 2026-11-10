alter table public.profiles
  drop constraint profiles_email_signature_html_check,
  add constraint profiles_email_signature_html_check
    check (length(email_signature_html) <= 1000000);
