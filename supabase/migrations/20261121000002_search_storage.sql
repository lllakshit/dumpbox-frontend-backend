-- Keyword search (full text + typo tolerance) and the private storage bucket for item files.

-- ---------------------------------------------------------------------------
-- Search columns
-- ---------------------------------------------------------------------------
alter table public.items
  add column search_text text generated always as (
    left(
      coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || coalesce(url, '') || ' ' ||
      coalesce(link_title, '') || ' ' || coalesce(link_description, '') || ' ' || coalesce(link_site, '') || ' ' ||
      coalesce(location_label, ''),
      20000
    )
  ) stored,
  add column search_doc tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(link_title, '')), 'A') ||
    setweight(to_tsvector('simple', left(coalesce(body, ''), 100000)), 'B') ||
    setweight(to_tsvector('simple',
      coalesce(link_description, '') || ' ' || coalesce(link_site, '') || ' ' || coalesce(location_label, '') || ' ' ||
      regexp_replace(coalesce(url, ''), '[/:._?=&#-]+', ' ', 'g')), 'C')
  ) stored;

create index items_search_doc_idx on public.items using gin (search_doc);
create index items_search_trgm_idx on public.items using gin (search_text extensions.gin_trgm_ops);
create index tags_name_trgm_idx on public.tags using gin (name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- search_items: runs as the caller, so row-level security still applies.
-- Matches full-text words (prefix aware), close spellings, tag names and file names.
-- ---------------------------------------------------------------------------
create or replace function public.search_items(
  p_query text,
  p_types text[] default null,
  p_tag_ids uuid[] default null,
  p_collection_id uuid default null,
  p_starred boolean default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_include_archived boolean default true,
  p_limit integer default 30,
  p_offset integer default 0
)
returns table (item_id uuid, rank real, headline text)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select
      btrim(coalesce(p_query, '')) as raw,
      case
        when btrim(coalesce(p_query, '')) = '' then null
        else to_tsquery('simple',
          array_to_string(
            array(
              select quote_literal(w) || ':*'
              from regexp_split_to_table(lower(btrim(p_query)), '[^[:alnum:]]+') as w
              where w <> ''
            ),
            ' & '
          )
        )
      end as tsq
  ),
  candidates as (
    select i.*,
      case when q.tsq is null then 0 else ts_rank_cd(i.search_doc, q.tsq) end as fts_rank,
      case when q.raw = '' then 0 else extensions.word_similarity(lower(q.raw), lower(i.search_text)) end as fuzzy
    from public.items i, q
    where i.deleted_at is null
      and (p_include_archived or i.archived_at is null)
      and (p_types is null or i.type = any (p_types))
      and (p_starred is null or i.starred = p_starred)
      and (p_from is null or i.created_at >= p_from)
      and (p_to is null or i.created_at < p_to)
      and (p_collection_id is null or exists (
        select 1 from public.item_collections ic where ic.item_id = i.id and ic.collection_id = p_collection_id))
      and (p_tag_ids is null or not exists (
        select 1 from unnest(p_tag_ids) as t(id)
        where not exists (select 1 from public.item_tags it where it.item_id = i.id and it.tag_id = t.id)))
      and (
        q.raw = ''
        or (q.tsq is not null and i.search_doc @@ q.tsq)
        or (char_length(q.raw) >= 3 and lower(q.raw) operator(extensions.<%) lower(i.search_text))
        or exists (
          select 1 from public.item_tags it join public.tags t on t.id = it.tag_id
          where it.item_id = i.id and (lower(t.name) like lower(q.raw) || '%'
            or (char_length(q.raw) >= 3 and extensions.similarity(lower(t.name), lower(q.raw)) > 0.4)))
        or exists (
          select 1 from public.files f
          where f.item_id = i.id and (f.file_name ilike '%' || replace(replace(replace(q.raw, '\', '\\'), '%', '\%'), '_', '\_') || '%'
            or (char_length(q.raw) >= 3 and extensions.word_similarity(lower(q.raw), lower(f.file_name)) > 0.5)))
      )
  )
  select
    c.id as item_id,
    (c.fts_rank * 2 + c.fuzzy)::real as rank,
    case
      when (select tsq from q) is null then left(coalesce(c.title, c.body, c.link_title, c.url, c.location_label, ''), 200)
      else ts_headline('simple',
        coalesce(nullif(c.body, ''), c.title, c.link_title, c.link_description, c.url, c.location_label, ''),
        (select tsq from q),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=8, MaxFragments=2, FragmentDelimiter=" … "')
    end as headline
  from candidates c
  order by (case when (select raw from q) = '' then 0 else c.fts_rank * 2 + c.fuzzy end) desc, c.created_at desc, c.id desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.search_items from public, anon;
grant execute on function public.search_items to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket, one folder per user ("<user_id>/<item_id>/<file>")
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('items', 'items', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create policy "items bucket: owner read" on storage.objects for select to authenticated
  using (bucket_id = 'items' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "items bucket: owner insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'items' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "items bucket: owner update" on storage.objects for update to authenticated
  using (bucket_id = 'items' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "items bucket: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'items' and (storage.foldername(name))[1] = (select auth.uid())::text);
