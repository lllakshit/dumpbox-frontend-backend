-- Email: conversations brought in from Gmail (by the Google Apps Script in public/dumpbox-gmail.gs), shown in their
-- own "Email" section as threads. Gmail owns the content, labels, star, importance, unread and priority; DumpBox
-- owns only pin, archive (hide here) and delete. Writes come only through /v1/email/import (server key, checked
-- import key), so signed-in users can read their mail and change the DumpBox-side flags, nothing else.

-- ---------------------------------------------------------------------------
create table public.email_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'gmail' check (provider in ('gmail')),
  external_id text not null check (char_length(external_id) between 1 and 200),
  subject text not null default '' check (char_length(subject) <= 1000),
  snippet text not null default '' check (char_length(snippet) <= 500),
  -- Last sender, shown in the list.
  from_name text check (char_length(from_name) <= 300),
  from_email text check (char_length(from_email) <= 320),
  participants text[] not null default '{}' check (cardinality(participants) <= 50),
  labels text[] not null default '{}' check (cardinality(labels) <= 100),
  message_count integer not null default 0 check (message_count >= 0),
  has_attachments boolean not null default false,
  -- From Gmail.
  starred boolean not null default false,
  important boolean not null default false,
  unread boolean not null default false,
  priority smallint check (priority between 1 and 3), -- 1 high, 2 medium, 3 low
  -- False when the conversation no longer has any label the script syncs: it then shows under Archived.
  in_scope boolean not null default true,
  first_message_at timestamptz,
  last_message_at timestamptz not null default now(),
  -- DumpBox only.
  pinned boolean not null default false,
  archived_at timestamptz,
  opened_at timestamptz,
  -- Newest message time that was in DumpBox when you last opened it (not the clock time: mail can reach Gmail
  -- before you open the conversation here and arrive with the next import, and must still count as new).
  seen_message_at timestamptz,
  -- In the inbox: not archived here and still under a synced label (otherwise it shows under Archived).
  in_inbox boolean generated always as (archived_at is null and in_scope) stored,
  -- Shown in bold: unread in Gmail and has a message you have not seen here.
  fresh boolean generated always as (unread and (seen_message_at is null or last_message_at > seen_message_at)) stored,
  -- Deleted here: content is removed and the row stays as a marker so the next import does not bring it back.
  deleted_at timestamptz,
  search_text text not null default '' check (octet_length(search_text) <= 60000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_threads_user_external_key unique (user_id, external_id)
);

comment on table public.email_threads is 'One email conversation (Gmail thread). Imported; DumpBox changes only pin, archive and delete.';

create index email_threads_list_idx on public.email_threads (user_id, last_message_at desc, id desc) where deleted_at is null;
create index email_threads_labels_idx on public.email_threads using gin (labels);
create index email_threads_search_idx on public.email_threads using gin (search_text extensions.gin_trgm_ops);

create table public.email_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  thread_id uuid not null references public.email_threads (id) on delete cascade,
  external_id text not null check (char_length(external_id) between 1 and 200),
  from_name text check (char_length(from_name) <= 300),
  from_email text check (char_length(from_email) <= 320),
  to_list text check (char_length(to_list) <= 4000),
  cc_list text check (char_length(cc_list) <= 4000),
  sent_at timestamptz not null,
  body_text text not null default '' check (octet_length(body_text) <= 200000),
  -- Names and sizes only; the files stay in Gmail.
  attachments jsonb not null default '[]' check (jsonb_typeof(attachments) = 'array' and jsonb_array_length(attachments) <= 50),
  unread boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_messages_user_external_key unique (user_id, external_id)
);

create index email_messages_thread_idx on public.email_messages (thread_id, sent_at);

-- Keys for the Gmail script: only a SHA-256 hash is stored, the key is shown once.
create table public.email_import_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label text not null default 'Gmail script' check (char_length(btrim(label)) between 1 and 80),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index email_import_keys_user_idx on public.email_import_keys (user_id, created_at);

-- ---------------------------------------------------------------------------
create or replace function public.email_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger email_threads_touch before update on public.email_threads for each row execute function public.email_touch();
create trigger email_messages_touch before update on public.email_messages for each row execute function public.email_touch();

-- A deleted conversation stays deleted: an import that races the delete cannot write content back into it, and
-- messages for it are dropped. (The import upserts; these guards make that safe without a read-then-write gap.)
create or replace function public.email_keep_tombstone() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.deleted_at is not null then
    return old;
  end if;
  return new;
end $$;
create trigger email_threads_keep_tombstone before update on public.email_threads for each row execute function public.email_keep_tombstone();

create or replace function public.email_skip_deleted_thread() returns trigger
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.email_threads t where t.id = new.thread_id and t.deleted_at is not null) then
    return null;
  end if;
  return new;
end $$;
create trigger email_messages_skip_deleted before insert or update on public.email_messages for each row execute function public.email_skip_deleted_thread();

-- Delete from DumpBox in one transaction: wipe the content, keep the marker, remove the messages.
create or replace function public.email_delete_thread(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    return false;
  end if;
  update public.email_threads
     set deleted_at = now(), subject = '', snippet = '', from_name = null, from_email = null, participants = '{}',
         labels = '{}', search_text = '', has_attachments = false, pinned = false
   where id = p_id and user_id = uid and deleted_at is null;
  if not found then
    return false;
  end if;
  delete from public.email_messages where thread_id = p_id and user_id = uid;
  return true;
end $$;
revoke all on function public.email_delete_thread(uuid) from public, anon;
grant execute on function public.email_delete_thread(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security: owners read; writes from signed-in users are limited by the grants below.
alter table public.email_threads enable row level security;
alter table public.email_messages enable row level security;
alter table public.email_import_keys enable row level security;

create policy email_threads_owner on public.email_threads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy email_messages_owner on public.email_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy email_import_keys_owner on public.email_import_keys for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.email_threads, public.email_messages, public.email_import_keys from anon;
-- Mail itself is written only by the import (server key). Signed-in users may change only the DumpBox-side flags;
-- deleting goes through email_delete_thread().
revoke insert, update, delete on public.email_threads from authenticated;
grant update (pinned, archived_at, opened_at, seen_message_at) on public.email_threads to authenticated;
revoke insert, update, delete on public.email_messages from authenticated;

-- ---------------------------------------------------------------------------
-- Label, priority and flag counts for the sidebar of the Email section (respects row-level security).
create or replace function public.email_counts()
returns table (kind text, name text, total bigint, fresh bigint)
language sql stable security invoker set search_path = '' as $$
  with live as (
    select * from public.email_threads
    where user_id = (select auth.uid()) and deleted_at is null and in_inbox
  )
  select 'label', l, count(*), count(*) filter (where t.fresh)
    from live t, unnest(t.labels) l group by l
  union all
  select 'priority', t.priority::text, count(*), count(*) filter (where t.fresh)
    from live t where t.priority is not null group by t.priority
  union all
  select 'all', 'all', count(*), count(*) filter (where fresh) from live
  union all
  select 'starred', 'starred', count(*), 0 from live where starred
  union all
  select 'pinned', 'pinned', count(*), 0 from live where pinned
  union all
  select 'unread', 'unread', count(*), 0 from live where unread
  union all
  select 'archived', 'archived', count(*), 0 from public.email_threads
    where user_id = (select auth.uid()) and deleted_at is null and not in_inbox
$$;
revoke all on function public.email_counts() from public, anon;
grant execute on function public.email_counts() to authenticated;
