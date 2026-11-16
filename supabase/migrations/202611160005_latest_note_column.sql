begin;

update public.user_columns
set columns_json = columns_json || '["latestNote"]'::jsonb
where view_name = 'leads'
  and jsonb_typeof(columns_json) = 'array'
  and columns_json <> '[]'::jsonb
  and not (columns_json ? 'latestNote');

commit;
