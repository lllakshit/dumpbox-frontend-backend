-- Account deletion is run by Supabase Auth under its own role, which has no rights on public tables. When the
-- cascade removes tag/collection/file links, the "touch parent item" trigger must still be able to run, so it now
-- runs with the owner's rights. It only moves updated_at on the parent item, and only when that item still exists.
create or replace function public.touch_parent_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid := coalesce(new.item_id, old.item_id);
begin
  update public.items set updated_at = clock_timestamp() where id = target;
  return coalesce(new, old);
end;
$$;
