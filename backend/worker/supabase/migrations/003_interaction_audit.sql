-- Private conversation and agent evidence. Audio remains in PostgreSQL bytea
-- so a transcription request and generated voice can be inspected together.
create table public.gideon_conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id text not null check (char_length(owner_id) between 1 and 160),
  client_session_hash text not null check (client_session_hash ~ '^[0-9a-f]{64}$'),
  channel text not null check (channel in ('http', 'websocket')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, client_session_hash),
  unique (id, owner_id)
);

create table public.gideon_interaction_events (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.gideon_conversations(id) on delete cascade,
  owner_id text not null,
  turn_id uuid not null,
  sequence integer not null check (sequence > 0),
  event_type text not null check (char_length(event_type) between 1 and 80),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (turn_id, sequence),
  foreign key (conversation_id, owner_id)
    references public.gideon_conversations(id, owner_id) on delete cascade
);

create index gideon_interaction_events_owner_time_idx
  on public.gideon_interaction_events (owner_id, created_at desc);
create index gideon_interaction_events_conversation_time_idx
  on public.gideon_interaction_events (conversation_id, created_at, id);
create index gideon_interaction_events_turn_idx
  on public.gideon_interaction_events (turn_id, sequence);

create table public.gideon_voice_assets (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.gideon_conversations(id) on delete cascade,
  owner_id text not null,
  turn_id uuid,
  source text not null check (source in ('user', 'assistant')),
  mime_type text not null check (char_length(mime_type) between 1 and 120),
  byte_length integer not null check (byte_length between 1 and 33554432),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  transcript text,
  transcription_model text,
  audio bytea not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, owner_id)
    references public.gideon_conversations(id, owner_id) on delete cascade
);

create index gideon_voice_assets_owner_time_idx
  on public.gideon_voice_assets (owner_id, created_at desc);
create index gideon_voice_assets_turn_idx
  on public.gideon_voice_assets (turn_id) where turn_id is not null;

alter table public.gideon_conversations enable row level security;
alter table public.gideon_interaction_events enable row level security;
alter table public.gideon_voice_assets enable row level security;

-- No user-facing API role can read or write raw transcripts, tool traces or audio.
revoke all on table public.gideon_conversations, public.gideon_interaction_events, public.gideon_voice_assets from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.gideon_conversations, public.gideon_interaction_events, public.gideon_voice_assets from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.gideon_conversations, public.gideon_interaction_events, public.gideon_voice_assets from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.gideon_conversations, public.gideon_interaction_events, public.gideon_voice_assets from service_role;
  end if;
end
$$;
