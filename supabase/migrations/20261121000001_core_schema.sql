-- DumpBox core schema: items, files, tags, collections, versions, share links, tombstones.
-- Every row belongs to exactly one user (user_id) and row-level security limits each user to their own rows.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Items: one captured unit (note, link, file, image, location, voice)
-- ---------------------------------------------------------------------------
create table public.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  type text not null check (type in ('note', 'link', 'file', 'image', 'location', 'voice')),
  title text check (char_length(title) <= 500),
  body text check (octet_length(body) <= 200000),
  source text not null default 'web' check (source in ('web', 'android', 'ios', 'desktop', 'extension', 'api')),
  -- link fields
  url text check (char_length(url) <= 4000),
  link_title text check (char_length(link_title) <= 1000),
  link_description text check (char_length(link_description) <= 4000),
  link_image_url text check (char_length(link_image_url) <= 4000),
  link_site text check (char_length(link_site) <= 300),
  -- location fields
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  location_label text check (char_length(location_label) <= 500),
  -- state
  pinned boolean not null default false,
  starred boolean not null default false,
  archived_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint items_location_complete check (type <> 'location' or (latitude is not null and longitude is not null)),
  constraint items_link_has_url check (type <> 'link' or url is not null)
);

comment on table public.items is 'One captured unit. Soft-deleted rows (deleted_at) live in trash for 30 days.';

create index items_feed_idx on public.items (user_id, created_at desc, id desc);
create index items_changes_idx on public.items (user_id, updated_at, id);
create index items_type_idx on public.items (user_id, type, created_at desc);

-- ---------------------------------------------------------------------------
-- Files attached to an item (stored in the private "items" storage bucket)
-- ---------------------------------------------------------------------------
create table public.files (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null check (char_length(mime_type) <= 255),
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  width integer,
  height integer,
  created_at timestamptz not null default now()
);

create index files_item_idx on public.files (item_id);
create index files_user_hash_idx on public.files (user_id, sha256);
create index files_name_trgm_idx on public.files using gin (file_name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Tags and collections (many-to-many with items)
-- ---------------------------------------------------------------------------
create table public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 50),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now()
);
create unique index tags_user_name_uidx on public.tags (user_id, lower(name));

