-- Shelf: one-time database setup.
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.

create table if not exists public.books (
  user_id     uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id          text        not null,
  data        jsonb       not null default '{}'::jsonb,
  deleted     boolean     not null default false,
  updated_at  timestamptz not null,               -- when the book was edited (set by the device)
  modified_at timestamptz not null default now(), -- when the server received it (used for pulling changes)
  primary key (user_id, id)
);

create index if not exists books_user_modified on public.books (user_id, modified_at);

-- Each person can only see and change their own books.
alter table public.books enable row level security;

drop policy if exists "own books" on public.books;
create policy "own books" on public.books
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Stamp server time on every write, and never let an older edit overwrite a newer one.
create or replace function public.books_before_write()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null; -- incoming copy is older: keep what we have
  end if;
  new.modified_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists books_before_write on public.books;
create trigger books_before_write
  before insert or update on public.books
  for each row execute function public.books_before_write();
