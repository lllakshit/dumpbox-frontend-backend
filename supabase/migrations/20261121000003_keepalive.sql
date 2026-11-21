-- Keepalive: a tiny write the scheduled jobs make so a free-tier project never counts as idle (Supabase pauses
-- projects after 7 days without activity). One row, updated in place.

create table public.keepalive (
  id smallint primary key default 1 check (id = 1),
  pinged_at timestamptz not null default now(),
  source text not null default 'cron'
);
alter table public.keepalive enable row level security;
revoke all on public.keepalive from anon, authenticated;

-- Callable with the publishable key; it only moves one timestamp, so there is nothing to abuse.
create or replace function public.keepalive(p_source text default 'cron')
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  t timestamptz;
begin
  insert into public.keepalive (id, pinged_at, source)
  values (1, now(), left(coalesce(nullif(btrim(p_source), ''), 'cron'), 40))
  on conflict (id) do update set pinged_at = excluded.pinged_at, source = excluded.source
  returning pinged_at into t;
  return t;
end;
$$;

revoke all on function public.keepalive(text) from public;
grant execute on function public.keepalive(text) to anon, authenticated, service_role;
