-- Database tests: run with `supabase test db`.
begin;
create extension if not exists pgtap with schema extensions;
select plan(25);

-- Two users
insert into auth.users (id, email, aud, role) values
  ('11111111-1111-1111-1111-111111111111', 'a@test.dev', 'authenticated', 'authenticated'),
  ('22222222-2222-2222-2222-222222222222', 'b@test.dev', 'authenticated', 'authenticated');

-- Act as user A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

insert into public.items (id, type, body) values ('aaaaaaaa-0000-0000-0000-000000000001', 'note', 'October electricity bill paid 1450');
insert into public.items (id, type, url, link_title) values ('aaaaaaaa-0000-0000-0000-000000000002', 'link', 'https://example.com/hostel', 'Hostel invoice portal');
insert into public.items (id, type, latitude, longitude, location_label) values ('aaaaaaaa-0000-0000-0000-000000000003', 'location', 26.9124, 75.7873, 'Jaipur office');
insert into public.tags (id, name) values ('aaaaaaaa-1111-0000-0000-000000000001', 'Bills');
insert into public.item_tags (item_id, tag_id) values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-1111-0000-0000-000000000001');

select is((select user_id::text from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  '11111111-1111-1111-1111-111111111111', 'user_id defaults to the caller');
select is((select version from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000001'), 2,
  'adding a tag bumps the item version so other devices sync it');

-- Editing a note keeps the previous text as a version
update public.items set body = 'October electricity bill paid 1500' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select is((select count(*)::int from public.item_versions where item_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 1,
  'previous body saved as a version');
select is((select body from public.item_versions where item_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'October electricity bill paid 1450', 'saved version has the old text');

-- Only the last 10 versions are kept
do $$ begin
  for i in 1..12 loop
    update public.items set body = 'edit ' || i where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  end loop;
end $$;
select is((select count(*)::int from public.item_versions where item_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 10,
  'version history capped at 10');
update public.items set body = 'October electricity bill paid 1500' where id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- Search
select ok(exists(select 1 from public.search_items('electricity') where item_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'full-text search finds a note');
select ok(exists(select 1 from public.search_items('electrcity') where item_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'typo-tolerant search finds a note');
select ok(exists(select 1 from public.search_items('octber') where item_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'one-letter typo still matches');
select ok(exists(select 1 from public.search_items('electr') where item_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'prefix search finds a note');
select ok(exists(select 1 from public.search_items('bills') where item_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'search matches tag names');
select ok(exists(select 1 from public.search_items('hostel') where item_id = 'aaaaaaaa-0000-0000-0000-000000000002'),
  'search matches link title and url');
select ok(exists(select 1 from public.search_items('jaipur', p_types => array['location']) where item_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  'search with type filter finds a place');
select is((select count(*)::int from public.search_items('jaipur', p_types => array['note'])), 0,
  'type filter excludes other types');
select ok((select headline from public.search_items('electricity') limit 1) like '%<mark>%',
  'search returns a highlighted snippet');
select is((select count(*)::int from public.search_items('', p_tag_ids => array['aaaaaaaa-1111-0000-0000-000000000001'::uuid])), 1,
  'tag filter without text');

-- Soft delete hides from search, hard delete leaves a tombstone
update public.items set deleted_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select is((select count(*)::int from public.search_items('jaipur')), 0, 'trashed item is not searchable');
delete from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select ok(exists(select 1 from public.item_tombstones where item_id = 'aaaaaaaa-0000-0000-0000-000000000003'),
  'permanent delete records a tombstone');

-- Type cannot change
select throws_ok($$ update public.items set type = 'link' where id = 'aaaaaaaa-0000-0000-0000-000000000001' $$,
  '22023', null, 'item type cannot change');

-- Act as user B
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select is((select count(*)::int from public.items), 0, 'user B sees none of user A''s items');
select is((select count(*)::int from public.search_items('electricity')), 0, 'user B cannot search user A''s items');
select is((select count(*)::int from public.tags), 0, 'user B sees none of user A''s tags');
select is((select count(*)::int from public.item_tombstones), 0, 'user B sees none of user A''s tombstones');

update public.items set body = 'hacked' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select throws_ok($$ insert into public.item_tags (item_id, tag_id, user_id)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-1111-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222') $$,
  '42501', null, 'user B cannot tag user A''s item');
select throws_ok($$ insert into public.items (type, body, user_id) values ('note', 'x', '11111111-1111-1111-1111-111111111111') $$,
  '42501', null, 'user B cannot write an item as user A');

-- Back as user A: B's update had no effect
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select body from public.items where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'October electricity bill paid 1500', 'user B could not change user A''s item');

select * from finish();
rollback;
