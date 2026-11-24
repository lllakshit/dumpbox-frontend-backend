-- Planner database tests: row-level security, ownership checks, timing rules, version bumps.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email, aud, role) values
  ('33333333-3333-3333-3333-333333333333', 'pa@test.dev', 'authenticated', 'authenticated'),
  ('44444444-4444-4444-4444-444444444444', 'pb@test.dev', 'authenticated', 'authenticated');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);

insert into public.planner_lists (id, kind, name, is_default) values
  ('cccccccc-0000-0000-0000-000000000001', 'calendar', 'Personal', true),
  ('cccccccc-0000-0000-0000-000000000002', 'tasks', 'My Tasks', true);

insert into public.planner_entries (id, kind, list_id, title, start_at, end_at, reminders)
values ('dddddddd-0000-0000-0000-000000000001', 'event', 'cccccccc-0000-0000-0000-000000000001', 'Dentist',
        '2026-12-01T10:00:00Z', '2026-12-01T11:00:00Z', '{10,60}');
insert into public.planner_entries (id, kind, list_id, title) values
  ('dddddddd-0000-0000-0000-000000000002', 'task', 'cccccccc-0000-0000-0000-000000000002', 'Buy milk');

select is((select version from public.planner_entries where id = 'dddddddd-0000-0000-0000-000000000001'), 1, 'new entry starts at version 1');
update public.planner_entries set title = 'Dentist (Dr. Rao)' where id = 'dddddddd-0000-0000-0000-000000000001';
select is((select version from public.planner_entries where id = 'dddddddd-0000-0000-0000-000000000001'), 2, 'edit bumps version');

select throws_ok($$ insert into public.planner_entries (kind, title) values ('event', 'No time') $$, '23514', null, 'an event needs a start');
select lives_ok($$ insert into public.planner_entries (kind, title, all_day, start_date, end_date) values ('event', 'Trip', true, '2026-12-20', '2026-12-24') $$, 'all-day event with dates');
select throws_ok($$ insert into public.planner_entries (kind, title, start_at, end_at) values ('event', 'Backwards', '2026-12-01T10:00:00Z', '2026-12-01T09:00:00Z') $$, '23514', null, 'end before start is refused');
select throws_ok($$ insert into public.planner_entries (kind, title, all_day, start_at) values ('task', 'Mixed', true, now()) $$, '23514', null, 'all-day entries cannot carry a time');
select throws_ok($$ insert into public.planner_entries (kind, title, reminders) values ('task', 'Too early', '{50000}') $$, '23514', null, 'reminders over 4 weeks are refused');
select throws_ok($$ insert into public.planner_lists (kind, name, is_default) values ('calendar', 'Second default', true) $$, '23505', null, 'one default calendar per user');

-- User B sees none of A's rows and cannot attach to A's list or entry.
select set_config('request.jwt.claims', '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}', true);
select is((select count(*)::int from public.planner_entries), 0, 'other user sees no entries');
select is((select count(*)::int from public.planner_lists), 0, 'other user sees no lists');
select throws_ok($$ insert into public.planner_entries (kind, title, list_id) values ('task', 'Sneaky', 'cccccccc-0000-0000-0000-000000000001') $$, '42501', null, 'cannot use another user''s list');
select throws_ok($$ insert into public.planner_entries (kind, title, parent_id) values ('task', 'Sneaky child', 'dddddddd-0000-0000-0000-000000000002') $$, '42501', null, 'cannot nest under another user''s task');

update public.planner_entries set title = 'hijack' where id = 'dddddddd-0000-0000-0000-000000000001';
select set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select is((select title from public.planner_entries where id = 'dddddddd-0000-0000-0000-000000000001'), 'Dentist (Dr. Rao)', 'other user cannot edit');

select * from finish();
rollback;
