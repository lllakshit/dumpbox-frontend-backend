-- Live updates for the Email section: web and phone hear when a conversation changes (new mail from the import,
-- pin, archive, opened, deleted) and refresh right away. Row-level security still decides who hears what.
alter publication supabase_realtime add table public.email_threads;
