-- Planner: calendars and task lists (planner_lists), events and tasks (planner_entries).
-- Same rules as items: one owner per row, row-level security, server clock for updated_at/version, soft delete so
-- other devices learn about removals through /v1/planner/changes.

create table public.planner_lists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('calendar', 'tasks')),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  color text not null default '#3a5bd9' check (color ~ '^#[0-9a-fA-F]{6}$'),
  is_default boolean not null default false,
  hidden boolean not null default false,
  position integer not null default 0,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.planner_lists is 'Calendars (kind calendar) and task lists (kind tasks). One default of each kind per user.';

create unique index planner_lists_default_uidx on public.planner_lists (user_id, kind) where is_default;
create unique index planner_lists_name_uidx on public.planner_lists (user_id, kind, lower(name));

create table public.planner_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('event', 'task')),
  list_id uuid references public.planner_lists (id) on delete set null,
  parent_id uuid references public.planner_entries (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 1000),
  notes text check (octet_length(notes) <= 50000),
  location text check (char_length(location) <= 1000),
  -- Timing. Timed: start_at/end_at. All day: start_date/end_date (end inclusive). A task may have no date at all.
  all_day boolean not null default false,
  start_at timestamptz,
  end_at timestamptz,
  start_date date,
  end_date date,
  time_zone text check (char_length(time_zone) <= 64),
  -- Repeat rule (RFC 5545 subset, e.g. FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10) and removed occurrences (their start keys).
  rrule text check (char_length(rrule) <= 500 and rrule ~ '^[A-Z0-9=;,:+-]*$'),
  exdates text[] not null default '{}' check (cardinality(exdates) <= 500),
  -- Reminders, in minutes before the start (or before 09:00 on the day, for all-day / date-only).
  reminders integer[] not null default '{}' check (cardinality(reminders) <= 5 and 0 <= all(reminders) and 40320 >= all(reminders)),
  color text check (color ~ '^#[0-9a-fA-F]{6}$'),
  completed_at timestamptz,
  starred boolean not null default false,
  position double precision not null default 0,
  source_item_id uuid references public.items (id) on delete set null,
  external_id text check (char_length(external_id) <= 500),
  deleted_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint planner_event_has_time check (
    kind <> 'event' or (case when all_day then start_date is not null else start_at is not null end)
  ),
  constraint planner_timing_matches check (
    (all_day and start_at is null and end_at is null) or (not all_day and start_date is null and end_date is null)
  ),
  constraint planner_end_after_start check (
    (end_at is null or (start_at is not null and end_at >= start_at)) and
    (end_date is null or (start_date is not null and end_date >= start_date))
  ),
  constraint planner_no_self_parent check (parent_id is null or parent_id <> id)
);

comment on table public.planner_entries is 'Events and tasks. Soft-deleted rows (deleted_at) are purged after 90 days.';

create index planner_entries_changes_idx on public.planner_entries (user_id, updated_at, id);
create index planner_entries_start_at_idx on public.planner_entries (user_id, start_at) where deleted_at is null;
create index planner_entries_start_date_idx on public.planner_entries (user_id, start_date) where deleted_at is null;
create index planner_entries_list_idx on public.planner_entries (list_id);
create index planner_entries_parent_idx on public.planner_entries (parent_id);
create index planner_entries_source_idx on public.planner_entries (source_item_id);
create unique index planner_entries_external_uidx on public.planner_entries (user_id, external_id) where external_id is not null;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create or replace function public.planner_before_insert()
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

create or replace function public.planner_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id then
    raise exception 'user_id cannot change' using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  new.version := old.version + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger planner_lists_before_insert before insert on public.planner_lists
for each row execute function public.planner_before_insert();
create trigger planner_lists_before_update before update on public.planner_lists
for each row execute function public.planner_before_update();
create trigger planner_entries_before_insert before insert on public.planner_entries
for each row execute function public.planner_before_insert();
create trigger planner_entries_before_update before update on public.planner_entries
for each row execute function public.planner_before_update();

-- Lists, parents and source items must belong to the same user (RLS checks user_id, this checks the targets).
create or replace function public.planner_check_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.list_id is not null and not exists (select 1 from public.planner_lists l where l.id = new.list_id and l.user_id = new.user_id) then
    raise exception 'list not found' using errcode = '42501';
  end if;
  if new.parent_id is not null and not exists (select 1 from public.planner_entries p where p.id = new.parent_id and p.user_id = new.user_id) then
    raise exception 'parent not found' using errcode = '42501';
  end if;
  if new.source_item_id is not null and not exists (select 1 from public.items i where i.id = new.source_item_id and i.user_id = new.user_id) then
    raise exception 'item not found' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger planner_entries_owner before insert or update on public.planner_entries
for each row execute function public.planner_check_owner();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.planner_lists enable row level security;
alter table public.planner_entries enable row level security;

create policy planner_lists_owner on public.planner_lists for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy planner_entries_owner on public.planner_entries for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.planner_lists, public.planner_entries from anon;

-- Realtime nudges (only used where the direct connection works; otherwise devices poll).
alter publication supabase_realtime add table public.planner_entries;
alter publication supabase_realtime add table public.planner_lists;

-- ---------------------------------------------------------------------------
-- Secret calendar feed: a read-only address for the phone's background reminder check and for subscribing from
-- other calendar apps. Only a SHA-256 hash of the token is stored; it can be replaced or turned off at any time.
-- ---------------------------------------------------------------------------
create table public.planner_feed_tokens (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

alter table public.planner_feed_tokens enable row level security;
create policy planner_feed_tokens_owner on public.planner_feed_tokens for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.planner_feed_tokens from anon;
