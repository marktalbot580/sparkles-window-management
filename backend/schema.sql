-- Sparkles Window Management – database setup.
-- Paste into Supabase > SQL Editor > Run. Safe to run again.

-- One row per customer / job / invoice / settings document. Each row belongs to one user, so every
-- business only ever sees its own data (row level security below).
create table if not exists public.docs (
  user_id   uuid not null references auth.users(id) on delete cascade,
  kind      text not null check (kind in ('customer','job','invoice','settings')),
  id        text not null,
  data      jsonb not null default '{}'::jsonb,
  updated   bigint not null default 0,            -- client timestamp (ms) used to decide which edit is newer
  deleted   boolean not null default false,
  server_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);
create index if not exists docs_server_at on public.docs (user_id, server_at);

-- stamp every write with the server time, so phones can ask "what changed since I last looked?"
create or replace function public.docs_touch() returns trigger language plpgsql as $$
begin new.server_at := now(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs for each row execute function public.docs_touch();

alter table public.docs enable row level security;
drop policy if exists docs_read   on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
create policy docs_read   on public.docs for select using (user_id = auth.uid());
create policy docs_insert on public.docs for insert with check (user_id = auth.uid());
create policy docs_update on public.docs for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- no delete policy: the app marks rows deleted instead, so deletions sync to every phone

-- newer Supabase projects do not grant table access to the API roles automatically
grant usage on schema public to authenticated;
grant select, insert, update on public.docs to authenticated;
