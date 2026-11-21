-- Hardening after review: strict file paths, file rows written only by the API, helpers that avoid row caps.

-- 1. A file's storage path must be exactly "<owner>/<item>/<file id>-<safe name>". No "..", no other folders.
create or replace function public.check_file_path()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.storage_path !~ ('^' || new.user_id::text || '/' || new.item_id::text || '/' || new.id::text || '-[A-Za-z0-9_-]{1,80}(\.[a-z0-9]{1,10})?$') then
    raise exception 'invalid storage path' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger files_path before insert or update on public.files
for each row execute function public.check_file_path();

-- Users read and delete their file rows; only the API (server key, after its own checks) creates or changes them.
revoke insert, update on public.files from authenticated;

-- 2. Usage in one query (no 1,000-row cap).
create or replace function public.account_usage()
returns table (items bigint, files bigint, storage_bytes bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    (select count(*) from public.items where deleted_at is null),
    (select count(*) from public.files),
    (select coalesce(sum(size_bytes), 0)::bigint from public.files);
$$;
revoke all on function public.account_usage() from public, anon;
grant execute on function public.account_usage() to authenticated;

-- 3. After a tag rename, bump every item carrying it so other devices pick up the new name.
create or replace function public.touch_tag_items(p_tag uuid)
returns integer
language sql
security invoker
set search_path = ''
as $$
  with t as (
    update public.items set updated_at = clock_timestamp()
    where id in (select item_id from public.item_tags where tag_id = p_tag)
    returning 1
  )
  select count(*)::int from t;
$$;
revoke all on function public.touch_tag_items(uuid) from public, anon;
grant execute on function public.touch_tag_items(uuid) to authenticated;

-- 4. Atomic open counter for share links (called by the API with the server key).
create or replace function public.count_share_open(p_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.share_links set open_count = open_count + 1, last_opened_at = now() where id = p_id;
$$;
revoke all on function public.count_share_open(uuid) from public, anon, authenticated;
grant execute on function public.count_share_open(uuid) to service_role;