create table public.item_tags (
  item_id uuid not null references public.items (id) on delete cascade,
  tag_id uuid not null references public.tags (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, tag_id)
);
create index item_tags_tag_idx on public.item_tags (tag_id);

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (char_length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index collections_user_name_uidx on public.collections (user_id, lower(name));

create table public.item_collections (
  item_id uuid not null references public.items (id) on delete cascade,
  collection_id uuid not null references public.collections (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, collection_id)
);
create index item_collections_collection_idx on public.item_collections (collection_id);

-- ---------------------------------------------------------------------------
-- Note version history (previous 10 versions of title/body)
-- ---------------------------------------------------------------------------
create table public.item_versions (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.items (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  version integer not null,
  title text,
  body text,
  created_at timestamptz not null default now()
);
create index item_versions_item_idx on public.item_versions (item_id, version desc);

-- ---------------------------------------------------------------------------
-- Tombstones: permanently deleted items, so offline devices learn about them through /v1/changes
-- ---------------------------------------------------------------------------
create table public.item_tombstones (
  item_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  deleted_at timestamptz not null default now()
);
create index item_tombstones_user_idx on public.item_tombstones (user_id, deleted_at);

-- ---------------------------------------------------------------------------
-- Share links (token stored only as a SHA-256 hash)
-- ---------------------------------------------------------------------------
create table public.share_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  item_id uuid references public.items (id) on delete cascade,
  collection_id uuid references public.collections (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  allow_download boolean not null default true,
  expires_at timestamptz,
  open_count integer not null default 0,
  last_opened_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint share_links_one_target check ((item_id is null) <> (collection_id is null))
);
create index share_links_user_idx on public.share_links (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Keep version and updated_at moving on every change, and save the previous title/body when they change.
-- security definer: it writes item_versions, which users may read but not write directly.
create or replace function public.items_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id cannot change' using errcode = '42501';
  end if;
  if new.type is distinct from old.type then
    raise exception 'type cannot change' using errcode = '22023';
  end if;
  new.created_at := old.created_at;
  new.version := old.version + 1;
  new.updated_at := clock_timestamp();
  if (new.body is distinct from old.body or new.title is distinct from old.title)
     and (old.body is not null or old.title is not null) then
    insert into public.item_versions (item_id, user_id, version, title, body)
    values (old.id, old.user_id, old.version, old.title, old.body);
    delete from public.item_versions v
    where v.item_id = old.id
      and v.id not in (
        select v2.id from public.item_versions v2 where v2.item_id = old.id order by v2.version desc limit 10
      );
  end if;
  return new;
end;
$$;

create trigger items_before_update
before update on public.items
for each row execute function public.items_before_update();

-- Server clock decides created_at/updated_at so the changes cursor cannot be skewed by a client.
create or replace function public.items_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := 1;
  new.updated_at := clock_timestamp();
  if new.created_at is null or new.created_at > now() + interval '5 minutes' then
    new.created_at := now();
  end if;
  return new;
end;
$$;

create trigger items_before_insert
before insert on public.items
for each row execute function public.items_before_insert();

-- Record a tombstone when an item is removed for good.
create or replace function public.items_after_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- When the whole account is being deleted, its user row is already gone: no device needs a tombstone.
  if exists (select 1 from auth.users u where u.id = old.user_id) then
    insert into public.item_tombstones (item_id, user_id, deleted_at)
    values (old.id, old.user_id, clock_timestamp())
    on conflict (item_id) do update set deleted_at = excluded.deleted_at;
  end if;
  return old;
end;
$$;

create trigger items_after_delete
after delete on public.items
for each row execute function public.items_after_delete();

-- Touching tags, collections or files bumps the item so other devices pick it up through /v1/changes.
create or replace function public.touch_parent_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target uuid := coalesce(new.item_id, old.item_id);
begin
  update public.items set updated_at = clock_timestamp() where id = target;
  return coalesce(new, old);
end;
$$;

create trigger item_tags_touch after insert or delete on public.item_tags
for each row execute function public.touch_parent_item();
create trigger item_collections_touch after insert or delete on public.item_collections
for each row execute function public.touch_parent_item();
create trigger files_touch after insert or delete on public.files
for each row execute function public.touch_parent_item();

-- Link rows must point at the caller's own rows (RLS checks user_id, this checks the targets).
create or replace function public.check_link_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'item_tags' then
    if not exists (select 1 from public.items i where i.id = new.item_id and i.user_id = new.user_id)
       or not exists (select 1 from public.tags t where t.id = new.tag_id and t.user_id = new.user_id) then
      raise exception 'item or tag not found' using errcode = '42501';
    end if;
  elsif tg_table_name = 'item_collections' then
    if not exists (select 1 from public.items i where i.id = new.item_id and i.user_id = new.user_id)
       or not exists (select 1 from public.collections c where c.id = new.collection_id and c.user_id = new.user_id) then
      raise exception 'item or collection not found' using errcode = '42501';
    end if;
  elsif tg_table_name = 'files' then
    if not exists (select 1 from public.items i where i.id = new.item_id and i.user_id = new.user_id) then
      raise exception 'item not found' using errcode = '42501';
    end if;
    if split_part(new.storage_path, '/', 1) <> new.user_id::text then
      raise exception 'storage path must start with the owner id' using errcode = '42501';
    end if;
  elsif tg_table_name = 'share_links' then
    if new.item_id is not null and not exists (select 1 from public.items i where i.id = new.item_id and i.user_id = new.user_id) then
      raise exception 'item not found' using errcode = '42501';
    end if;
    if new.collection_id is not null and not exists (select 1 from public.collections c where c.id = new.collection_id and c.user_id = new.user_id) then
      raise exception 'collection not found' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger item_tags_owner before insert or update on public.item_tags
for each row execute function public.check_link_owner();
create trigger item_collections_owner before insert or update on public.item_collections
for each row execute function public.check_link_owner();
create trigger files_owner before insert or update on public.files
for each row execute function public.check_link_owner();
create trigger share_links_owner before insert or update on public.share_links
for each row execute function public.check_link_owner();

create or replace function public.collections_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger collections_before_update before update on public.collections
for each row execute function public.collections_before_update();

-- ---------------------------------------------------------------------------
-- Row-level security: each user reaches only their own rows
-- ---------------------------------------------------------------------------
alter table public.items enable row level security;
alter table public.files enable row level security;
alter table public.tags enable row level security;
alter table public.item_tags enable row level security;
alter table public.collections enable row level security;
alter table public.item_collections enable row level security;
alter table public.item_versions enable row level security;
alter table public.item_tombstones enable row level security;
alter table public.share_links enable row level security;

create policy items_owner on public.items for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy files_owner on public.files for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy tags_owner on public.tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy item_tags_owner on public.item_tags for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy collections_owner on public.collections for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy item_collections_owner on public.item_collections for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy item_versions_owner_read on public.item_versions for select to authenticated
  using (user_id = (select auth.uid()));
create policy item_tombstones_owner_read on public.item_tombstones for select to authenticated
  using (user_id = (select auth.uid()));
create policy share_links_owner on public.share_links for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Anonymous visitors get nothing directly; public share pages are served by the API with a server key.
revoke all on all tables in schema public from anon;

-- ---------------------------------------------------------------------------
-- Realtime: devices listen for item changes, then pull /v1/changes
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table public.items;
alter publication supabase_realtime add table public.item_tombstones;
