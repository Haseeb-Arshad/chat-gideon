create table if not exists public.gideon_memories (
  session_id text primary key check (char_length(session_id) between 1 and 128),
  memories jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.gideon_memories enable row level security;

create or replace function public.gideon_memories_set_updated_at()
returns trigger
language plpgsql
security invoker
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists gideon_memories_updated_at on public.gideon_memories;
create trigger gideon_memories_updated_at
before update on public.gideon_memories
for each row execute function public.gideon_memories_set_updated_at();

revoke all on table public.gideon_memories from anon, authenticated;

