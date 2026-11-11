begin;

alter table public.note_images drop constraint note_images_image_data_check;
alter table public.note_images add constraint note_images_image_data_check
  check (octet_length(image_data) between 1 and 5000000);

create or replace function public.add_live_lead_note(lead_id uuid, note_content text, images_json jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare note_id uuid; image jsonb; image_bytes bytea; image_type text;
begin
  if not public.is_verified_session() or not public.has_permission('leads.edit') then
    raise exception 'Lead edit permission required';
  end if;
  if not exists (select 1 from public.leads l where l.id = lead_id and not l.is_archived
    and (l.assignee_id = auth.uid() or public.user_in_scope(l.assignee_id) or public.has_permission('users.view')))
  then raise exception 'Lead not found within your accessible scope'; end if;
  if jsonb_typeof(images_json) is distinct from 'array' or jsonb_array_length(images_json) not between 1 and 3
    or note_content is null or length(note_content) > 10000 then raise exception 'Invalid note or image count'; end if;
  insert into public.notes(lead_id,user_id,content) values(lead_id,auth.uid(),btrim(note_content)) returning id into note_id;
  for image in select value from jsonb_array_elements(images_json) loop
    if jsonb_typeof(image->'filename') is distinct from 'string'
      or jsonb_typeof(image->'data') is distinct from 'string'
      or length(image->>'data') > 6666668
      or image->>'data' !~ '^[A-Za-z0-9+/]*={0,2}$'
    then raise exception 'Invalid image data'; end if;
    image_bytes := decode(image->>'data','base64');
    if octet_length(image_bytes) not between 1 and 5000000
      or replace(encode(image_bytes,'base64'), E'\n', '') <> image->>'data'
    then raise exception 'Each note image must be no larger than 5 MB and contain valid image data'; end if;
    image_type := case
      when octet_length(image_bytes) >= 24 and encode(substring(image_bytes from 1 for 8),'hex') = '89504e470d0a1a0a'
        and substring(image_bytes from 13 for 4) = convert_to('IHDR','UTF8') then 'image/png'
      when octet_length(image_bytes) >= 12 and encode(substring(image_bytes from 1 for 3),'hex') = 'ffd8ff' then 'image/jpeg'
      when octet_length(image_bytes) >= 13 and substring(image_bytes from 1 for 6) in (convert_to('GIF87a','UTF8'),convert_to('GIF89a','UTF8')) then 'image/gif'
      when octet_length(image_bytes) >= 20 and substring(image_bytes from 1 for 4) = convert_to('RIFF','UTF8')
        and substring(image_bytes from 9 for 4) = convert_to('WEBP','UTF8') then 'image/webp'
      else null end;
    if image_type is null or image_type is distinct from image->>'type' then raise exception 'Unsupported image contents'; end if;
    insert into public.note_images(note_id,filename,mime_type,image_data)
      values(note_id,image->>'filename',image_type,image_bytes);
  end loop;
  return note_id;
end $$;

notify pgrst, 'reload schema';
commit;
