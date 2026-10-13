-- Who spoke when, and what each turn did and cost. Additive: the Worker that
-- writes the earlier audit tables keeps working while this is applied.

-- When the thing happened by the Worker's clock. `created_at` is when its batch
-- reached the database, which is later now that writes trail the reply.
alter table public.gideon_interaction_events
  add column if not exists occurred_at timestamptz;

-- One row per assistant turn: the answer, its cost and where its time went.
create table public.gideon_turns (
  id uuid primary key,
  conversation_id uuid not null,
  owner_id text not null,
  client_turn_id text not null check (char_length(client_turn_id) between 1 and 200),
  channel text not null check (channel in ('http', 'websocket')),
  -- A guess at an unfinished sentence. `committed` says whether it was used.
  speculative boolean not null default false,
  committed boolean,
  source text check (source in ('voice', 'typed', 'card')),
  status text check (status in ('completed', 'failed', 'cancelled')),
  started_at timestamptz not null,
  finished_at timestamptz,
  duration_ms integer,
  user_text text,
  assistant_text text,
  model text,
  model_rounds integer not null default 0,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  cached_tokens integer not null default 0,
  total_tokens integer not null default 0,
  cost_usd numeric(12, 8) not null default 0,
  tool_calls integer not null default 0,
  searches integer not null default 0,
  pages_read integer not null default 0,
  cards integer not null default 0,
  cards_displayed integer not null default 0,
  spoken_segments integer not null default 0,
  first_token_ms integer,
  first_audio_ms integer,
  -- Milliseconds from the start of the turn to each named stage.
  timings jsonb not null default '{}'::jsonb,
  -- Each tool call: name, whether it worked, how long it took.
  tools jsonb not null default '[]'::jsonb,
  -- Each provider call: model, tokens, cost.
  usage jsonb not null default '[]'::jsonb,
  memory jsonb not null default '{}'::jsonb,
  -- The browser's own timeline of the turn, in epoch milliseconds.
  client jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, owner_id)
    references public.gideon_conversations(id, owner_id) on delete cascade
);

create index gideon_turns_conversation_time_idx
  on public.gideon_turns (conversation_id, started_at);
create index gideon_turns_owner_time_idx
  on public.gideon_turns (owner_id, started_at desc);
create index gideon_turns_client_idx
  on public.gideon_turns (conversation_id, client_turn_id);

-- One row per stretch of speech, by either side, with its recording.
create table public.gideon_speech_segments (
  id uuid primary key,
  conversation_id uuid not null,
  owner_id text not null,
  turn_id uuid,
  client_turn_id text,
  speaker text not null check (speaker in ('user', 'assistant')),
  seq integer,
  text text,
  start_char integer,
  end_char integer,
  -- The user's recording from its first sample to its last. For the
  -- assistant, when the browser began and finished playing the segment.
  started_at timestamptz,
  ended_at timestamptz,
  duration_ms integer,
  interrupted boolean not null default false,
  asset_id uuid references public.gideon_voice_assets(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, owner_id)
    references public.gideon_conversations(id, owner_id) on delete cascade
);

create index gideon_speech_segments_conversation_time_idx
  on public.gideon_speech_segments (conversation_id, (coalesce(started_at, created_at)));
create index gideon_speech_segments_turn_idx
  on public.gideon_speech_segments (turn_id) where turn_id is not null;
create index gideon_speech_segments_client_turn_idx
  on public.gideon_speech_segments (conversation_id, client_turn_id) where client_turn_id is not null;

-- The conversation as it was heard: who spoke, from when to when, saying what.
create view public.gideon_conversation_timeline
  with (security_invoker = true) as
select
  s.conversation_id,
  s.owner_id,
  coalesce(s.started_at, s.created_at) as at,
  s.ended_at,
  s.duration_ms,
  s.speaker,
  s.text,
  s.interrupted,
  s.turn_id,
  s.seq,
  s.id as segment_id,
  s.asset_id,
  a.mime_type,
  a.byte_length
from public.gideon_speech_segments s
left join public.gideon_voice_assets a on a.id = s.asset_id;

alter table public.gideon_turns enable row level security;
alter table public.gideon_speech_segments enable row level security;

-- As with the earlier audit tables: no user-facing API role reads or writes these.
revoke all on table public.gideon_turns, public.gideon_speech_segments, public.gideon_conversation_timeline from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on table public.gideon_turns, public.gideon_speech_segments, public.gideon_conversation_timeline from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table public.gideon_turns, public.gideon_speech_segments, public.gideon_conversation_timeline from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on table public.gideon_turns, public.gideon_speech_segments, public.gideon_conversation_timeline from service_role;
  end if;
end
$$;
